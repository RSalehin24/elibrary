import logging
import base64
import mimetypes
import re
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from bs4 import BeautifulSoup
from django.conf import settings
from django.http import FileResponse, Http404, HttpResponse
from django.urls import reverse
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.access.models import (
    ACCOUNT_MANAGEABLE_PERMISSION_SCOPES,
    SCOPED_PERMISSION_SCOPES,
    Bookmark,
    PermissionGrant,
    PermissionScope,
    PreviewAccessSession,
    ReadingSession,
    default_preview_expiry,
)
from apps.access.serializers import BookmarkSerializer, PermissionGrantSerializer, ReadingSessionSerializer
from apps.catalog.models import Book, Contributor, ContributorRole, Category, GeneratedAsset, GeneratedAssetStatus, GeneratedAssetType
from apps.common.permissions import IsSuperAdmin, user_can_download_book_assets, user_can_launch_reader, user_can_view_book_cover, user_has_scope
from apps.common.models import LifecycleState, ReviewState
from apps.common.url_utils import public_api_url
from apps.ingestion.services.normalization import clean_extracted_dedication_html, promote_leading_front_matter

logger = logging.getLogger(__name__)


def apply_no_store_headers(response):
    response["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response["Pragma"] = "no-cache"
    response["Expires"] = "0"
    return response


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


def get_authenticated_token_preview_session(request, token):
    session = get_token_preview_session(token)
    user = getattr(request, "user", None)
    if not getattr(user, "is_authenticated", False):
        raise PermissionDenied("Sign in is required to access the reader.")
    if session.user_id != user.id:
        raise PermissionDenied("This reader session does not belong to your account.")
    return session


def resolve_asset(book, asset_type):
    asset = book.generated_assets.filter(asset_type=asset_type, status=GeneratedAssetStatus.READY).first()
    if asset is None:
        raise Http404("Requested asset does not exist.")
    return asset


def open_asset_stream(asset):
    if asset.file and asset.file.name and asset_file_exists(asset.file):
        asset.file.open("rb")
        return asset.file

    if asset.legacy_path:
        legacy_path = Path(asset.legacy_path)
        if legacy_path.exists():
            return open(legacy_path, "rb")

    raise Http404("Asset file is not available.")


def asset_source_name(asset):
    if asset.file and asset.file.name:
        return Path(asset.file.name).name
    if asset.legacy_path:
        return Path(asset.legacy_path).name
    return ""


def asset_file_exists(file_field):
    if not file_field or not getattr(file_field, "name", ""):
        return False

    storage = getattr(file_field, "storage", None)
    if storage is not None:
        try:
            if storage.exists(file_field.name):
                return True
        except Exception:
            logger.warning("Could not verify stored asset path %s", file_field.name, exc_info=True)

    try:
        return Path(file_field.path).exists()
    except (AttributeError, NotImplementedError, TypeError, ValueError):
        return False


def safe_download_stem(value):
    cleaned = re.sub(r'[<>:"/\\|?*]+', "-", str(value or "")).strip().strip(".")
    return cleaned or "book"


def asset_download_filename(book, asset):
    source_name = asset_source_name(asset)
    source_suffix = Path(source_name).suffix.lower()

    if asset.asset_type == GeneratedAssetType.EPUB:
        suffix = ".epub"
    elif asset.asset_type == GeneratedAssetType.COVER:
        suffix = source_suffix or mimetypes.guess_extension(asset.content_type or "") or ".jpg"
    elif asset.asset_type == GeneratedAssetType.HTML:
        suffix = ".html"
    else:
        suffix = source_suffix or mimetypes.guess_extension(asset.content_type or "") or ""

    return f"{safe_download_stem(book.title)}{suffix}"


def local_asset_path(asset):
    if asset is None:
        return None

    if asset.file and asset.file.name:
        try:
            path = Path(asset.file.path)
            if path.exists():
                return path
        except (AttributeError, NotImplementedError, ValueError):
            pass

    if asset.legacy_path:
        path = Path(asset.legacy_path)
        if path.exists():
            return path

    return None


def read_asset_bytes(asset):
    path = local_asset_path(asset)
    if path and path.exists():
        return path.read_bytes(), path.name, path

    if asset.file and asset.file.name and asset_file_exists(asset.file):
        asset.file.open("rb")
        try:
            return asset.file.read(), Path(asset.file.name).name, None
        finally:
            asset.file.close()

    raise Http404("Asset file is not available.")


def asset_is_available(asset):
    if asset is None:
        return False
    if asset.file and asset.file.name and asset_file_exists(asset.file):
        return True
    if asset.legacy_path:
        return Path(asset.legacy_path).exists()
    return False


def clear_missing_asset(asset):
    update_fields = []
    if asset.status != GeneratedAssetStatus.FAILED:
        asset.status = GeneratedAssetStatus.FAILED
        update_fields.append("status")
    if asset.file and asset.file.name:
        asset.file = ""
        update_fields.append("file")
    if asset.storage_path:
        asset.storage_path = ""
        update_fields.append("storage_path")
    if asset.legacy_path:
        asset.legacy_path = ""
        update_fields.append("legacy_path")
    if asset.file_size:
        asset.file_size = 0
        update_fields.append("file_size")
    if update_fields:
        asset.save(update_fields=[*update_fields, "updated_at"])


def queue_missing_asset_recovery(book, actor=None):
    from apps.ingestion.services.submissions import primary_source_url_for_book, queue_reprocess_book

    if not primary_source_url_for_book(book):
        return None, False

    try:
        return queue_reprocess_book(book, actor=actor)
    except Exception:
        logger.warning("Could not queue regeneration for missing asset on book %s", book.pk, exc_info=True)
        return None, False


def missing_asset_response(book, asset, actor=None):
    clear_missing_asset(asset)
    job, created = queue_missing_asset_recovery(book, actor=actor)

    if job is not None:
        return Response(
            {
                "detail": "This file was missing from storage. Regeneration has been queued.",
                "job_id": str(job.id),
                "status": job.status,
            },
            status=status.HTTP_409_CONFLICT,
        )

    book_update_fields = []
    if book.state != LifecycleState.NEEDS_REVIEW:
        book.state = LifecycleState.NEEDS_REVIEW
        book_update_fields.append("state")
    if book.review_state != ReviewState.NEEDS_REVIEW:
        book.review_state = ReviewState.NEEDS_REVIEW
        book_update_fields.append("review_state")
    if book_update_fields:
        book.save(update_fields=[*book_update_fields, "updated_at"])

    return Response(
        {"detail": "This file is no longer available in storage. Please regenerate the book."},
        status=status.HTTP_404_NOT_FOUND,
    )


def build_data_uri(path):
    mime_type = mimetypes.guess_type(str(path))[0] or "image/jpeg"
    encoded_image = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded_image}"


