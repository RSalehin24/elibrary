import hashlib

from django.core.files.base import ContentFile
from django.http import Http404
from django.db.models import Count, Exists, OuterRef, Q, Subquery
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from django.utils.text import slugify
from rest_framework import generics, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.ingestion.models import BookSubmission
from apps.catalog.models import (
    Book,
    BookRecordType,
    Category,
    Contributor,
    ContributorRole,
    GeneratedAsset,
    GeneratedAssetStatus,
    GeneratedAssetType,
    MetadataReview,
    MetadataVersion,
)
from apps.catalog.exports import (
    build_book_tickets_pdf_response,
    build_books_csv_response,
    build_books_pdf_response,
)
from apps.catalog.serializers import (
    BookDetailSerializer,
    BookListSerializer,
    BookMetadataUpdateSerializer,
    CategoryListSerializer,
    EpubAssetReplaceSerializer,
    ManualBookCreateSerializer,
    MetadataReviewDecisionSerializer,
    MetadataReviewSerializer,
    WriterListSerializer,
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


VALID_RECORD_TYPES = {choice for choice, _ in BookRecordType.choices}


def requested_record_type(request, default_record_type):
    record_type = request.query_params.get("record_type", "").strip()
    if record_type == "all":
        return "all"
    if record_type in VALID_RECORD_TYPES:
        return record_type
    return default_record_type


def apply_book_record_type_filter(queryset, request, *, default_record_type):
    record_type = requested_record_type(request, default_record_type)
    if record_type == "all":
        return queryset
    return queryset.filter(record_type=record_type)


def export_record_type(request, default_record_type):
    record_type = requested_record_type(request, default_record_type)
    if record_type == "all":
        return "all"
    return record_type


def filtered_book_queryset(queryset, request, *, default_record_type):
    queryset = apply_book_record_type_filter(queryset, request, default_record_type=default_record_type)
    ownership = request.query_params.get("ownership", "").strip()

    if ownership == "mine":
        latest_submission = (
            BookSubmission.objects.filter(
                linked_book=OuterRef("pk"),
                submitter=request.user,
            )
            .order_by("-created_at")
            .values("created_at")[:1]
        )
        queryset = queryset.annotate(latest_submission_at=Subquery(latest_submission)).filter(latest_submission_at__isnull=False)

    query = request.query_params.get("q", "").strip()
    if query:
        submission_query = Q(linked_submissions__original_input__icontains=query)
        if ownership == "mine":
            submission_query &= Q(linked_submissions__submitter=request.user)
        queryset = queryset.filter(
            Q(catalog_code__icontains=query)
            | Q(title__icontains=query)
            | Q(book_contributors__contributor__name__icontains=query)
            | Q(book_contributors__contributor__catalog_code__icontains=query)
            | Q(book_series__series__name__icontains=query)
            | Q(book_categories__category__name__icontains=query)
            | Q(book_categories__category__catalog_code__icontains=query)
            | submission_query
        )

    book_code = request.query_params.get("book_code", "").strip()
    if book_code:
        queryset = queryset.filter(catalog_code__icontains=book_code)

    author = request.query_params.get("author", "").strip() or request.query_params.get("writer", "").strip()
    if author:
        queryset = queryset.filter(
            book_contributors__role=ContributorRole.AUTHOR,
            book_contributors__contributor__name__icontains=author,
        )

    writer_code = request.query_params.get("writer_code", "").strip()
    if writer_code:
        queryset = queryset.filter(
            book_contributors__role=ContributorRole.AUTHOR,
            book_contributors__contributor__catalog_code=writer_code,
        )

    writer_slug = request.query_params.get("writer_slug", "").strip()
    if writer_slug:
        queryset = queryset.filter(
            book_contributors__role=ContributorRole.AUTHOR,
            book_contributors__contributor__slug=writer_slug,
        )

    contributor = request.query_params.get("contributor", "").strip()
    if contributor:
        queryset = queryset.filter(book_contributors__contributor__name__icontains=contributor)

    series = request.query_params.get("series", "").strip()
    if series:
        queryset = queryset.filter(book_series__series__name__icontains=series)

    category = request.query_params.get("category", "").strip()
    if category:
        queryset = queryset.filter(book_categories__category__name__icontains=category)

    category_code = request.query_params.get("category_code", "").strip()
    if category_code:
        queryset = queryset.filter(book_categories__category__catalog_code=category_code)

    category_slug = request.query_params.get("category_slug", "").strip()
    if category_slug:
        queryset = queryset.filter(book_categories__category__slug=category_slug)

    state = request.query_params.get("state", "").strip()
    if state:
        queryset = queryset.filter(state=state)

    review_state = request.query_params.get("review_state", "").strip()
    if review_state:
        queryset = queryset.filter(review_state=review_state)

    submission_status = request.query_params.get("submission_status", "").strip()
    if submission_status:
        queryset = queryset.filter(linked_submissions__status=submission_status)

    processing_status = request.query_params.get("processing_status", "").strip()
    if processing_status:
        queryset = queryset.filter(processing_jobs__status=processing_status)

    queryset = apply_created_at_filters(queryset, request).distinct()
    sort = request.query_params.get("sort", "-requested_at" if ownership == "mine" else "-created_at")
    sort_map = {
        "catalog_code": "catalog_code",
        "-catalog_code": "-catalog_code",
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


class BookQueryMixin:
    default_record_type = BookRecordType.DIGITAL

    def base_queryset(self):
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
            )
            .annotate(user_owns_book=Exists(owned_submission))
            .filter(deleted_at__isnull=True)
        )

    def get_queryset(self):
        return filtered_book_queryset(self.base_queryset(), self.request, default_record_type=self.default_record_type)


