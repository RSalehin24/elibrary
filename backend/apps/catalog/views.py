import hashlib

from django.core.files.base import ContentFile
from django.db.models import Exists, OuterRef, Q, Subquery
from django.shortcuts import get_object_or_404
from django.http import Http404
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from django.utils.text import slugify
from rest_framework import generics, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.ingestion.models import BookSubmission
from apps.catalog.models import Book, GeneratedAsset, GeneratedAssetStatus, GeneratedAssetType, MetadataReview, MetadataVersion
from apps.catalog.serializers import (
    BookDetailSerializer,
    EpubAssetReplaceSerializer,
    BookListSerializer,
    BookMetadataUpdateSerializer,
    MetadataReviewDecisionSerializer,
    MetadataReviewSerializer,
)
from apps.access.models import PermissionScope
from apps.common.models import LifecycleState
from apps.common.permissions import CanEditMetadata, user_has_scope
from apps.ingestion.services.submissions import queue_reprocess_book


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


class BookListView(generics.ListAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = BookListSerializer

    def get_queryset(self):
        owned_submission = BookSubmission.objects.filter(
            linked_book=OuterRef("pk"),
            submitter=self.request.user,
        )
        queryset = (
            Book.objects.prefetch_related(
                "book_contributors__contributor",
                "book_series__series",
                "book_categories__category",
                "generated_assets",
                "source_urls",
            )
            .annotate(user_owns_book=Exists(owned_submission))
            .filter(deleted_at__isnull=True)
            .distinct()
        )
        ownership = self.request.query_params.get("ownership", "").strip()

        if ownership == "mine":
            latest_submission = (
                BookSubmission.objects.filter(
                    linked_book=OuterRef("pk"),
                    submitter=self.request.user,
                )
                .order_by("-created_at")
                .values("created_at")[:1]
            )
            queryset = queryset.annotate(
                latest_submission_at=Subquery(latest_submission)
            ).filter(latest_submission_at__isnull=False)

        query = self.request.query_params.get("q", "").strip()
        if query:
            submission_query = Q(linked_submissions__original_input__icontains=query)
            if ownership == "mine":
                submission_query &= Q(linked_submissions__submitter=self.request.user)
            queryset = queryset.filter(
                Q(title__icontains=query)
                | Q(book_contributors__contributor__name__icontains=query)
                | Q(book_series__series__name__icontains=query)
                | Q(book_categories__category__name__icontains=query)
                | submission_query
            )

        author = self.request.query_params.get("author", "").strip()
        if author:
            queryset = queryset.filter(
                book_contributors__role="author",
                book_contributors__contributor__name__icontains=author,
            )

        contributor = self.request.query_params.get("contributor", "").strip()
        if contributor:
            queryset = queryset.filter(book_contributors__contributor__name__icontains=contributor)

        series = self.request.query_params.get("series", "").strip()
        if series:
            queryset = queryset.filter(book_series__series__name__icontains=series)

        category = self.request.query_params.get("category", "").strip()
        if category:
            queryset = queryset.filter(book_categories__category__name__icontains=category)

        state = self.request.query_params.get("state")
        if state:
            queryset = queryset.filter(state=state)

        review_state = self.request.query_params.get("review_state")
        if review_state:
            queryset = queryset.filter(review_state=review_state)

        submission_status = self.request.query_params.get("submission_status", "").strip()
        if submission_status:
            queryset = queryset.filter(linked_submissions__status=submission_status)

        processing_status = self.request.query_params.get("processing_status", "").strip()
        if processing_status:
            queryset = queryset.filter(processing_jobs__status=processing_status)

        queryset = apply_created_at_filters(queryset, self.request)
        sort = self.request.query_params.get(
            "sort",
            "-requested_at" if ownership == "mine" else "-created_at",
        )
        sort_map = {
            "title": "title",
            "-title": "-title",
            "created_at": "created_at",
            "-created_at": "-created_at",
        }
        if ownership == "mine":
            sort_map.update(
                {
                    "requested_at": "latest_submission_at",
                    "-requested_at": "-latest_submission_at",
                }
            )
        sort_field = sort_map.get(sort, "-latest_submission_at" if ownership == "mine" else "-created_at")
        if sort_field in {"created_at", "-created_at"}:
            return queryset.order_by(sort_field)
        return queryset.order_by(sort_field, "-created_at")


class BookDetailView(generics.RetrieveDestroyAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = BookDetailSerializer
    lookup_field = "slug"

    def get_queryset(self):
        owned_submission = BookSubmission.objects.filter(
            linked_book=OuterRef("pk"),
            submitter=self.request.user,
        )
        return (
            Book.objects.prefetch_related(
                "book_contributors__contributor",
                "book_series__series",
                "book_categories__category",
                "generated_assets",
                "source_urls",
                "processing_jobs",
            )
            .annotate(user_owns_book=Exists(owned_submission))
            .filter(deleted_at__isnull=True)
        )

    def get_object(self):
        queryset = self.get_queryset()
        slug = self.kwargs["slug"]
        book = queryset.filter(slug=slug).first()
        if book:
            self.check_object_permissions(self.request, book)
            return book

        for candidate in queryset.only("id", "title", "slug").iterator(chunk_size=200):
            if slugify(candidate.title or "", allow_unicode=True) == slug:
                book = queryset.get(pk=candidate.pk)
                self.check_object_permissions(self.request, book)
                return book

        raise Http404

    def destroy(self, request, *args, **kwargs):
        book = self.get_object()
        if not user_has_scope(request.user, [PermissionScope.METADATA_EDIT], book=book):
            raise PermissionDenied("You do not have permission to delete this book.")

        book.state = LifecycleState.SOFT_DELETED
        book.deleted_at = timezone.now()
        book.save(update_fields=["state", "deleted_at", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class MetadataVersionListView(generics.ListAPIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        book = Book.objects.get(slug=kwargs["slug"])
        if not user_has_scope(request.user, [PermissionScope.METADATA_EDIT], book=book):
            raise PermissionDenied("You do not have permission to inspect metadata history for this book.")
        versions = MetadataVersion.objects.filter(book=book).order_by("-created_at")
        payload = [
            {
                "id": str(version.id),
                "source": version.source,
                "notes": version.notes,
                "created_at": version.created_at,
            }
            for version in versions
        ]
        return Response(payload)


class BookMetadataUpdateView(generics.UpdateAPIView):
    permission_classes = [CanEditMetadata]
    serializer_class = BookMetadataUpdateSerializer
    lookup_field = "slug"

    def get_queryset(self):
        return Book.objects.prefetch_related(
            "book_contributors__contributor",
            "book_series__series",
            "book_categories__category",
        )

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop("partial", True)
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)
        instance.refresh_from_db()
        return Response(BookDetailSerializer(instance, context={"request": request}).data)


class MetadataReviewListCreateView(generics.ListCreateAPIView):
    permission_classes = [CanEditMetadata]
    serializer_class = MetadataReviewSerializer

    def get_book(self):
        book = Book.objects.get(slug=self.kwargs["slug"])
        if not user_has_scope(self.request.user, [PermissionScope.METADATA_EDIT], book=book):
            raise PermissionDenied("You do not have permission to review metadata for this book.")
        return book

    def get_queryset(self):
        return MetadataReview.objects.filter(book=self.get_book()).select_related(
            "requested_by",
            "reviewer",
        )

    def perform_create(self, serializer):
        actor = self.request.user
        book = self.get_book()
        state = serializer.validated_data.get("state", book.review_state)
        serializer.save(
            book=book,
            requested_by=actor,
            reviewer=actor if state != "pending" else None,
        )
        book.review_state = state
        if state in {"approved", "rejected"}:
            book.metadata_last_reviewed_at = timezone.now()
        book.save(update_fields=["review_state", "metadata_last_reviewed_at", "updated_at"])


class MetadataReviewUpdateView(generics.UpdateAPIView):
    permission_classes = [CanEditMetadata]
    serializer_class = MetadataReviewDecisionSerializer
    queryset = MetadataReview.objects.select_related("book", "requested_by", "reviewer")

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        if not user_has_scope(request.user, [PermissionScope.METADATA_EDIT], book=instance.book):
            raise PermissionDenied("You do not have permission to update metadata review for this book.")
        serializer = self.get_serializer(instance, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        self.perform_update(serializer)
        state = serializer.validated_data.get("state", instance.state)
        instance.reviewer = request.user
        instance.save(update_fields=["reviewer", "updated_at"])
        instance.book.review_state = state
        if state in {"approved", "rejected"}:
            instance.book.metadata_last_reviewed_at = timezone.now()
        instance.book.save(update_fields=["review_state", "metadata_last_reviewed_at", "updated_at"])
        return Response(MetadataReviewSerializer(instance).data)


class BookEpubReplaceView(APIView):
    permission_classes = [CanEditMetadata]

    def post(self, request, slug):
        book = get_object_or_404(
            Book.objects.prefetch_related("generated_assets", "source_urls", "processing_jobs").filter(deleted_at__isnull=True),
            slug=slug,
        )
        self.check_object_permissions(request, book)

        serializer = EpubAssetReplaceSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        upload = serializer.validated_data["file"]

        content = upload.read()
        checksum = hashlib.sha256(content).hexdigest()
        asset, _ = GeneratedAsset.objects.get_or_create(book=book, asset_type=GeneratedAssetType.EPUB)
        if asset.file and asset.file.name:
            asset.file.delete(save=False)

        filename = f"{book.title}.epub"
        asset.status = GeneratedAssetStatus.READY
        asset.content_type = upload.content_type or "application/epub+zip"
        asset.file_size = len(content)
        asset.checksum = checksum
        asset.source_job = None
        asset.legacy_path = ""
        asset.file.save(filename, ContentFile(content), save=False)
        asset.storage_path = asset.file.name
        asset.save()
        book.refresh_from_db()

        return Response(BookDetailSerializer(book, context={"request": request}).data)


class BookRegenerateView(APIView):
    permission_classes = [CanEditMetadata]

    def post(self, request, slug):
        book = get_object_or_404(
            Book.objects.prefetch_related("generated_assets", "source_urls", "processing_jobs").filter(deleted_at__isnull=True),
            slug=slug,
        )
        self.check_object_permissions(request, book)

        try:
            job, created = queue_reprocess_book(book, actor=request.user)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        book.refresh_from_db()
        payload = {
            "book": BookDetailSerializer(book, context={"request": request}).data,
            "job": {
                "id": str(job.id),
                "job_type": job.job_type,
                "status": job.status,
                "queue_name": job.queue_name,
                "retry_count": job.retry_count,
                "last_error": job.last_error,
                "created_at": job.created_at,
                "started_at": job.started_at,
                "finished_at": job.finished_at,
            },
            "created": created,
        }
        return Response(payload, status=status.HTTP_202_ACCEPTED)
