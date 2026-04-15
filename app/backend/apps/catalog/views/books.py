from rest_framework import generics, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.renderers import BaseRenderer, JSONRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.catalog.exports import build_book_tickets_pdf_response, build_books_csv_response, build_books_pdf_response
from apps.catalog.models import BookRecordType
from apps.catalog.serializers import BookDetailSerializer, BookListSerializer, ManualBookCreateSerializer

from .shared import BookQueryMixin, export_record_type


def bounded_positive_int(raw_value, *, default, minimum=1, maximum=100):
    try:
        value = int(str(raw_value).strip() or default)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(value, maximum))


class BookListView(BookQueryMixin, generics.ListAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = BookListSerializer

    def list(self, request, *args, **kwargs):
        if "page" not in request.query_params and "limit" not in request.query_params:
            return super().list(request, *args, **kwargs)

        queryset = self.filter_queryset(self.get_queryset())
        limit_value = bounded_positive_int(
            request.query_params.get("limit"),
            default=10,
            maximum=100,
        )
        page_value = bounded_positive_int(
            request.query_params.get("page"),
            default=1,
            maximum=10_000,
        )
        total_count = queryset.count()
        page_count = max(1, ((total_count - 1) // limit_value) + 1) if total_count else 1
        page_value = min(page_value, page_count)
        start = (page_value - 1) * limit_value
        page_entries = queryset[start : start + limit_value]
        serializer = self.get_serializer(page_entries, many=True)
        return Response(
            {
                "entries": serializer.data,
                "pagination": {
                    "page": page_value,
                    "limit": limit_value,
                    "total_count": total_count,
                    "page_count": page_count,
                    "has_previous": page_value > 1,
                    "has_next": page_value < page_count,
                },
            }
        )


class CsvPassthroughRenderer(BaseRenderer):
    media_type = "text/csv"
    format = "csv"
    charset = "utf-8"
    render_style = "binary"

    def render(self, data, accepted_media_type=None, renderer_context=None):
        return data if data is not None else b""


class PdfPassthroughRenderer(BaseRenderer):
    media_type = "application/pdf"
    format = "pdf"
    charset = None
    render_style = "binary"

    def render(self, data, accepted_media_type=None, renderer_context=None):
        return data if data is not None else b""


class BookExportView(BookQueryMixin, APIView):
    permission_classes = [IsAuthenticated]
    renderer_classes = [JSONRenderer, CsvPassthroughRenderer, PdfPassthroughRenderer]

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
    renderer_classes = [JSONRenderer, PdfPassthroughRenderer]

    def get(self, request):
        try:
            return build_book_tickets_pdf_response(list(self.get_queryset()), record_type=export_record_type(request, self.default_record_type))
        except RuntimeError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)


class ManualBookListCreateView(BookQueryMixin, generics.ListCreateAPIView):
    permission_classes = [IsAuthenticated]
    default_record_type = BookRecordType.MANUAL

    def get_serializer_class(self):
        return ManualBookCreateSerializer if self.request.method == "POST" else BookListSerializer

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        book = serializer.save()
        return Response(BookDetailSerializer(book, context={"request": request}).data, status=status.HTTP_201_CREATED)