def is_local_preview_src(src):
    if not src:
        return False
    parsed = urlsplit(src)
    if parsed.scheme or parsed.netloc:
        return False
    if src.startswith(("/", "#")):
        return False
    return parsed.path != ""


def is_cover_reference(image_tag, requested_name):
    classes = set(image_tag.get("class", []))
    alt_text = (image_tag.get("alt") or "").lower()
    stem = Path(requested_name).stem.lower()
    return "cover-image" in classes or "cover" in alt_text or stem in {"book_cover", "book_image"}


def resolve_preview_image_path(source_dir, requested_src, image_tag, cover_path=None):
    if source_dir is None or not source_dir.exists():
        source_dir = None

    requested_name = Path(unquote(urlsplit(requested_src).path)).name
    requested_stem = Path(requested_name).stem

    if source_dir and requested_name:
        direct_path = source_dir / requested_name
        if direct_path.is_file():
            return direct_path

        if requested_stem:
            for candidate in sorted(source_dir.iterdir()):
                if candidate.is_file() and candidate.stem == requested_stem:
                    return candidate

    if is_cover_reference(image_tag, requested_name):
        if cover_path and cover_path.exists():
            return cover_path

        if source_dir:
            for fallback_stem in ("book_cover", "book_image"):
                for candidate in sorted(source_dir.glob(f"{fallback_stem}.*")):
                    if candidate.is_file():
                        return candidate

    return None


def normalize_preview_html(book, asset):
    html_bytes, _, source_path = read_asset_bytes(asset)
    html_text = html_bytes.decode("utf-8", errors="replace")
    soup = BeautifulSoup(html_text, "html.parser")
    source_dir = source_path.parent if source_path else None
    cover_asset = book.generated_assets.filter(asset_type=GeneratedAssetType.COVER).first()
    cover_path = local_asset_path(cover_asset)
    updated = normalize_preview_book_sections(soup, dedication_html=book.dedication_html)

    for image_tag in soup.find_all("img"):
        src = (image_tag.get("src") or "").strip()
        if not is_local_preview_src(src):
            continue
        resolved_path = resolve_preview_image_path(source_dir, src, image_tag, cover_path=cover_path)
        if resolved_path is None:
            continue
        image_tag["src"] = build_data_uri(resolved_path)
        updated = True

    return soup.decode() if updated else html_text


