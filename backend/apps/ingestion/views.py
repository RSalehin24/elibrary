from django.db.models import Q
from django.utils.dateparse import parse_date, parse_datetime
from rest_framework import generics, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.models import PermissionScope
from apps.common.permissions import CanManageProcessing, user_has_scope
from apps.common.throttles import SubmissionRateThrottle
from apps.ingestion.models import (
    BookSubmission,
    DuplicateReview,
    DuplicateReviewStatus,
    MatchCandidate,
    ProcessingJob,
    ResolutionStatus,
    SubmissionStatus,
)
from apps.ingestion.serializers import (
    DuplicateReviewDecisionSerializer,
    DuplicateReviewSerializer,
    ProcessingJobSerializer,
    SubmissionBatchCreateSerializer,
    SubmissionSerializer,
)
from apps.ingestion.services.submissions import (
    create_submission_records,
    find_existing_book_by_source_url,
    fulfill_submission_with_existing_book,
    queue_submission,
)
from apps.ingestion.services.resolution import TitleResolver


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


def visible_submissions_queryset(user):
    queryset = BookSubmission.objects.select_related("linked_book", "duplicate_of_book").prefetch_related(
        "resolution_attempts__match_candidates",
        "processing_jobs",
    )
    if user.is_staff or user_has_scope(user, [PermissionScope.PROCESSING_MANAGE]):
        return queryset
    return queryset.filter(submitter=user)


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
        serializer = SubmissionSerializer(queryset, many=True, context={"request": request})
        return Response(serializer.data)

    def post(self, request):
        serializer = SubmissionBatchCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        submissions = create_submission_records(
            submitter=request.user if request.user.is_authenticated else None,
            parsed_entries=serializer.validated_data["parsed_entries"],
            auto_process=serializer.validated_data["auto_process"],
        )
        return Response(
            SubmissionSerializer(submissions, many=True, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class SubmissionDetailView(generics.RetrieveAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = SubmissionSerializer
    lookup_field = "pk"

    def get_queryset(self):
        return visible_submissions_queryset(self.request.user)


class SubmissionConfirmCandidateView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        submission = visible_submissions_queryset(request.user).get(pk=pk)
        candidate_id = request.data.get("candidate_id")
        if not candidate_id:
            return Response({"detail": "candidate_id is required."}, status=status.HTTP_400_BAD_REQUEST)

        candidate = MatchCandidate.objects.select_related("resolution_attempt__submission").get(pk=candidate_id)
        if candidate.resolution_attempt.submission_id != submission.id:
            raise PermissionDenied("This candidate does not belong to the specified submission.")

        MatchCandidate.objects.filter(resolution_attempt=candidate.resolution_attempt).update(is_selected=False)
        candidate.is_selected = True
        candidate.save(update_fields=["is_selected", "updated_at"])

        submission.resolved_url = candidate.candidate_url
        submission.resolution_status = ResolutionStatus.RESOLVED
        submission.resolution_confidence = candidate.confidence
        submission.status = SubmissionStatus.QUEUED
        submission.error_message = ""
        submission.save()

        existing_book = find_existing_book_by_source_url(candidate.candidate_url)
        if existing_book:
            fulfill_submission_with_existing_book(
                submission,
                existing_book,
                source="confirmed_candidate_source_url",
                confidence=candidate.confidence,
                resolved_url=candidate.candidate_url,
            )
            return Response(SubmissionSerializer(submission, context={"request": request}).data)

        queue_submission(submission, actor=request.user)
        return Response(SubmissionSerializer(submission, context={"request": request}).data)


class ProcessingJobListView(generics.ListAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = ProcessingJobSerializer

    def get_queryset(self):
        queryset = ProcessingJob.objects.select_related("submission", "book").all()
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
            return queryset
        return queryset.filter(submission__submitter=self.request.user)


class SubmissionRetryView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        submission = visible_submissions_queryset(request.user).get(pk=pk)
        can_manage_processing = user_has_scope(request.user, [PermissionScope.PROCESSING_MANAGE])
        if not request.user.is_staff and not can_manage_processing and submission.submitter_id != request.user.id:
            raise PermissionDenied("You cannot retry this submission.")
        if not submission.resolved_url:
            return Response({"detail": "This submission does not have a resolved URL yet."}, status=status.HTTP_400_BAD_REQUEST)

        job = queue_submission(submission, actor=request.user)
        return Response(ProcessingJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)


class DuplicateReviewListView(generics.ListAPIView):
    permission_classes = [CanManageProcessing]
    serializer_class = DuplicateReviewSerializer
    queryset = DuplicateReview.objects.select_related("submission__linked_book", "existing_book").prefetch_related(
        "submission__resolution_attempts__match_candidates",
        "existing_book__book_contributors__contributor",
        "existing_book__book_series__series",
        "existing_book__book_categories__category",
        "existing_book__generated_assets",
    )


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


class SourceCatalogRefreshView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        max_pages = int(request.data.get("max_pages") or request.query_params.get("max_pages") or 3)
        max_pages = max(1, min(max_pages, 20))
        resolver = TitleResolver()
        refreshed = resolver.refresh_catalog(max_pages=max_pages)
        return Response(
            {
                "refreshed_entries": len(refreshed),
                "max_pages": max_pages,
            },
            status=status.HTTP_202_ACCEPTED,
        )
