import logging
from urllib.parse import quote

from django.conf import settings
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils.dateparse import parse_date, parse_datetime
import requests
from rest_framework import generics, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.models import PermissionScope
from apps.catalog.models import GeneratedAssetStatus, GeneratedAssetType
from apps.common.permissions import CanManageProcessing, user_has_scope
from apps.common.throttles import SubmissionRateThrottle
from apps.ingestion.models import (
    BookSubmission,
    CatalogAutomationSettings,
    CatalogCurationRun,
    DuplicateReview,
    DuplicateReviewStatus,
    MatchCandidate,
    ProcessingJob,
    ResolutionStatus,
    SourceCatalogEntry,
    SubmissionOrigin,
    SubmissionStatus,
)
from apps.ingestion.serializers import (
    CatalogAutomationSettingsSerializer,
    CatalogAutomationSettingsUpdateSerializer,
    CatalogCurationRunCreateSerializer,
    CatalogCurationRunSerializer,
    DuplicateReviewDecisionSerializer,
    DuplicateReviewSerializer,
    ProcessingJobSerializer,
    SourceCatalogEntrySnapshotSerializer,
    SubmissionBatchCreateSerializer,
    SubmissionSerializer,
)
from apps.ingestion.services.curation import (
    cancel_catalog_curation_run,
    create_catalog_curation_run,
    get_catalog_automation_settings,
    source_catalog_entry_snapshots,
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
from apps.ingestion.services.resolution import ARCHIVE_MAX_PAGES, TitleResolver

logger = logging.getLogger(__name__)


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


def visible_submissions_queryset(user):
    queryset = submission_base_queryset()
    if user.is_staff or user_has_scope(user, [PermissionScope.PROCESSING_MANAGE]):
        return queryset
    return queryset.filter(submitter=user)


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
        if origin:
            queryset = queryset.filter(origin=origin)
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


class SubmissionDetailView(generics.RetrieveAPIView):
    permission_classes = [AllowAny]
    serializer_class = SubmissionSerializer
    lookup_field = "pk"

    def get_object(self):
        return get_accessible_submission(self.request, self.kwargs["pk"])


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
        manifest_url = request.build_absolute_uri(
            reverse("access-reader-manifest", kwargs={"token": preview_session.token})
        )
        launch_url = f"{settings.EPUB_READER_BASE_URL.rstrip('/')}/?manifest={quote(manifest_url, safe='')}"

        return Response(
            {
                "book": {
                    "title": submission.linked_book.title,
                    "slug": submission.linked_book.slug,
                },
                "launch_url": launch_url,
                "manifest_url": manifest_url,
                "epub_download_url": request.build_absolute_uri(
                    reverse("access-reader-epub", kwargs={"token": preview_session.token})
                )
                if has_epub
                else "",
                "html_preview_url": request.build_absolute_uri(
                    reverse("access-reader-html", kwargs={"token": preview_session.token})
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
        queryset = ProcessingJob.objects.select_related("submission", "book").all()
        origin = self.request.query_params.get("origin", "").strip()
        if origin:
            queryset = queryset.filter(submission__origin=origin)
        status_filter = self.request.query_params.get("status", "").strip()
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        submission_status = self.request.query_params.get("submission_status", "").strip()
        if submission_status:
            queryset = queryset.filter(submission__status=submission_status)
        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(submission__original_input__icontains=query)
        queryset = apply_created_at_filters(queryset, self.request)
        if self.request.user.is_staff or user_has_scope(self.request.user, [PermissionScope.PROCESSING_MANAGE]):
            return apply_limit(queryset, self.request)
        queryset = queryset.filter(submission__submitter=self.request.user)
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
        try:
            job = resume_processing_job(job)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(ProcessingJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


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
        if origin:
            queryset = queryset.filter(submission__origin=origin)
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

        queryset = apply_limit(queryset, request, default_limit=150)

        snapshots, summary = source_catalog_entry_snapshots(queryset)
        status_filter = request.query_params.get("status", "").strip()
        if status_filter:
            snapshots = [snapshot for snapshot in snapshots if snapshot["curation_status"] == status_filter]

        return Response(
            {
                "summary": summary,
                "entries": SourceCatalogEntrySnapshotSerializer(snapshots, many=True).data,
            }
        )


class CatalogCurationRunListCreateView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        queryset = CatalogCurationRun.objects.select_related("requested_by")
        trigger = request.query_params.get("trigger", "").strip()
        if trigger:
            queryset = queryset.filter(trigger=trigger)
        limit = request.query_params.get("limit", "").strip()
        try:
            limit_value = max(1, min(int(limit), 50)) if limit else 12
        except (TypeError, ValueError):
            limit_value = 12
        runs = queryset[:limit_value]
        return Response(CatalogCurationRunSerializer(runs, many=True).data)

    def post(self, request):
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
        try:
            max_pages = int(request.data.get("max_pages") or request.query_params.get("max_pages") or 3)
        except (TypeError, ValueError):
            return Response({"detail": "max_pages must be a whole number."}, status=status.HTTP_400_BAD_REQUEST)
        max_pages = max(1, min(max_pages, ARCHIVE_MAX_PAGES))
        resolver = TitleResolver()
        try:
            refreshed = resolver.refresh_catalog(max_pages=max_pages)
        except requests.RequestException:
            logger.warning("Source catalog refresh failed because the upstream catalog was unavailable.", exc_info=True)
            return Response(
                {"detail": "Could not refresh the source catalog right now. Please try again in a moment."},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        except Exception:
            logger.exception("Source catalog refresh failed unexpectedly.")
            return Response(
                {"detail": "Source catalog refresh failed before it could finish."},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response(
            {
                "refreshed_entries": len(refreshed),
                "max_pages": max_pages,
            },
            status=status.HTTP_202_ACCEPTED,
        )