def replace_tag_contents(tag, html_fragment):
    tag.clear()
    fragment = BeautifulSoup(html_fragment, "html.parser")
    container = fragment.body if fragment.body else fragment
    for child in list(container.contents):
        tag.append(child)


def build_book_info_section(html_fragment):
    fragment = BeautifulSoup(
        f"""
        <div class="book-info-section">
          <h2 class="book-info-title">বই তথ্য</h2>
          <div class="book-info-content">{html_fragment}</div>
        </div>
        """,
        "html.parser",
    )
    return fragment.find("div", class_="book-info-section")


def build_dedication_section(html_fragment):
    fragment = BeautifulSoup(
        f"""
        <div class="dedication-section">
          <h2 class="dedication-title">উৎসর্গ</h2>
          <div class="dedication-content">{html_fragment}</div>
        </div>
        """,
        "html.parser",
    )
    return fragment.find("div", class_="dedication-section")


def normalize_preview_book_sections(soup, dedication_html=""):
    main_content = soup.find("div", class_="main-content")
    container = soup.find("div", class_="container")
    insertion_anchor = main_content or soup.find("div", class_="toc-section")

    updated = False
    if main_content is not None:
        book_info_content = soup.find("div", class_="book-info-content")
        current_book_info_html = book_info_content.decode_contents() if book_info_content else ""
        current_main_content_html = main_content.decode_contents()
        promoted_book_info_html, cleaned_main_content_html = promote_leading_front_matter(
            current_book_info_html,
            current_main_content_html,
        )

        if cleaned_main_content_html != current_main_content_html:
            replace_tag_contents(main_content, cleaned_main_content_html)
            updated = True

        if promoted_book_info_html and promoted_book_info_html != current_book_info_html:
            if book_info_content is None:
                main_content.insert_before(build_book_info_section(promoted_book_info_html))
            else:
                replace_tag_contents(book_info_content, promoted_book_info_html)
            updated = True

    raw_book_dedication_html = (dedication_html or "").strip()
    dedication_content = soup.find("div", class_="dedication-content")
    if dedication_content is not None:
        current_dedication_html = dedication_content.decode_contents()
        cleaned_dedication_html = clean_extracted_dedication_html(current_dedication_html)
        if cleaned_dedication_html:
            if cleaned_dedication_html != current_dedication_html:
                replace_tag_contents(dedication_content, cleaned_dedication_html)
                updated = True
        elif raw_book_dedication_html:
            replace_tag_contents(dedication_content, raw_book_dedication_html)
            updated = True
    elif raw_book_dedication_html:
        dedication_section = build_dedication_section(raw_book_dedication_html)
        if insertion_anchor is not None:
            insertion_anchor.insert_before(dedication_section)
            updated = True
        elif container is not None:
            container.append(dedication_section)
            updated = True
        elif soup.body is not None:
            soup.body.append(dedication_section)
            updated = True

    return updated


def html_asset_response(book, asset):
    html = normalize_preview_html(book, asset)
    return HttpResponse(html, content_type=asset.content_type or "text/html")


class PermissionGrantListCreateView(generics.ListCreateAPIView):
    permission_classes = [IsSuperAdmin]
    serializer_class = PermissionGrantSerializer
    queryset = PermissionGrant.objects.select_related("user", "book", "category", "contributor").all()

    def perform_create(self, serializer):
        if serializer.validated_data.get("user") == self.request.user:
            raise PermissionDenied("You cannot change your own scoped access rules.")
        serializer.save(granted_by=self.request.user)


class PermissionGrantDetailView(generics.DestroyAPIView):
    permission_classes = [IsSuperAdmin]
    serializer_class = PermissionGrantSerializer
    queryset = PermissionGrant.objects.select_related("user", "book", "category", "contributor").all()

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.user_id == request.user.id:
            raise PermissionDenied("You cannot change your own scoped access rules.")
        return super().destroy(request, *args, **kwargs)


