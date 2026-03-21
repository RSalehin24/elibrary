from pathlib import Path
from urllib.parse import quote

from django.conf import settings
from django.http import FileResponse, Http404
from django.urls import reverse
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.models import Bookmark, PermissionGrant, PermissionScope, PreviewAccessSession, ReadingSession
from apps.access.serializers import BookmarkSerializer, PermissionGrantSerializer, ReadingSessionSerializer
from apps.catalog.models import Book, GeneratedAsset, GeneratedAssetType
from apps.common.permissions import CanManageAccess, user_has_scope


def get_active_preview_session(user, book):
    return (
        PreviewAccessSession.objects.filter(
            user=user,
            book=book,
            expires_at__gt=timezone.now(),
        )
        .order_by("-created_at")
        .first()
    )


def get_token_preview_session(token):
    session = PreviewAccessSession.objects.select_related("book", "user").filter(token=token).first()
    if session is None or not session.is_active:
        raise Http404("Reader session is unavailable.")
    return session


def resolve_asset(book, asset_type):
    asset = book.generated_assets.filter(asset_type=asset_type).first()
    if asset is None:
        raise Http404("Requested asset does not exist.")
    return asset


def open_asset_stream(asset):
    if asset.file:
        asset.file.open("rb")
        filename = Path(asset.file.name).name
        return asset.file, filename

    if asset.legacy_path:
        handle = open(asset.legacy_path, "rb")
        filename = Path(asset.legacy_path).name
        return handle, filename

    raise Http404("Asset file is not available.")


class PermissionGrantListCreateView(generics.ListCreateAPIView):
    permission_classes = [CanManageAccess]
    serializer_class = PermissionGrantSerializer
    queryset = PermissionGrant.objects.select_related("user", "book").all()

    def perform_create(self, serializer):
        serializer.save(granted_by=self.request.user)


class PermissionGrantDetailView(generics.DestroyAPIView):
    permission_classes = [CanManageAccess]
    serializer_class = PermissionGrantSerializer
    queryset = PermissionGrant.objects.select_related("user", "book").all()


class AccessReferenceDataView(APIView):
    permission_classes = [CanManageAccess]

    def get(self, request):
        users = [
            {
                "id": user.id,
                "email": user.email,
                "name": user.display_name,
                "is_staff": user.is_staff,
                "is_superuser": user.is_superuser,
                "capabilities": user.capability_scopes,
                "grant_count": user.permission_grants.count(),
            }
            for user in request.user.__class__.objects.order_by("email")
        ]
        books = [
            {"id": book.id, "title": book.title, "slug": book.slug}
            for book in Book.objects.order_by("title")
        ]
        scopes = [{"value": scope.value, "label": scope.label} for scope in PermissionScope]
        return Response({"users": users, "books": books, "scopes": scopes})


class BookAssetDownloadView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, slug, asset_type):
        book = Book.objects.get(slug=slug)
        if not user_has_scope(request.user, [PermissionScope.DOWNLOAD_FILE], book=book):
            raise PermissionDenied("You do not have download access for this book.")

        asset = resolve_asset(book, asset_type)
        file_handle, filename = open_asset_stream(asset)
        as_attachment = asset.asset_type != GeneratedAssetType.HTML
        return FileResponse(file_handle, as_attachment=as_attachment, filename=filename)


class ReaderLaunchView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, slug):
        book = Book.objects.get(slug=slug)
        allowed = user_has_scope(
            request.user,
            [
                PermissionScope.PREVIEW_READ_ONCE,
                PermissionScope.READ_DURABLE,
                PermissionScope.DOWNLOAD_FILE,
            ],
            book=book,
        )
        session = get_active_preview_session(request.user, book)
        if not allowed and session is None:
            raise PermissionDenied("You do not have reader access for this book.")

        if session is None:
            session = PreviewAccessSession.objects.create(user=request.user, book=book)

        session.launch_count += 1
        session.save(update_fields=["launch_count", "updated_at"])

        manifest_url = request.build_absolute_uri(
            reverse("access-reader-manifest", kwargs={"token": session.token})
        )
        launch_url = f"{settings.EPUB_READER_BASE_URL.rstrip('/')}/?manifest={quote(manifest_url, safe='')}"

        return Response(
            {
                "launch_url": launch_url,
                "manifest_url": manifest_url,
                "expires_at": session.expires_at,
            }
        )


