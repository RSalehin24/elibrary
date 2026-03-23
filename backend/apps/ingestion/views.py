import logging
from urllib.parse import quote

from django.conf import settings
from django.db.models import Case, IntegerField, Q, Value, When
from django.db.models.functions import Coalesce
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils.dateparse import parse_date, parse_datetime
from rest_framework import generics, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.models import PermissionScope
from apps.catalog.models import GeneratedAssetStatus, GeneratedAssetType
from apps.common.permissions import CanManageProcessing, user_has_scope
from apps.common.url_utils import public_api_url
from apps.common.throttles import SubmissionRateThrottle
from apps.ingestion.models import (
    BookSubmission,
    CatalogAutomationSettings,
    CatalogCurationRun,
    CatalogCurationTrigger,
    DuplicateReview,
    DuplicateReviewStatus,
    JobStatus,
    MatchCandidate,
    ProcessingJob,
    ResolutionStatus,
    SourceCatalogEntry,
    SubmissionOrigin,
    SubmissionStatus,
)
from apps.ingestion.serializers import (
    BulkIdsSerializer,
    CatalogAutomationSettingsSerializer,
    CatalogAutomationSettingsUpdateSerializer,
    CatalogCurationRunCreateSerializer,
    CatalogCurationRunSerializer,
    DuplicateReviewDecisionSerializer,
    DuplicateReviewSerializer,
    ProcessingJobSerializer,
    SourceCatalogRefreshStateSerializer,
    SourceCatalogEntrySnapshotSerializer,
    SubmissionBatchCreateSerializer,
    SubmissionSerializer,
)
from apps.ingestion.services.curation import (
    ACTIVE_RUN_STATUSES,
    ACTIVE_SOURCE_CATALOG_REFRESH_STATUSES,
    begin_source_catalog_refresh,
    cancel_source_catalog_refresh,
    cancel_catalog_curation_run,
    create_catalog_curation_run,
    get_catalog_automation_settings,
    get_source_catalog_refresh_state,
    inspect_source_catalog_entry,
    source_catalog_book_source_map,
    source_catalog_submission_map,
    source_catalog_entry_snapshots,
    summarize_source_catalog_snapshots,
)
from apps.ingestion.services.submissions import (
    cancel_processing_job,
    create_submission_records,
    ensure_preview_session,
    find_existing_book_by_source_url,
    fulfill_submission_with_existing_book,
    queue_submission,
    recover_stale_processing_jobs,
    resume_processing_job,
    sync_deduplicated_submissions,
)

logger = logging.getLogger(__name__)
CATALOG_ORIGIN_VALUES = (SubmissionOrigin.CURATION, SubmissionOrigin.AUTOMATION)


def apply_submission_origin_filter(queryset, origin, *, field_name="origin"):
    origin = (origin or "").strip()
    if not origin:
        return queryset
    if origin == "catalog":
        return queryset.filter(**{f"{field_name}__in": CATALOG_ORIGIN_VALUES})
    return queryset.filter(**{field_name: origin})


def active_automation_run():
    return (
        CatalogCurationRun.objects.filter(trigger=CatalogCurationTrigger.SCHEDULED, status__in=ACTIVE_RUN_STATUSES)
        .order_by("-created_at")
        .first()
    )


def automation_manual_creation_locked_response():
    if not active_automation_run():
        return None
    return Response(
        {
            "detail": (
                "Automation is currently syncing the catalog and creating books. "
                "Manual book creation is temporarily disabled until it finishes."
            )
        },
        status=status.HTTP_409_CONFLICT,
    )


def source_catalog_sync_locked_response():
    sync_state = get_source_catalog_refresh_state()
    if sync_state.status not in ACTIVE_SOURCE_CATALOG_REFRESH_STATUSES:
        return None
    return Response(
        {
            "detail": "Catalog sync is currently running. Manual catalog actions are disabled until it finishes."
        },
        status=status.HTTP_409_CONFLICT,
    )


def submission_base_queryset():
    return BookSubmission.objects.select_related(
        "linked_book",
        "duplicate_of_book",
        "submitter",
        "canonical_submission",
        "canonical_submission__linked_book",
    ).prefetch_related(
        "resolution_attempts__match_candidates",
        "processing_jobs",
        "canonical_submission__resolution_attempts__match_candidates",
        "canonical_submission__processing_jobs",
    )