class AccessReferenceDataView(APIView):
    permission_classes = [IsSuperAdmin]

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
        categories = [
            {"id": category.id, "name": category.name, "slug": category.slug}
            for category in Category.objects.order_by("name")
        ]
        writers = [
            {"id": contributor.id, "name": contributor.name, "slug": contributor.slug}
            for contributor in Contributor.objects.filter(book_contributions__role=ContributorRole.AUTHOR)
            .distinct()
            .order_by("name")
        ]
        account_scopes = [{"value": scope.value, "label": scope.label} for scope in ACCOUNT_MANAGEABLE_PERMISSION_SCOPES]
        scoped_scopes = [{"value": scope.value, "label": scope.label} for scope in SCOPED_PERMISSION_SCOPES]
        return Response(
            {
                "users": users,
                "books": books,
                "categories": categories,
                "writers": writers,
                "account_scopes": account_scopes,
                "scoped_scopes": scoped_scopes,
            }
        )


class BookAssetDownloadView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, slug, asset_type):
        book = Book.objects.get(slug=slug)
        can_access = (
            user_can_view_book_cover(request.user, book)
            if asset_type == GeneratedAssetType.COVER
            else user_can_download_book_assets(request.user, book)
        )
        if not can_access:
            raise PermissionDenied("You do not have download access for this book.")

        asset = resolve_asset(book, asset_type)
        if not asset_is_available(asset):
            return missing_asset_response(book, asset, actor=request.user)
        if asset.asset_type == GeneratedAssetType.HTML:
            return html_asset_response(book, asset)
        file_handle = open_asset_stream(asset)
        filename = asset_download_filename(book, asset)
        as_attachment = asset.asset_type != GeneratedAssetType.HTML
        return FileResponse(file_handle, as_attachment=as_attachment, filename=filename)


class ReaderLaunchView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, slug):
        book = Book.objects.get(slug=slug)
        allowed = user_can_launch_reader(request.user, book)
        session = get_active_preview_session(request.user, book)
        if not allowed and session is None:
            raise PermissionDenied("You do not have reader access for this book.")

        if session is None:
            session = PreviewAccessSession.objects.create(user=request.user, book=book)

        session.launch_count += 1
        session.expires_at = default_preview_expiry()
        session.save(update_fields=["launch_count", "expires_at", "updated_at"])

        manifest_url = public_api_url("access-reader-manifest", kwargs={"token": session.token}, request=request)
        launch_url = f"{settings.FRONTEND_BASE_URL.rstrip('/')}/reader?manifest={quote(manifest_url, safe='')}"

        return Response(
            {
                "launch_url": launch_url,
                "manifest_url": manifest_url,
                "expires_at": session.expires_at,
            }
        )


class ReaderManifestView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, token):
        session = get_authenticated_token_preview_session(request, token)

        epub_asset = session.book.generated_assets.filter(asset_type=GeneratedAssetType.EPUB).first()
        html_asset = session.book.generated_assets.filter(asset_type=GeneratedAssetType.HTML).first()
        if epub_asset is None:
            raise Http404("EPUB asset is unavailable.")
        if not asset_is_available(epub_asset):
            return missing_asset_response(session.book, epub_asset, actor=session.user)

        reading_session = None
        bookmarks = []
        reading_session_url = ""
        bookmarks_url = ""
        if session.user_id:
            reading_session, _ = ReadingSession.objects.get_or_create(
                user=session.user,
                book=session.book,
                defaults={"preview_session": session},
            )
            bookmarks = Bookmark.objects.filter(user=session.user, book=session.book)
            reading_session_url = public_api_url("access-reader-session", kwargs={"token": session.token}, request=request)
            bookmarks_url = public_api_url("access-reader-bookmark-list", kwargs={"token": session.token}, request=request)

        response = Response(
            {
                "book": {
                    "title": session.book.title,
                    "slug": session.book.slug,
                },
                "epub_download_url": public_api_url("access-reader-epub", kwargs={"token": session.token}, request=request),
                "html_preview_url": public_api_url("access-reader-html", kwargs={"token": session.token}, request=request)
                if html_asset and asset_is_available(html_asset)
                else "",
                "reading_session_url": reading_session_url,
                "bookmarks_url": bookmarks_url,
                "reading_session": ReadingSessionSerializer(reading_session).data if reading_session else None,
                "bookmarks": BookmarkSerializer(bookmarks, many=True).data if bookmarks else [],
            }
        )
        return apply_no_store_headers(response)


