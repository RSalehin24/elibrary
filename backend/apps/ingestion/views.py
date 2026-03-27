import logging
from urllib.parse import quote

from django.conf import settings
from django.db.models import Case, IntegerField, Q, Value, When
from django.db.models.functions import Coalesce
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils.dateparse import parse_date, parse_datetime
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.models import PermissionScope
from apps.catalog.models import Book, BookSource, ContributorRole, GeneratedAssetStatus, GeneratedAssetType
from apps.common.models import ReviewState
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
    ProcessingLogSerializer,
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
    can_manage_processing_records,
    cancel_processing_job,
    create_submission_records,
    ensure_preview_session,
    find_existing_book_by_source_url,
    fulfill_submission_with_existing_book,
    queue_submission,
    recover_stale_processing_jobs,
    queue_reprocess_book,
    retry_submission_record,
    retry_submission_records,
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


def normalize_status_filter(value):
    return "cancelled" if value == "stopped" else value


def search_query_variants(query):
    compact = " ".join((query or "").split())
    if not compact:
        return []

    variants = [compact]
    slug_variant = "-".join(compact.split())
    if slug_variant != compact:
        variants.append(slug_variant)

    for value in list(variants):
        encoded_value = quote(value, safe="")
        if encoded_value and encoded_value != value:
            variants.append(encoded_value)

    return list(dict.fromkeys(variants))


def apply_text_search(queryset, query, *field_names):
    variants = search_query_variants(query)
    if not variants or not field_names:
        return queryset

    combined_query = None
    for value in variants:
        value_query = None
        for field_name in field_names:
            clause = Q(**{f"{field_name}__icontains": value})
            value_query = clause if value_query is None else value_query | clause
        combined_query = value_query if combined_query is None else combined_query | value_query

    return queryset.filter(combined_query)


INCOMPLETE_CATEGORY_KEYWORDS = ("unfinished", "অসম্পূর্ণ বই", "অসম্পূর্ণ")


def has_incomplete_keyword(value):
    normalized = (value or "").strip().lower()
    if not normalized:
        return False
    return any(keyword in normalized for keyword in INCOMPLETE_CATEGORY_KEYWORDS)


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
        "stopped": 2,
        "requeued": 3,
        "unfinished": 4,
        "new": 5,
        "ready": 6,
        "deleted": 7,
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


def deleted_source_catalog_entries_queryset(queryset):
    deleted_book_sources = BookSource.objects.filter(
        book__deleted_at__isnull=False,
    ).values("normalized_source_url")
    return queryset.filter(source_url__in=deleted_book_sources)


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
    if can_manage_processing_records(user):
        return queryset
    return queryset.filter(submitter=user)


def visible_jobs_queryset(user):
    queryset = ProcessingJob.objects.select_related("submission", "submission__linked_book", "book")
    if can_manage_processing_records(user):
        return queryset
    return queryset.filter(submission__submitter=user)


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
        if can_manage_processing_records(user):
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
        status_filter = normalize_status_filter(request.query_params.get("status", "").strip())
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
            queryset = apply_text_search(queryset, query, "original_input", "resolved_url")
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


class SubmissionBulkStatusView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        requested_ids = [str(value) for value in serializer.validated_data["ids"]]
        submission_map = {
            str(submission.id): submission
            for submission in submission_base_queryset().filter(pk__in=requested_ids)
        }

        visible_submissions = []
        user = request.user
        can_manage = getattr(user, "is_authenticated", False) and can_manage_processing_records(user)

        for submission_id in requested_ids:
            submission = submission_map.get(submission_id)
            if submission is None:
                continue
            if can_manage:
                visible_submissions.append(submission)
                continue
            if getattr(user, "is_authenticated", False) and submission.submitter_id == user.id:
                visible_submissions.append(submission)
                continue
            if is_public_submission(submission):
                visible_submissions.append(submission)

        return Response(SubmissionSerializer(visible_submissions, many=True, context={"request": request}).data)


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
        if submission.linked_book.deleted_at:
            return Response({"detail": "This book was deleted."}, status=status.HTTP_410_GONE)

        is_guest_submission = is_public_submission(submission)
        preview_session = ensure_preview_session(
            request.user if getattr(request.user, "is_authenticated", False) else None,
            submission.linked_book,
            submission=submission,
            allow_guest=is_guest_submission,
        )
        if preview_session is None:
            return Response({"detail": "Could not prepare access for this book."}, status=status.HTTP_400_BAD_REQUEST)

        assets = submission.linked_book.generated_assets
        has_epub = assets.filter(asset_type=GeneratedAssetType.EPUB, status=GeneratedAssetStatus.READY).exists()
        has_html = assets.filter(asset_type=GeneratedAssetType.HTML, status=GeneratedAssetStatus.READY).exists()
        manifest_url = public_api_url("access-reader-manifest", kwargs={"token": preview_session.token}, request=request)
        launch_url = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/reader?manifest={quote(manifest_url, safe='')}"

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
        status_filter = normalize_status_filter(self.request.query_params.get("status", "").strip())
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        submission_status = normalize_status_filter(self.request.query_params.get("submission_status", "").strip())
        if submission_status:
            queryset = queryset.filter(submission__status=submission_status)
        job_type = self.request.query_params.get("job_type", "").strip()
        if job_type:
            queryset = queryset.filter(job_type=job_type)
        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = apply_text_search(queryset, query, "submission__original_input", "last_error", "book__title")
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


class ProcessingJobLogsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        job = get_object_or_404(visible_jobs_queryset(request.user), pk=pk)
        logs = job.logs.order_by("created_at")[:200]
        return Response(ProcessingLogSerializer(logs, many=True).data)


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


class SubmissionBulkRetryView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        requested_ids = serializer.validated_data["ids"]
        submissions = list(visible_submissions_queryset(request.user).filter(pk__in=requested_ids))
        locked_response = automation_manual_creation_locked_response()
        if locked_response:
            return locked_response

        payload = retry_submission_records(submissions, request.user)

        return Response(
            {
                **payload,
                "skipped_missing": max(len(requested_ids) - len(submissions), 0),
            },
            status=status.HTTP_202_ACCEPTED,
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
        locked_response = automation_manual_creation_locked_response()
        if locked_response:
            return locked_response
        try:
            job = retry_submission_record(submission, request.user)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
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
            queryset = apply_text_search(
                queryset,
                query,
                "submission__original_input",
                "existing_book__title",
                "notes",
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
            if review.existing_book.deleted_at:
                return Response({"detail": "This existing book was deleted. Recreate it instead."}, status=status.HTTP_410_GONE)
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
            target_submission = review.submission.canonical_submission or review.submission
            update_fields = []
            if target_submission.linked_book_id and target_submission.linked_book and target_submission.linked_book.deleted_at:
                target_submission.linked_book = None
                update_fields.append("linked_book")
            if target_submission.duplicate_of_book_id:
                target_submission.duplicate_of_book = None
                update_fields.append("duplicate_of_book")
            if target_submission.error_message:
                target_submission.error_message = ""
                update_fields.append("error_message")
            next_payload = dict(target_submission.raw_payload or {})
            payload_changed = False
            for key in ("served_from_database", "existing_book_source", "linked_book_slug"):
                if key in next_payload:
                    next_payload.pop(key, None)
                    payload_changed = True
            if payload_changed:
                target_submission.raw_payload = next_payload
                update_fields.append("raw_payload")

            can_queue_recreate = bool(target_submission.resolved_url or target_submission.input_type == "title")
            if can_queue_recreate:
                locked_response = automation_manual_creation_locked_response()
                if locked_response:
                    return locked_response
                target_submission.review_state = ReviewState.PENDING
                update_fields.append("review_state")
            else:
                target_submission.status = SubmissionStatus.NEEDS_REVIEW
                target_submission.review_state = ReviewState.NEEDS_REVIEW
                update_fields.extend(["status", "review_state"])

            if update_fields:
                target_submission.save(update_fields=[*dict.fromkeys(update_fields), "updated_at"])

            if can_queue_recreate:
                queue_submission(target_submission, actor=request.user)
                review.submission.refresh_from_db()
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

        status_filter = request.query_params.get("status", "").strip()
        normalized_status_filter = normalize_status_filter(status_filter)

        snapshot_queryset = queryset
        if normalized_status_filter == "deleted":
            snapshot_queryset = deleted_source_catalog_entries_queryset(queryset)

        snapshots, _ = source_catalog_entry_snapshots(snapshot_queryset)
        if normalized_status_filter and normalized_status_filter != "deleted":
            snapshots = [
                snapshot
                for snapshot in snapshots
                if normalize_status_filter(snapshot["curation_status"]) == normalized_status_filter
            ]
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
                if status_value == "processing":
                    summary["skipped_processing"] += 1
                    continue

                if inspection["local_book"] is None or status_value == "deleted":
                    create_submission_records(
                        submitter=request.user,
                        parsed_entries=[{"kind": "url", "value": entry.source_url}],
                        auto_process=True,
                        origin=SubmissionOrigin.CURATION,
                    )
                    summary["queued_creates"] += 1
                    continue

                if status_value in {"unfinished", "failed", "stopped", "requeued"}:
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


class IncompleteCatalogCheckListView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        books = list(
            Book.objects.filter(deleted_at__isnull=True)
            .prefetch_related(
                "book_categories__category",
                "source_urls",
                "processing_jobs",
                "book_contributors__contributor",
            )
            .order_by("title")
        )

        source_urls = []
        for book in books:
            source = next(iter(book.source_urls.all()), None)
            if source and source.normalized_source_url:
                source_urls.append(source.normalized_source_url)

        entry_map = {
            entry.source_url: entry
            for entry in SourceCatalogEntry.objects.filter(source_url__in=source_urls)
        }

        rows = []
        summary = {
            "total_incomplete_books": 0,
            "removed_from_unfinished": 0,
            "still_in_unfinished": 0,
            "missing_in_catalog": 0,
            "queued": 0,
            "processing": 0,
            "failed": 0,
            "stopped": 0,
            "requeued": 0,
        }

        for book in books:
            local_categories = ", ".join(
                relation.category.name
                for relation in book.book_categories.all()
                if relation.category_id and relation.category and relation.category.name
            )
            if not has_incomplete_keyword(local_categories):
                continue

            source = next(iter(book.source_urls.all()), None)
            source_url = source.normalized_source_url if source else ""
            entry = entry_map.get(source_url)
            source_categories = ""
            if entry:
                raw_data = entry.raw_data or {}
                source_categories = (raw_data.get("category") or raw_data.get("book_type") or "").strip()

            removed_from_unfinished = bool(entry) and not has_incomplete_keyword(source_categories)
            latest_job = next(iter(book.processing_jobs.all()), None)
            latest_status = latest_job.status if latest_job else ""

            summary["total_incomplete_books"] += 1
            if removed_from_unfinished:
                summary["removed_from_unfinished"] += 1
            elif entry:
                summary["still_in_unfinished"] += 1
            else:
                summary["missing_in_catalog"] += 1

            if latest_status in {"queued", "processing", "failed", "cancelled"}:
                mapped_status = "stopped" if latest_status == "cancelled" else latest_status
                summary[mapped_status] += 1

            requeued = bool(latest_job and latest_job.job_type == "reprocess")
            if requeued:
                summary["requeued"] += 1

            author_names = [
                relation.contributor.name
                for relation in book.book_contributors.all()
                if relation.role == ContributorRole.AUTHOR
                and relation.contributor_id
                and relation.contributor
                and relation.contributor.name
            ]

            rows.append(
                {
                    "book_id": str(book.id),
                    "book_title": book.title,
                    "book_slug": book.slug,
                    "author_line": ", ".join(author_names),
                    "local_categories": local_categories,
                    "source_url": source_url,
                    "source_categories": source_categories,
                    "catalog_entry_id": str(entry.id) if entry else "",
                    "removed_from_unfinished": removed_from_unfinished,
                    "latest_job_status": "stopped" if latest_status == "cancelled" else latest_status,
                    "latest_job_error": latest_job.last_error if latest_job else "",
                    "is_requeued": requeued,
                    "updated_at": book.updated_at,
                }
            )

        query = request.query_params.get("q", "").strip().lower()
        if query:
            rows = [
                row
                for row in rows
                if query in row["book_title"].lower()
                or query in (row["author_line"] or "").lower()
                or query in (row["source_categories"] or "").lower()
            ]

        status_filter = request.query_params.get("status", "").strip().lower()
        if status_filter == "removed":
            rows = [row for row in rows if row["removed_from_unfinished"]]
        elif status_filter == "still":
            rows = [row for row in rows if row["catalog_entry_id"] and not row["removed_from_unfinished"]]
        elif status_filter == "missing":
            rows = [row for row in rows if not row["catalog_entry_id"]]

        rows.sort(
            key=lambda row: (
                0 if row["removed_from_unfinished"] else 1,
                row.get("book_title") or "",
            )
        )

        return Response({"summary": summary, "entries": rows})


class IncompleteCatalogCheckCreateBooksView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        locked_response = automation_manual_creation_locked_response()
        if locked_response:
            return locked_response

        books = list(Book.objects.filter(pk__in=serializer.validated_data["ids"], deleted_at__isnull=True))

        summary = {
            "queued_updates": 0,
            "skipped_processing": 0,
            "skipped_missing": max(len(serializer.validated_data["ids"]) - len(books), 0),
            "errors": [],
        }

        for book in books:
            try:
                _, created = queue_reprocess_book(
                    book,
                    actor=request.user,
                    origin=SubmissionOrigin.CURATION,
                )
                if created:
                    summary["queued_updates"] += 1
                else:
                    summary["skipped_processing"] += 1
            except Exception as exc:
                if len(summary["errors"]) < 20:
                    summary["errors"].append({"book_id": str(book.id), "error": str(exc)})

        return Response(summary, status=status.HTTP_202_ACCEPTED)


class CatalogCurationRunListCreateView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        queryset = CatalogCurationRun.objects.select_related("requested_by")
        trigger = request.query_params.get("trigger", "").strip()
        if trigger:
            queryset = queryset.filter(trigger=trigger)
        status_filter = normalize_status_filter(request.query_params.get("status", "").strip())
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