def apply_created_at_filters(queryset, request):
    created_after = request.query_params.get("created_after", "").strip()
    created_before = request.query_params.get("created_before", "").strip()

    if created_after:
        parsed_after = parse_datetime(created_after) or parse_date(created_after)
        if parsed_after:
            queryset = queryset.filter(created_at__gte=parsed_after)

    if created_before:
        parsed_before = parse_datetime(created_before) or parse_date(created_before)
        if parsed_before:
            queryset = queryset.filter(created_at__lte=parsed_before)

    return queryset


def apply_limit(queryset, request, *, default_limit=80, max_limit=200):
    limit = request.query_params.get("limit", "").strip()
    try:
        limit_value = max(1, min(int(limit), max_limit)) if limit else default_limit
    except (TypeError, ValueError):
        limit_value = default_limit
    if limit_value:
        return queryset[:limit_value]
    return queryset


def status_order_expression(field_name, ordered_values):
    return Case(
        *[When(**{field_name: value}, then=Value(index)) for index, value in enumerate(ordered_values)],
        default=Value(len(ordered_values)),
        output_field=IntegerField(),
    )


def catalog_snapshot_timestamp(snapshot, *field_names):
    for field_name in field_names:
        value = snapshot.get(field_name)
        if value:
            return value.timestamp()
    return 0


def sort_source_catalog_snapshots(snapshots, sort_key):
    status_order = {
        "processing": 0,
        "failed": 1,
        "unfinished": 2,
        "new": 3,
        "ready": 4,
        "deleted": 5,
    }

    if sort_key == "created_desc":
        snapshots.sort(key=lambda snapshot: (-catalog_snapshot_timestamp(snapshot, "created_at"), snapshot["title"].lower()))
        return

    if sort_key == "created_asc":
        snapshots.sort(key=lambda snapshot: (catalog_snapshot_timestamp(snapshot, "created_at"), snapshot["title"].lower()))
        return

    if sort_key == "activity_desc":
        snapshots.sort(
            key=lambda snapshot: (
                -catalog_snapshot_timestamp(snapshot, "activity_at", "updated_at", "last_seen_at"),
                snapshot["title"].lower(),
            )
        )
        return

    if sort_key == "activity_asc":
        snapshots.sort(
            key=lambda snapshot: (
                catalog_snapshot_timestamp(snapshot, "activity_at", "updated_at", "last_seen_at"),
                snapshot["title"].lower(),
            )
        )
        return

    if sort_key == "title_asc":
        snapshots.sort(key=lambda snapshot: snapshot["title"].lower())
        return

    if sort_key == "title_desc":
        snapshots.sort(key=lambda snapshot: snapshot["title"].lower(), reverse=True)
        return

    snapshots.sort(
        key=lambda snapshot: (
            status_order.get(snapshot["curation_status"], 99),
            -catalog_snapshot_timestamp(snapshot, "activity_at", "updated_at", "last_seen_at"),
            snapshot["title"].lower(),
        )
    )


def submissions_ordered_queryset(queryset):
    return queryset.order_by(
        status_order_expression(
            "status",
            [
                SubmissionStatus.PROCESSING,
                SubmissionStatus.PENDING_RESOLUTION,
                SubmissionStatus.QUEUED,
                SubmissionStatus.NEEDS_REVIEW,
                SubmissionStatus.FAILED,
                SubmissionStatus.DUPLICATE,
                SubmissionStatus.CANCELLED,
                SubmissionStatus.READY,
                SubmissionStatus.DRAFT,
            ],
        ),
        "-updated_at",
        "-created_at",
    )


def jobs_ordered_queryset(queryset):
    return queryset.annotate(
        activity_at=Coalesce("finished_at", "started_at", "updated_at", "created_at"),
    ).order_by(
        status_order_expression(
            "status",
            [
                JobStatus.PROCESSING,
                JobStatus.QUEUED,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
                JobStatus.SUCCEEDED,
            ],
        ),
        "-activity_at",
        "-created_at",
    )


def runs_ordered_queryset(queryset):
    return queryset.annotate(
        activity_at=Coalesce("finished_at", "started_at", "updated_at", "created_at"),
    ).order_by(
        status_order_expression(
            "status",
            [
                JobStatus.PROCESSING,
                JobStatus.QUEUED,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
                JobStatus.SUCCEEDED,
            ],
        ),
        "-activity_at",
        "-created_at",
    )


