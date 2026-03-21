from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from rest_framework import generics
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.catalog.models import Book, MetadataReview, MetadataVersion
from apps.catalog.serializers import (
    BookDetailSerializer,
    BookListSerializer,
    BookMetadataUpdateSerializer,
    MetadataReviewDecisionSerializer,
    MetadataReviewSerializer,
)
from apps.access.models import PermissionScope
from apps.common.permissions import CanEditMetadata, user_has_scope


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
        queryset = (
            Book.objects.prefetch_related(
                "book_contributors__contributor",
                "book_series__series",
                "book_categories__category",
                "generated_assets",
            )
            .filter(deleted_at__isnull=True)
            .distinct()
        )

        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(
                Q(title__icontains=query)
                | Q(book_contributors__contributor__name__icontains=query)
                | Q(book_series__series__name__icontains=query)
                | Q(book_categories__category__name__icontains=query)
                | Q(linked_submissions__original_input__icontains=query)
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
        sort = self.request.query_params.get("sort", "-created_at")
        if sort not in {"title", "-title", "created_at", "-created_at"}:
            sort = "-created_at"
        return queryset.order_by(sort)


class BookDetailView(generics.RetrieveAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = BookDetailSerializer
    lookup_field = "slug"

    def get_queryset(self):
        return Book.objects.prefetch_related(
            "book_contributors__contributor",
            "book_series__series",
            "book_categories__category",
            "generated_assets",
            "source_urls",
        )


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