class BookListView(BookQueryMixin, generics.ListAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = BookListSerializer


class BookExportView(BookQueryMixin, APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        export_format = request.query_params.get("format", "csv").strip().lower()
        books = list(self.get_queryset())
        record_type = export_record_type(request, self.default_record_type)
        if export_format == "csv":
            return build_books_csv_response(books, record_type=record_type)
        if export_format == "pdf":
            try:
                return build_books_pdf_response(books, record_type=record_type)
            except RuntimeError as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({"detail": "format must be csv or pdf."}, status=status.HTTP_400_BAD_REQUEST)


class BookTicketExportView(BookQueryMixin, APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        books = list(self.get_queryset())
        record_type = export_record_type(request, self.default_record_type)
        try:
            return build_book_tickets_pdf_response(books, record_type=record_type)
        except RuntimeError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)


class ManualBookListCreateView(BookQueryMixin, generics.ListCreateAPIView):
    permission_classes = [IsAuthenticated]
    default_record_type = BookRecordType.MANUAL

    def get_serializer_class(self):
        if self.request.method == "POST":
            return ManualBookCreateSerializer
        return BookListSerializer

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        book = serializer.save()
        return Response(BookDetailSerializer(book, context={"request": request}).data, status=status.HTTP_201_CREATED)


class CategoryListView(generics.ListAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = CategoryListSerializer

    def get_queryset(self):
        queryset = Category.objects.annotate(
            digital_book_count=Count(
                "books",
                filter=Q(books__deleted_at__isnull=True, books__record_type=BookRecordType.DIGITAL),
                distinct=True,
            ),
            manual_book_count=Count(
                "books",
                filter=Q(books__deleted_at__isnull=True, books__record_type=BookRecordType.MANUAL),
                distinct=True,
            ),
        )
        record_type = requested_record_type(self.request, BookRecordType.DIGITAL)
        if record_type == "manual":
            queryset = queryset.annotate(
                book_count=Count(
                    "books",
                    filter=Q(books__deleted_at__isnull=True, books__record_type=BookRecordType.MANUAL),
                    distinct=True,
                )
            )
        elif record_type == "all":
            queryset = queryset.annotate(
                book_count=Count("books", filter=Q(books__deleted_at__isnull=True), distinct=True)
            )
        else:
            queryset = queryset.annotate(
                book_count=Count(
                    "books",
                    filter=Q(books__deleted_at__isnull=True, books__record_type=BookRecordType.DIGITAL),
                    distinct=True,
                )
            )

        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(Q(name__icontains=query) | Q(catalog_code__icontains=query))
        queryset = apply_created_at_filters(queryset, self.request).filter(book_count__gt=0)

        sort_field = {
            "catalog_code": "catalog_code",
            "-catalog_code": "-catalog_code",
            "name": "name",
            "-name": "-name",
            "created_at": "created_at",
            "-created_at": "-created_at",
            "book_count": "book_count",
            "-book_count": "-book_count",
        }.get(self.request.query_params.get("sort", "-book_count"), "-book_count")

        if sort_field in {"created_at", "-created_at"}:
            return queryset.order_by(sort_field)
        return queryset.order_by(sort_field, "name")


class WriterListView(generics.ListAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = WriterListSerializer

    def get_queryset(self):
        queryset = Contributor.objects.filter(book_contributions__role=ContributorRole.AUTHOR).annotate(
            digital_book_count=Count(
                "book_contributions__book",
                filter=Q(
                    book_contributions__role=ContributorRole.AUTHOR,
                    book_contributions__book__deleted_at__isnull=True,
                    book_contributions__book__record_type=BookRecordType.DIGITAL,
                ),
                distinct=True,
            ),
            manual_book_count=Count(
                "book_contributions__book",
                filter=Q(
                    book_contributions__role=ContributorRole.AUTHOR,
                    book_contributions__book__deleted_at__isnull=True,
                    book_contributions__book__record_type=BookRecordType.MANUAL,
                ),
                distinct=True,
            ),
        ).distinct()
        record_type = requested_record_type(self.request, BookRecordType.DIGITAL)
        if record_type == "manual":
            queryset = queryset.annotate(
                book_count=Count(
                    "book_contributions__book",
                    filter=Q(
                        book_contributions__role=ContributorRole.AUTHOR,
                        book_contributions__book__deleted_at__isnull=True,
                        book_contributions__book__record_type=BookRecordType.MANUAL,
                    ),
                    distinct=True,
                )
            )
        elif record_type == "all":
            queryset = queryset.annotate(
                book_count=Count(
                    "book_contributions__book",
                    filter=Q(
                        book_contributions__role=ContributorRole.AUTHOR,
                        book_contributions__book__deleted_at__isnull=True,
                    ),
                    distinct=True,
                )
            )
        else:
            queryset = queryset.annotate(
                book_count=Count(
                    "book_contributions__book",
                    filter=Q(
                        book_contributions__role=ContributorRole.AUTHOR,
                        book_contributions__book__deleted_at__isnull=True,
                        book_contributions__book__record_type=BookRecordType.DIGITAL,
                    ),
                    distinct=True,
                )
            )

        query = self.request.query_params.get("q", "").strip()
        if query:
            queryset = queryset.filter(Q(name__icontains=query) | Q(catalog_code__icontains=query))
        queryset = apply_created_at_filters(queryset, self.request).filter(book_count__gt=0)

        sort_field = {
            "catalog_code": "catalog_code",
            "-catalog_code": "-catalog_code",
            "name": "name",
            "-name": "-name",
            "created_at": "created_at",
            "-created_at": "-created_at",
            "book_count": "book_count",
            "-book_count": "-book_count",
        }.get(self.request.query_params.get("sort", "-book_count"), "-book_count")

        if sort_field in {"created_at", "-created_at"}:
            return queryset.order_by(sort_field)
        return queryset.order_by(sort_field, "name")


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