def duplicate_reviews_ordered_queryset(queryset):
    return queryset.order_by(
        status_order_expression(
            "status",
            [
                DuplicateReviewStatus.PENDING,
                DuplicateReviewStatus.CONFIRMED,
                DuplicateReviewStatus.DISMISSED,
                DuplicateReviewStatus.MERGED,
            ],
        ),
        "-updated_at",
        "-created_at",
    )


def visible_submissions_queryset(user):
    queryset = submission_base_queryset()
    if user.is_staff or user_has_scope(user, [PermissionScope.PROCESSING_MANAGE]):
        return queryset
    return queryset.filter(submitter=user)


def visible_jobs_queryset(user):
    queryset = ProcessingJob.objects.select_related("submission", "submission__linked_book", "book")
    if user.is_staff or user_has_scope(user, [PermissionScope.PROCESSING_MANAGE]):
        return queryset
    return queryset.filter(submission__submitter=user)


def can_manage_processing_records(user):
    return bool(user.is_staff or user_has_scope(user, [PermissionScope.PROCESSING_MANAGE]))


def has_active_root_jobs(submission):
    target_submission = submission.canonical_submission or submission
    if target_submission.pk != submission.pk:
        return False
    return target_submission.processing_jobs.filter(status__in=[JobStatus.QUEUED, JobStatus.PROCESSING]).exists()


def is_public_submission(submission):
    return submission.submitter_id is None and bool(submission.raw_payload.get("submitted_publicly"))


def get_accessible_submission(request, pk):
    submission = get_object_or_404(submission_base_queryset(), pk=pk)
    user = request.user
    if getattr(user, "is_authenticated", False):
        if user.is_staff or user_has_scope(user, [PermissionScope.PROCESSING_MANAGE]):
            return submission
        if submission.submitter_id == user.id:
            return submission

    if is_public_submission(submission):
        return submission

    raise PermissionDenied("You do not have access to this submission.")