class ReaderManifestView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, token):
        session = get_token_preview_session(token)

        epub_asset = session.book.generated_assets.filter(asset_type=GeneratedAssetType.EPUB).first()
        html_asset = session.book.generated_assets.filter(asset_type=GeneratedAssetType.HTML).first()
        if epub_asset is None:
            raise Http404("EPUB asset is unavailable.")

        reading_session, _ = ReadingSession.objects.get_or_create(
            user=session.user,
            book=session.book,
            defaults={"preview_session": session},
        )
        bookmarks = Bookmark.objects.filter(user=session.user, book=session.book)

        return Response(
            {
                "book": {
                    "title": session.book.title,
                    "slug": session.book.slug,
                },
                "epub_download_url": request.build_absolute_uri(
                    reverse("access-reader-epub", kwargs={"token": session.token})
                ),
                "html_preview_url": request.build_absolute_uri(
                    reverse("access-reader-html", kwargs={"token": session.token})
                )
                if html_asset
                else "",
                "reading_session_url": request.build_absolute_uri(
                    reverse("access-reader-session", kwargs={"token": session.token})
                ),
                "bookmarks_url": request.build_absolute_uri(
                    reverse("access-reader-bookmark-list", kwargs={"token": session.token})
                ),
                "reading_session": ReadingSessionSerializer(reading_session).data,
                "bookmarks": BookmarkSerializer(bookmarks, many=True).data,
            }
        )


class ReaderEpubDownloadView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, token):
        session = get_token_preview_session(token)

        asset = resolve_asset(session.book, GeneratedAssetType.EPUB)
        file_handle, filename = open_asset_stream(asset)
        return FileResponse(file_handle, as_attachment=False, filename=filename)


class ReaderHtmlPreviewView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, token):
        session = get_token_preview_session(token)

        asset = resolve_asset(session.book, GeneratedAssetType.HTML)
        file_handle, filename = open_asset_stream(asset)
        return FileResponse(file_handle, as_attachment=False, filename=filename)


class ReaderSessionTokenView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, token):
        session = get_token_preview_session(token)
        reading_session, _ = ReadingSession.objects.get_or_create(
            user=session.user,
            book=session.book,
            defaults={"preview_session": session},
        )
        return Response(ReadingSessionSerializer(reading_session).data)

    def post(self, request, token):
        session = get_token_preview_session(token)
        reading_session, _ = ReadingSession.objects.get_or_create(
            user=session.user,
            book=session.book,
            defaults={"preview_session": session},
        )
        serializer = ReadingSessionSerializer(reading_session, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save(user=session.user, book=session.book, preview_session=session)
        return Response(serializer.data)


class ReaderBookmarkTokenListCreateView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request, token):
        session = get_token_preview_session(token)
        queryset = Bookmark.objects.filter(user=session.user, book=session.book)
        return Response(BookmarkSerializer(queryset, many=True).data)

    def post(self, request, token):
        session = get_token_preview_session(token)
        serializer = BookmarkSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(user=session.user, book=session.book)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class ReaderBookmarkTokenDeleteView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def delete(self, request, token, pk):
        session = get_token_preview_session(token)
        bookmark = Bookmark.objects.filter(pk=pk, user=session.user, book=session.book).first()
        if bookmark is None:
            raise Http404("Bookmark not found.")
        bookmark.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ReadingSessionView(APIView):
    permission_classes = [IsAuthenticated]

    def ensure_reader_access(self, request, book):
        allowed = user_has_scope(
            request.user,
            [
                PermissionScope.PREVIEW_READ_ONCE,
                PermissionScope.READ_DURABLE,
                PermissionScope.DOWNLOAD_FILE,
            ],
            book=book,
        )
        if not allowed and get_active_preview_session(request.user, book) is None:
            raise PermissionDenied("You do not have reader access for this book.")

    def get(self, request, slug):
        book = Book.objects.get(slug=slug)
        self.ensure_reader_access(request, book)
        session, _ = ReadingSession.objects.get_or_create(user=request.user, book=book)
        return Response(ReadingSessionSerializer(session).data)

    def post(self, request, slug):
        book = Book.objects.get(slug=slug)
        self.ensure_reader_access(request, book)
        session, _ = ReadingSession.objects.get_or_create(user=request.user, book=book)
        serializer = ReadingSessionSerializer(session, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save(user=request.user, book=book)
        return Response(serializer.data)


class BookmarkListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def ensure_reader_access(self, request, book):
        allowed = user_has_scope(
            request.user,
            [
                PermissionScope.PREVIEW_READ_ONCE,
                PermissionScope.READ_DURABLE,
                PermissionScope.DOWNLOAD_FILE,
            ],
            book=book,
        )
        if not allowed and get_active_preview_session(request.user, book) is None:
            raise PermissionDenied("You do not have reader access for this book.")

    def get(self, request, slug):
        book = Book.objects.get(slug=slug)
        self.ensure_reader_access(request, book)
        queryset = Bookmark.objects.filter(user=request.user, book=book)
        return Response(BookmarkSerializer(queryset, many=True).data)

    def post(self, request, slug):
        book = Book.objects.get(slug=slug)
        self.ensure_reader_access(request, book)
        serializer = BookmarkSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(user=request.user, book=book)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class BookmarkDeleteView(generics.DestroyAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = BookmarkSerializer

    def get_queryset(self):
        return Bookmark.objects.filter(user=self.request.user)
