from pathlib import Path
from urllib.parse import quote

import pytest
from bs4 import BeautifulSoup
from django.core.files.base import ContentFile

from apps.access.models import PermissionGrant, PermissionScope, PreviewAccessSession
from apps.accounts.models import User
from apps.catalog.models import (
    Book,
    BookCategory,
    BookContributor,
    Category,
    Contributor,
    ContributorRole,
    GeneratedAsset,
    GeneratedAssetStatus,
    GeneratedAssetType,
)
from apps.common.permissions import user_has_scope
from apps.ingestion.models import BookSubmission, ResolutionStatus, SubmissionStatus
from apps.access.views import normalize_preview_book_sections


def assert_content_disposition_filename(header_value, expected_filename):
    assert (
        f'filename="{expected_filename}"' in header_value
        or f"filename*=utf-8''{quote(expected_filename)}" in header_value
    )


@pytest.mark.django_db
def test_download_and_reader_launch_are_protected(tmp_path, client):
    user = User.objects.create_user(email="access@example.com", password="strong-password-123")
    book = Book.objects.create(title="Access Book", state="ready", review_state="approved")
    epub_path = Path(tmp_path) / "access-book.epub"
    html_path = Path(tmp_path) / "book.html"
    epub_path.write_bytes(b"epub")
    html_path.write_text("<html></html>", encoding="utf-8")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.HTML,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(html_path),
        content_type="text/html",
        file_size=html_path.stat().st_size,
    )

    client.force_login(user)
    denied = client.get(f"/api/access/books/{book.slug}/download/epub/")
    assert denied.status_code == 403

    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.DOWNLOAD_FILE)
    allowed = client.get(f"/api/access/books/{book.slug}/download/epub/")
    assert allowed.status_code == 200
    assert_content_disposition_filename(allowed.headers["Content-Disposition"], "Access Book.epub")

    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.PREVIEW_READ_ONCE)
    launch = client.post(f"/api/access/books/{book.slug}/reader-launch/")
    assert launch.status_code == 200

    manifest_url = launch.json()["manifest_url"]
    manifest_path = manifest_url.replace("http://testserver", "")
    manifest = client.get(manifest_path)
    assert manifest.status_code == 200
    assert manifest.json()["book"]["slug"] == book.slug
    assert manifest.json()["reading_session_url"]
    assert manifest.json()["bookmarks_url"]


@pytest.mark.django_db
def test_book_owner_can_access_cover_downloads_and_reader_without_explicit_grants(tmp_path, client):
    user = User.objects.create_user(email="owner-access@example.com", password="strong-password-123")
    book = Book.objects.create(title="Owned Book", state="ready", review_state="approved")
    cover_path = Path(tmp_path) / "book_cover.jpg"
    html_path = Path(tmp_path) / "book.html"
    epub_path = Path(tmp_path) / "owned-book.epub"
    cover_path.write_bytes(b"cover")
    html_path.write_text("<html></html>", encoding="utf-8")
    epub_path.write_bytes(b"epub")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.COVER,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(cover_path),
        content_type="image/jpeg",
        file_size=cover_path.stat().st_size,
    )
    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.HTML,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(html_path),
        content_type="text/html",
        file_size=html_path.stat().st_size,
    )
    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/owned-book/",
        normalized_input="https://www.ebanglalibrary.com/books/owned-book/",
        resolved_url="https://www.ebanglalibrary.com/books/owned-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.READY,
        linked_book=book,
    )

    client.force_login(user)

    list_response = client.get("/api/catalog/books/?ownership=mine")
    assert list_response.status_code == 200
    assert list_response.json()[0]["cover_download_url"].endswith(f"/api/access/books/{book.slug}/download/cover/")

    detail_response = client.get(f"/api/catalog/books/{book.slug}/")
    assert detail_response.status_code == 200
    asset_urls = {asset["asset_type"]: asset["download_url"] for asset in detail_response.json()["assets"]}
    assert asset_urls["cover"].endswith(f"/api/access/books/{book.slug}/download/cover/")
    assert asset_urls["html"].endswith(f"/api/access/books/{book.slug}/download/html/")
    assert asset_urls["epub"].endswith(f"/api/access/books/{book.slug}/download/epub/")

    cover_response = client.get(f"/api/access/books/{book.slug}/download/cover/")
    html_response = client.get(f"/api/access/books/{book.slug}/download/html/")
    epub_response = client.get(f"/api/access/books/{book.slug}/download/epub/")
    assert cover_response.status_code == 200
    assert html_response.status_code == 200
    assert epub_response.status_code == 200

    launch = client.post(f"/api/access/books/{book.slug}/reader-launch/")
    assert launch.status_code == 200


@pytest.mark.django_db
def test_download_uses_current_book_title_for_cover_and_epub_filenames(tmp_path, client):
    user = User.objects.create_user(email="filename-access@example.com", password="strong-password-123")
    book = Book.objects.create(title="বর্তমান বই নাম", state="ready", review_state="approved")
    epub_path = Path(tmp_path) / "মযলস.epub"
    cover_path = Path(tmp_path) / "book_cover.jpg"
    epub_path.write_bytes(b"epub")
    cover_path.write_bytes(b"cover")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.COVER,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(cover_path),
        content_type="image/jpeg",
        file_size=cover_path.stat().st_size,
    )

    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.DOWNLOAD_FILE)
    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.PREVIEW_READ_ONCE)
    client.force_login(user)

    epub_response = client.get(f"/api/access/books/{book.slug}/download/epub/")
    cover_response = client.get(f"/api/access/books/{book.slug}/download/cover/")
    assert epub_response.status_code == 200
    assert cover_response.status_code == 200
    assert_content_disposition_filename(epub_response.headers["Content-Disposition"], "বর্তমান বই নাম.epub")
    assert_content_disposition_filename(cover_response.headers["Content-Disposition"], "বর্তমান বই নাম.jpg")

    launch = client.post(f"/api/access/books/{book.slug}/reader-launch/")
    manifest_path = launch.json()["manifest_url"].replace("http://testserver", "")
    manifest = client.get(manifest_path)
    reader_epub_path = manifest.json()["epub_download_url"].replace("http://testserver", "")
    reader_epub_response = client.get(reader_epub_path)
    assert reader_epub_response.status_code == 200
    assert_content_disposition_filename(reader_epub_response.headers["Content-Disposition"], "বর্তমান বই নাম.epub")


@pytest.mark.django_db
def test_html_download_inlines_stale_relative_cover_references(tmp_path, client):
    user = User.objects.create_user(email="html-download@example.com", password="strong-password-123")
    book = Book.objects.create(title="HTML Download Book", state="ready", review_state="approved")
    html_path = Path(tmp_path) / "book.html"
    cover_path = Path(tmp_path) / "book_cover.jpg"
    html_path.write_text(
        "<!DOCTYPE html><html><body><img src='book_image.hpg' alt='Book Cover' class='cover-image'></body></html>",
        encoding="utf-8",
    )
    cover_path.write_bytes(b"cover-bytes")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.HTML,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(html_path),
        content_type="text/html",
        file_size=html_path.stat().st_size,
    )
    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.COVER,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(cover_path),
        content_type="image/jpeg",
        file_size=cover_path.stat().st_size,
    )

    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.DOWNLOAD_FILE)
    client.force_login(user)

    response = client.get(f"/api/access/books/{book.slug}/download/html/")

    assert response.status_code == 200
    body = response.content.decode("utf-8")
    assert "data:image/jpeg;base64," in body
    assert "book_image.hpg" not in body