class SubmissionListCreateView(APIView):
    def get_permissions(self):
        if self.request.method == "POST":
            return [AllowAny()]
        return [IsAuthenticated()]

    def get_throttles(self):
        if self.request.method == "POST":
            return [SubmissionRateThrottle()]
        return []

    def get(self, request):
        queryset = visible_submissions_queryset(request.user)
        origin = request.query_params.get("origin", "").strip()
        queryset = apply_submission_origin_filter(queryset, origin, field_name="origin")
        status_filter = request.query_params.get("status")
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        review_state = request.query_params.get("review_state", "").strip()
        if review_state:
            queryset = queryset.filter(review_state=review_state)
        resolution_status = request.query_params.get("resolution_status", "").strip()
        if resolution_status:
            queryset = queryset.filter(resolution_status=resolution_status)
        input_type = request.query_params.get("input_type", "").strip()
        if input_type:
            queryset = queryset.filter(input_type=input_type)
        query = request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(
                Q(original_input__icontains=query)
                | Q(resolved_url__icontains=query)
            )
        linked_book_slug = request.query_params.get("linked_book_slug", "").strip()
        if linked_book_slug:
            queryset = queryset.filter(linked_book__slug=linked_book_slug)
        queryset = apply_created_at_filters(queryset, request)
        queryset = submissions_ordered_queryset(queryset)
        queryset = apply_limit(queryset, request)
        serializer = SubmissionSerializer(queryset, many=True, context={"request": request})
        return Response(serializer.data)

    def post(self, request):
        serializer = SubmissionBatchCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        submissions = create_submission_records(
            submitter=request.user if request.user.is_authenticated else None,
            parsed_entries=serializer.validated_data["parsed_entries"],
            auto_process=serializer.validated_data["auto_process"],
            origin=SubmissionOrigin.USER,
        )
        return Response(
            SubmissionSerializer(submissions, many=True, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class SubmissionDetailView(generics.RetrieveDestroyAPIView):
    permission_classes = [AllowAny]
    serializer_class = SubmissionSerializer
    lookup_field = "pk"

    def get_permissions(self):
        if self.request.method == "DELETE":
            return [IsAuthenticated()]
        return [AllowAny()]

    def get_object(self):
        return get_accessible_submission(self.request, self.kwargs["pk"])

    def destroy(self, request, *args, **kwargs):
        submission = visible_submissions_queryset(request.user).filter(pk=kwargs["pk"]).first()
        if submission is None:
            raise PermissionDenied("You cannot delete this request.")
        if has_active_root_jobs(submission):
            return Response(
                {"detail": "Stop processing before deleting this request."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        submission.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class SubmissionConfirmCandidateView(APIView):
    permission_classes = [AllowAny]

    def post(self, request, pk):
        submission = get_accessible_submission(request, pk)
        target_submission = submission.canonical_submission or submission
        candidate_id = request.data.get("candidate_id")
        if not candidate_id:
            return Response({"detail": "candidate_id is required."}, status=status.HTTP_400_BAD_REQUEST)

        candidate = get_object_or_404(
            MatchCandidate.objects.select_related("resolution_attempt__submission"),
            pk=candidate_id,
        )
        if candidate.resolution_attempt.submission_id != target_submission.id:
            raise PermissionDenied("This candidate does not belong to the specified submission.")

        MatchCandidate.objects.filter(resolution_attempt=candidate.resolution_attempt).update(is_selected=False)
        candidate.is_selected = True
        candidate.save(update_fields=["is_selected", "updated_at"])

        target_submission.resolved_url = candidate.candidate_url
        target_submission.resolution_status = ResolutionStatus.RESOLVED
        target_submission.resolution_confidence = candidate.confidence
        target_submission.status = SubmissionStatus.QUEUED
        target_submission.error_message = ""
        target_submission.save()
        sync_deduplicated_submissions(target_submission)

        existing_book = find_existing_book_by_source_url(candidate.candidate_url)
        if existing_book:
            fulfill_submission_with_existing_book(
                target_submission,
                existing_book,
                source="confirmed_candidate_source_url",
                confidence=candidate.confidence,
                resolved_url=candidate.candidate_url,
            )
            return Response(SubmissionSerializer(submission, context={"request": request}).data)

        locked_response = automation_manual_creation_locked_response()
        if locked_response:
            return locked_response
        queue_submission(target_submission, actor=request.user if request.user.is_authenticated else None)
        return Response(SubmissionSerializer(submission, context={"request": request}).data)


class SubmissionActionLinksView(APIView):
    permission_classes = [AllowAny]

    def post(self, request, pk):
        submission = get_accessible_submission(request, pk)
        if submission.status != SubmissionStatus.READY or not submission.linked_book_id:
            return Response({"detail": "This submission is not ready yet."}, status=status.HTTP_400_BAD_REQUEST)

        preview_session = ensure_preview_session(
            request.user if request.user.is_authenticated else None,
            submission.linked_book,
            submission=submission,
            allow_guest=not request.user.is_authenticated,
        )
        if preview_session is None:
            return Response({"detail": "Could not prepare access for this book."}, status=status.HTTP_400_BAD_REQUEST)

        assets = submission.linked_book.generated_assets
        has_epub = assets.filter(asset_type=GeneratedAssetType.EPUB, status=GeneratedAssetStatus.READY).exists()
        has_html = assets.filter(asset_type=GeneratedAssetType.HTML, status=GeneratedAssetStatus.READY).exists()
        manifest_url = public_api_url("access-reader-manifest", kwargs={"token": preview_session.token}, request=request)
        launch_url = f"{settings.EPUB_READER_BASE_URL.rstrip('/')}/?manifest={quote(manifest_url, safe='')}"

        return Response(
            {
                "book": {
                    "title": submission.linked_book.title,
                    "slug": submission.linked_book.slug,
                },
                "launch_url": launch_url,
                "manifest_url": manifest_url,
                "epub_download_url": public_api_url(
                    "access-reader-epub",
                    kwargs={"token": preview_session.token},
                    request=request,
                )
                if has_epub
                else "",
                "html_preview_url": public_api_url(
                    "access-reader-html",
                    kwargs={"token": preview_session.token},
                    request=request,
                )
                if has_html
                else "",
                "expires_at": preview_session.expires_at,
            }
        )


class ProcessingJobListView(generics.ListAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = ProcessingJobSerializer

    def get_queryset(self):
        queryset = visible_jobs_queryset(self.request.user)
        origin = self.request.query_params.get("origin", "").strip()
        queryset = apply_submission_origin_filter(queryset, origin, field_name="submission__origin")
        status_filter = self.request.query_params.get("status", "").strip()
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        submission_status = self.request.query_params.get("submission_status", "").strip()
        if submission_status:
            queryset = queryset.filter(submission__status=submission_status)
        job_type = self.request.query_params.get("job_type", "").strip()
        if job_type:
            queryset = queryset.filter(job_type=job_type)
        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(
                Q(submission__original_input__icontains=query)
                | Q(last_error__icontains=query)
                | Q(book__title__icontains=query)
            )
        queryset = apply_created_at_filters(queryset, self.request)
        queryset = jobs_ordered_queryset(queryset)
        return apply_limit(queryset, self.request)


class ProcessingJobStopView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        job = get_object_or_404(ProcessingJob.objects.select_related("submission"), pk=pk)
        can_manage_processing = user_has_scope(request.user, [PermissionScope.PROCESSING_MANAGE])
        if not request.user.is_staff and not can_manage_processing and job.submission.submitter_id != request.user.id:
            raise PermissionDenied("You cannot stop this job.")
        job = cancel_processing_job(job)
        return Response(ProcessingJobSerializer(job).data)


class ProcessingJobResumeView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        job = get_object_or_404(ProcessingJob.objects.select_related("submission"), pk=pk)
        can_manage_processing = user_has_scope(request.user, [PermissionScope.PROCESSING_MANAGE])
        if not request.user.is_staff and not can_manage_processing and job.submission.submitter_id != request.user.id:
            raise PermissionDenied("You cannot resume this job.")
        locked_response = automation_manual_creation_locked_response()
        if locked_response:
            return locked_response
        try:
            job = resume_processing_job(job)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(ProcessingJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


class ProcessingJobDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, pk):
        job = get_object_or_404(visible_jobs_queryset(request.user), pk=pk)
        if job.status in {JobStatus.QUEUED, JobStatus.PROCESSING}:
            return Response(
                {"detail": "Stop this job before deleting it."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        job.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProcessingJobRecoverView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        origin = request.data.get("origin") or request.query_params.get("origin") or ""
        try:
            limit = int(request.data.get("limit") or request.query_params.get("limit") or 50)
        except (TypeError, ValueError):
            return Response({"detail": "limit must be a whole number."}, status=status.HTTP_400_BAD_REQUEST)
        recovered = recover_stale_processing_jobs(origin=origin, limit=max(1, min(limit, 100)))
        return Response({"recovered_jobs": recovered}, status=status.HTTP_202_ACCEPTED)


class SubmissionBulkDeleteView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        requested_ids = serializer.validated_data["ids"]
        submissions = list(visible_submissions_queryset(request.user).filter(pk__in=requested_ids))

        deleted_count = 0
        skipped_active = 0
        skipped_missing = len(requested_ids) - len(submissions)

        for submission in submissions:
            if has_active_root_jobs(submission):
                skipped_active += 1
                continue
            submission.delete()
            deleted_count += 1

        return Response(
            {
                "deleted_count": deleted_count,
                "skipped_active": skipped_active,
                "skipped_missing": skipped_missing,
            }
        )


class ProcessingJobBulkStopView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        jobs = list(visible_jobs_queryset(request.user).filter(pk__in=serializer.validated_data["ids"]))

        stopped_count = 0
        skipped_complete = 0
        for job in jobs:
            previous_status = job.status
            job = cancel_processing_job(job)
            if previous_status == job.status and job.status in {JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED}:
                skipped_complete += 1
                continue
            stopped_count += 1

        return Response(
            {
                "stopped_count": stopped_count,
                "skipped_complete": skipped_complete,
                "skipped_missing": max(len(serializer.validated_data["ids"]) - len(jobs), 0),
            }
        )


class ProcessingJobBulkResumeView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        jobs = list(visible_jobs_queryset(request.user).filter(pk__in=serializer.validated_data["ids"]))
        locked_response = automation_manual_creation_locked_response()
        if locked_response:
            return locked_response

        resumed_count = 0
        skipped_invalid = 0
        for job in jobs:
            try:
                resume_processing_job(job)
            except ValueError:
                skipped_invalid += 1
                continue
            resumed_count += 1

        return Response(
            {
                "resumed_count": resumed_count,
                "skipped_invalid": skipped_invalid,
                "skipped_missing": max(len(serializer.validated_data["ids"]) - len(jobs), 0),
            },
            status=status.HTTP_202_ACCEPTED,
        )


class ProcessingJobBulkDeleteView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        jobs = list(visible_jobs_queryset(request.user).filter(pk__in=serializer.validated_data["ids"]))

        deleted_count = 0
        skipped_active = 0
        for job in jobs:
            if job.status in {JobStatus.QUEUED, JobStatus.PROCESSING}:
                skipped_active += 1
                continue
            job.delete()
            deleted_count += 1

        return Response(
            {
                "deleted_count": deleted_count,
                "skipped_active": skipped_active,
                "skipped_missing": max(len(serializer.validated_data["ids"]) - len(jobs), 0),
            }
        )


class SubmissionRetryView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        submission = visible_submissions_queryset(request.user).get(pk=pk)
        target_submission = submission.canonical_submission or submission
        can_manage_processing = user_has_scope(request.user, [PermissionScope.PROCESSING_MANAGE])
        if not request.user.is_staff and not can_manage_processing and submission.submitter_id != request.user.id:
            raise PermissionDenied("You cannot retry this submission.")
        if not target_submission.resolved_url and target_submission.input_type != "title":
            return Response({"detail": "This submission does not have a resolved URL yet."}, status=status.HTTP_400_BAD_REQUEST)
        locked_response = automation_manual_creation_locked_response()
        if locked_response:
            return locked_response

        job = queue_submission(target_submission, actor=request.user)
        return Response(ProcessingJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


class DuplicateReviewListView(generics.ListAPIView):
    permission_classes = [CanManageProcessing]
    serializer_class = DuplicateReviewSerializer

    def get_queryset(self):
        queryset = DuplicateReview.objects.select_related("submission__linked_book", "existing_book").prefetch_related(
            "submission__resolution_attempts__match_candidates",
            "existing_book__book_contributors__contributor",
            "existing_book__book_series__series",
            "existing_book__book_categories__category",
            "existing_book__generated_assets",
        )
        origin = self.request.query_params.get("origin", "").strip()
        queryset = apply_submission_origin_filter(queryset, origin, field_name="submission__origin")
        status_filter = self.request.query_params.get("status", "").strip()
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(
                Q(submission__original_input__icontains=query)
                | Q(existing_book__title__icontains=query)
                | Q(notes__icontains=query)
            )
        queryset = duplicate_reviews_ordered_queryset(queryset)
        return apply_limit(queryset, self.request, default_limit=40)


class DuplicateReviewResolveView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request, pk):
        review = DuplicateReview.objects.select_related("submission", "existing_book").get(pk=pk)
        serializer = DuplicateReviewDecisionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        decision = serializer.validated_data["decision"]
        review.notes = serializer.validated_data.get("notes", "")

        if decision == "confirm_existing":
            fulfill_submission_with_existing_book(
                review.submission,
                review.existing_book,
                source="duplicate_review_confirmed",
                confidence=max(review.submission.resolution_confidence, 0.95),
                resolved_url=review.submission.resolved_url,
            )
            review.submission.duplicate_of_book = review.existing_book
            review.submission.save(update_fields=["duplicate_of_book", "updated_at"])
            review.status = DuplicateReviewStatus.CONFIRMED
        else:
            review.submission.status = SubmissionStatus.NEEDS_REVIEW
            review.submission.review_state = "needs_review"
            review.submission.save(update_fields=["status", "review_state", "updated_at"])
            review.status = DuplicateReviewStatus.DISMISSED

        review.save(update_fields=["status", "notes", "updated_at"])
        return Response(DuplicateReviewSerializer(review, context={"request": request}).data)


class SourceCatalogEntryListView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        queryset = SourceCatalogEntry.objects.order_by("title")
        query = request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(Q(title__icontains=query) | Q(author_line__icontains=query))

        snapshots, _ = source_catalog_entry_snapshots(queryset)
        status_filter = request.query_params.get("status", "").strip()
        if status_filter:
            snapshots = [snapshot for snapshot in snapshots if snapshot["curation_status"] == status_filter]
        summary = summarize_source_catalog_snapshots(snapshots)
        sort_source_catalog_snapshots(snapshots, request.query_params.get("sort", "").strip())

        try:
            limit_value = max(1, min(int(request.query_params.get("limit", "").strip() or 180), 400))
        except (TypeError, ValueError):
            limit_value = 180
        try:
            page_value = max(1, int(request.query_params.get("page", "").strip() or 1))
        except (TypeError, ValueError):
            page_value = 1

        total_count = len(snapshots)
        page_count = max(1, ((total_count - 1) // limit_value) + 1) if total_count else 1
        page_value = min(page_value, page_count)
        start = (page_value - 1) * limit_value
        end = start + limit_value
        page_entries = snapshots[start:end]

        return Response(
            {
                "summary": summary,
                "entries": SourceCatalogEntrySnapshotSerializer(page_entries, many=True).data,
                "pagination": {
                    "page": page_value,
                    "limit": limit_value,
                    "total_count": total_count,
                    "page_count": page_count,
                    "has_previous": page_value > 1,
                    "has_next": page_value < page_count,
                },
                "sync_state": SourceCatalogRefreshStateSerializer(get_source_catalog_refresh_state()).data,
            }
        )


class SourceCatalogEntryDetailView(APIView):
    permission_classes = [CanManageProcessing]

    def delete(self, request, pk):
        entry = get_object_or_404(SourceCatalogEntry, pk=pk)
        entry.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class SourceCatalogEntryBulkDeleteView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        queryset = SourceCatalogEntry.objects.filter(pk__in=serializer.validated_data["ids"])
        deleted_count = queryset.count()
        queryset.delete()
        return Response(
            {
                "deleted_count": deleted_count,
                "skipped_missing": max(len(serializer.validated_data["ids"]) - deleted_count, 0),
            }
        )


class SourceCatalogEntryCreateBooksView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        locked_response = automation_manual_creation_locked_response() or source_catalog_sync_locked_response()
        if locked_response:
            return locked_response
        entries = list(SourceCatalogEntry.objects.filter(pk__in=serializer.validated_data["ids"]).order_by("title"))
        source_urls = [entry.source_url for entry in entries]
        source_map = source_catalog_book_source_map(source_urls)
        submission_map = source_catalog_submission_map(source_urls)

        summary = {
            "queued_creates": 0,
            "queued_updates": 0,
            "skipped_ready": 0,
            "skipped_processing": 0,
            "skipped_deleted": 0,
            "skipped_missing": max(len(serializer.validated_data["ids"]) - len(entries), 0),
            "errors": [],
        }

        for entry in entries:
            inspection = inspect_source_catalog_entry(entry, source_map, submission_map)
            status_value = inspection["curation_status"]

            try:
                if status_value == "deleted":
                    summary["skipped_deleted"] += 1
                    continue

                if status_value == "processing":
                    summary["skipped_processing"] += 1
                    continue

                if inspection["local_book"] is None:
                    create_submission_records(
                        submitter=request.user,
                        parsed_entries=[{"kind": "url", "value": entry.source_url}],
                        auto_process=True,
                        origin=SubmissionOrigin.CURATION,
                    )
                    summary["queued_creates"] += 1
                    continue

                if status_value in {"unfinished", "failed"}:
                    _, created = queue_reprocess_book(
                        inspection["local_book"],
                        actor=request.user,
                        origin=SubmissionOrigin.CURATION,
                    )
                    if created:
                        summary["queued_updates"] += 1
                    else:
                        summary["skipped_processing"] += 1
                    continue

                summary["skipped_ready"] += 1
            except Exception as exc:
                if len(summary["errors"]) < 20:
                    summary["errors"].append({"source_url": entry.source_url, "error": str(exc)})

        return Response(summary, status=status.HTTP_202_ACCEPTED)


class CatalogCurationRunListCreateView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        queryset = CatalogCurationRun.objects.select_related("requested_by")
        trigger = request.query_params.get("trigger", "").strip()
        if trigger:
            queryset = queryset.filter(trigger=trigger)
        status_filter = request.query_params.get("status", "").strip()
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        mode = request.query_params.get("mode", "").strip()
        if mode:
            queryset = queryset.filter(mode=mode)
        query = request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(
                Q(requested_by__email__icontains=query)
                | Q(last_error__icontains=query)
            )
        limit = request.query_params.get("limit", "").strip()
        try:
            limit_value = max(1, min(int(limit), 50)) if limit else 12
        except (TypeError, ValueError):
            limit_value = 12
        runs = runs_ordered_queryset(queryset)[:limit_value]
        return Response(CatalogCurationRunSerializer(runs, many=True).data)

    def post(self, request):
        locked_response = automation_manual_creation_locked_response()
        if locked_response:
            return locked_response
        serializer = CatalogCurationRunCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        run = create_catalog_curation_run(
            mode=serializer.validated_data["mode"],
            requested_by=request.user,
            refresh_catalog=serializer.validated_data["refresh_catalog"],
            refresh_max_pages=serializer.validated_data["refresh_max_pages"],
        )
        return Response(CatalogCurationRunSerializer(run).data, status=status.HTTP_202_ACCEPTED)


class CatalogCurationRunStopView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request, pk):
        run = get_object_or_404(CatalogCurationRun, pk=pk)
        run = cancel_catalog_curation_run(run)
        return Response(CatalogCurationRunSerializer(run).data)


class CatalogCurationRunDetailView(APIView):
    permission_classes = [CanManageProcessing]

    def delete(self, request, pk):
        run = get_object_or_404(CatalogCurationRun, pk=pk)
        if run.status in {JobStatus.QUEUED, JobStatus.PROCESSING}:
            return Response(
                {"detail": "Stop this run before deleting it."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        run.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class CatalogCurationRunBulkStopView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        runs = list(CatalogCurationRun.objects.filter(pk__in=serializer.validated_data["ids"]))

        stopped_count = 0
        skipped_complete = 0
        for run in runs:
            previous_status = run.status
            run = cancel_catalog_curation_run(run)
            if previous_status == run.status and run.status in {JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED}:
                skipped_complete += 1
                continue
            stopped_count += 1

        return Response(
            {
                "stopped_count": stopped_count,
                "skipped_complete": skipped_complete,
                "skipped_missing": max(len(serializer.validated_data["ids"]) - len(runs), 0),
            }
        )


class CatalogCurationRunBulkDeleteView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        runs = list(CatalogCurationRun.objects.filter(pk__in=serializer.validated_data["ids"]))

        deleted_count = 0
        skipped_active = 0
        for run in runs:
            if run.status in {JobStatus.QUEUED, JobStatus.PROCESSING}:
                skipped_active += 1
                continue
            run.delete()
            deleted_count += 1

        return Response(
            {
                "deleted_count": deleted_count,
                "skipped_active": skipped_active,
                "skipped_missing": max(len(serializer.validated_data["ids"]) - len(runs), 0),
            }
        )


class CatalogAutomationSettingsView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        settings_obj = get_catalog_automation_settings()
        latest_run = CatalogCurationRun.objects.filter(trigger="scheduled").select_related("requested_by").first()
        return Response(
            {
                "settings": CatalogAutomationSettingsSerializer(settings_obj).data,
                "latest_run": CatalogCurationRunSerializer(latest_run).data if latest_run else None,
            }
        )

    def patch(self, request):
        settings_obj = get_catalog_automation_settings()
        serializer = CatalogAutomationSettingsUpdateSerializer(settings_obj, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        settings_obj = serializer.save(updated_by=request.user)
        latest_run = CatalogCurationRun.objects.filter(trigger="scheduled").select_related("requested_by").first()
        return Response(
            {
                "settings": CatalogAutomationSettingsSerializer(settings_obj).data,
                "latest_run": CatalogCurationRunSerializer(latest_run).data if latest_run else None,
            }
        )


class SourceCatalogRefreshView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        locked_response = automation_manual_creation_locked_response()
        if locked_response:
            return locked_response
        try:
            max_pages = int(request.data.get("max_pages") or request.query_params.get("max_pages") or 3)
        except (TypeError, ValueError):
            return Response({"detail": "max_pages must be a whole number."}, status=status.HTTP_400_BAD_REQUEST)
        sync_state, _ = begin_source_catalog_refresh(requested_by=request.user, max_pages=max_pages)
        return Response(SourceCatalogRefreshStateSerializer(sync_state).data, status=status.HTTP_202_ACCEPTED)


class SourceCatalogRefreshStopView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        sync_state = cancel_source_catalog_refresh()
        return Response(SourceCatalogRefreshStateSerializer(sync_state).data)