class ReaderEpubDownloadView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, token, asset_path=""):
        session = get_authenticated_token_preview_session(request, token)

        asset = resolve_asset(session.book, GeneratedAssetType.EPUB)
        if not asset_is_available(asset):
            return missing_asset_response(session.book, asset, actor=session.user)

        if asset_path:
            normalized_path = self.normalize_epub_asset_path(asset_path)
            return self.epub_entry_response(asset, normalized_path)

        file_handle = open_asset_stream(asset)
        filename = asset_download_filename(session.book, asset)
        response = FileResponse(file_handle, as_attachment=False, filename=filename)
        return apply_no_store_headers(response)

    def normalize_epub_asset_path(self, raw_path):
        decoded = unquote(raw_path or "")
        sanitized = decoded.replace("\\", "/").lstrip("/")
        if not sanitized or ".." in sanitized.split("/"):
            raise Http404("Invalid EPUB resource path.")
        return sanitized

    def epub_entry_response(self, asset, entry_path):
        payload, _name, local_path = read_asset_bytes(asset)

        try:
            if local_path:
                with zipfile.ZipFile(local_path, "r") as archive:
                    data = archive.read(entry_path)
            else:
                with zipfile.ZipFile(BytesIO(payload), "r") as archive:
                    data = archive.read(entry_path)
        except KeyError:
            raise Http404("EPUB resource not found.")
        except zipfile.BadZipFile:
            raise Http404("EPUB file is invalid.")

        content_type = mimetypes.guess_type(entry_path)[0] or "application/octet-stream"
        response = HttpResponse(data, content_type=content_type)
        return apply_no_store_headers(response)


class ReaderHtmlPreviewView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, token):
        session = get_authenticated_token_preview_session(request, token)

        asset = resolve_asset(session.book, GeneratedAssetType.HTML)
        if not asset_is_available(asset):
            return missing_asset_response(session.book, asset, actor=session.user)
        response = html_asset_response(session.book, asset)
        return apply_no_store_headers(response)


class ReaderSessionTokenView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, token):
        session = get_authenticated_token_preview_session(request, token)
        if session.user_id is None:
            raise PermissionDenied("Reader progress is unavailable for guest sessions.")
        reading_session, _ = ReadingSession.objects.get_or_create(
            user=session.user,
            book=session.book,
            defaults={"preview_session": session},
        )
        response = Response(ReadingSessionSerializer(reading_session).data)
        return apply_no_store_headers(response)

    def post(self, request, token):
        session = get_authenticated_token_preview_session(request, token)
        if session.user_id is None:
            raise PermissionDenied("Reader progress is unavailable for guest sessions.")
        reading_session, _ = ReadingSession.objects.get_or_create(
            user=session.user,
            book=session.book,
            defaults={"preview_session": session},
        )
        serializer = ReadingSessionSerializer(reading_session, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save(user=session.user, book=session.book, preview_session=session)
        response = Response(serializer.data)
        return apply_no_store_headers(response)


class ReaderBookmarkTokenListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, token):
        session = get_authenticated_token_preview_session(request, token)
        if session.user_id is None:
            raise PermissionDenied("Bookmarks are unavailable for guest sessions.")
        queryset = Bookmark.objects.filter(user=session.user, book=session.book)
        response = Response(BookmarkSerializer(queryset, many=True).data)
        return apply_no_store_headers(response)

    def post(self, request, token):
        session = get_authenticated_token_preview_session(request, token)
        if session.user_id is None:
            raise PermissionDenied("Bookmarks are unavailable for guest sessions.")
        serializer = BookmarkSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(user=session.user, book=session.book)
        response = Response(serializer.data, status=status.HTTP_201_CREATED)
        return apply_no_store_headers(response)


class ReaderBookmarkTokenDeleteView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, token, pk):
        session = get_authenticated_token_preview_session(request, token)
        if session.user_id is None:
            raise PermissionDenied("Bookmarks are unavailable for guest sessions.")
        bookmark = Bookmark.objects.filter(pk=pk, user=session.user, book=session.book).first()
        if bookmark is None:
            raise Http404("Bookmark not found.")
        bookmark.delete()
        response = Response(status=status.HTTP_204_NO_CONTENT)
        return apply_no_store_headers(response)


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
