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


def test_normalize_preview_book_sections_cleans_redundant_dedication_heading():
        soup = BeautifulSoup(
                """
                <html>
                    <body>
                        <div class='dedication-section'>
                            <h2 class='dedication-title'>উৎসর্গ</h2>
                            <div class='dedication-content'>
                                <p>উৎসর্গ</p>
                                <p><strong>উৎসর্গ :</strong></p>
                                <p>পাঠক, আপনাকে…</p>
                            </div>
                        </div>
                        <div class='main-content'>
                            <p>এটাই মূল কনটেন্ট।</p>
                        </div>
                    </body>
                </html>
                """,
                "html.parser",
        )

        updated = normalize_preview_book_sections(soup)

        assert updated is True
        dedication_content = soup.find("div", class_="dedication-content")
        assert dedication_content is not None
        dedication_text = dedication_content.get_text(" ", strip=True)
        assert dedication_text == "পাঠক, আপনাকে…"


def test_normalize_preview_book_sections_inserts_dedication_from_book_data_when_missing():
        soup = BeautifulSoup(
                """
                <html>
                    <body>
                        <div class='main-content'>
                            <p>এটাই মূল কনটেন্ট।</p>
                        </div>
                    </body>
                </html>
                """,
                "html.parser",
        )

        updated = normalize_preview_book_sections(
                soup,
            dedication_html="<p>উৎসর্গ : পাঠক, আপনাকে…</p>",
        )

        assert updated is True
        dedication_content = soup.find("div", class_="dedication-content")
        assert dedication_content is not None
        dedication_text = dedication_content.get_text(" ", strip=True)
        assert dedication_text == "উৎসর্গ : পাঠক, আপনাকে…"


def test_normalize_preview_book_sections_inserts_dedication_without_main_content():
        soup = BeautifulSoup(
                """
                <html>
                    <body>
                        <div class='container'>
                            <div class='book-header'></div>
                            <div class='toc-section'></div>
                        </div>
                    </body>
                </html>
                """,
                "html.parser",
        )

        updated = normalize_preview_book_sections(
                soup,
            dedication_html="<p>উৎসর্গ : পাঠক, আপনাকে…</p>",
        )

        assert updated is True
        dedication_section = soup.find("div", class_="dedication-section")
        assert dedication_section is not None
        dedication_content = dedication_section.find("div", class_="dedication-content")
        assert dedication_content is not None
        dedication_text = dedication_content.get_text(" ", strip=True)
        assert dedication_text == "উৎসর্গ : পাঠক, আপনাকে…"


@pytest.mark.django_db
def test_missing_stored_asset_returns_404_and_marks_asset_failed(client):
    user = User.objects.create_user(email="missing-asset@example.com", password="strong-password-123")
    book = Book.objects.create(title="Missing Asset Book", state="ready", review_state="approved")
    asset = GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.COVER,
        status=GeneratedAssetStatus.READY,
        content_type="image/jpeg",
    )
    asset.file.save("book_cover.jpg", ContentFile(b"cover-bytes"), save=True)
    broken_path = Path(asset.file.path)
    broken_path.unlink()

    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.PREVIEW_READ_ONCE)
    client.force_login(user)

    response = client.get(f"/api/access/books/{book.slug}/download/cover/")

    assert response.status_code == 404
    assert response.json()["detail"] == "This file is no longer available in storage. Please regenerate the book."

    asset.refresh_from_db()
    book.refresh_from_db()
    assert asset.status == GeneratedAssetStatus.FAILED
    assert asset.file.name == ""
    assert book.state == "needs_review"
    assert book.review_state == "needs_review"


@pytest.mark.django_db
def test_reader_state_requires_reader_access(tmp_path, client):
    user = User.objects.create_user(email="reader-state@example.com", password="strong-password-123")
    book = Book.objects.create(title="Reader State Book", state="ready", review_state="approved")
    client.force_login(user)

    denied_session = client.get(f"/api/access/books/{book.slug}/reading-session/")
    denied_bookmarks = client.get(f"/api/access/books/{book.slug}/bookmarks/")
    assert denied_session.status_code == 403
    assert denied_bookmarks.status_code == 403

    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.READ_DURABLE)

    allowed_session = client.post(
        f"/api/access/books/{book.slug}/reading-session/",
        data={"last_location": "chapter-1", "progress_percent": 12},
    )
    assert allowed_session.status_code == 200

    bookmark = client.post(
        f"/api/access/books/{book.slug}/bookmarks/",
        data={"location": "chapter-1", "label": "Start", "note": "Important"},
    )
    assert bookmark.status_code == 201


@pytest.mark.django_db
def test_reader_html_preview_inlines_stale_relative_cover_references(tmp_path, client):
    book = Book.objects.create(title="HTML Preview Book", state="ready", review_state="approved")
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
    session = PreviewAccessSession.objects.create(book=book)

    response = client.get(f"/api/access/reader/{session.token}/html/")

    assert response.status_code == 200
    body = response.content.decode("utf-8")
    assert "data:image/jpeg;base64," in body
    assert "book_image.hpg" not in body


@pytest.mark.django_db
def test_reader_html_preview_promotes_leading_front_matter_from_main_content(tmp_path, client):
    book = Book.objects.create(title="HTML Front Matter Book", state="ready", review_state="approved")
    html_path = Path(tmp_path) / "book.html"
    html_path.write_text(
        """
        <!DOCTYPE html>
        <html>
          <body>
            <div class="container">
              <div class="main-content">
                <h2 class="wp-block-heading">ম্যালিস – কিয়েগো হিগাশিনো</h2>
                <p><strong>ম্যালিস – কিয়েগো হিগাশিনো</strong><br/>অনুবাদ: সালমান হক, ইশরাক অর্ণব</p>
                <p>প্রথম প্রকাশ: মার্চ ২০২৩</p>
                <p><strong>ভূমিকা</strong></p>
                <p>এটাই মূল কনটেন্ট।</p>
              </div>
            </div>
          </body>
        </html>
        """,
        encoding="utf-8",
    )

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.HTML,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(html_path),
        content_type="text/html",
        file_size=html_path.stat().st_size,
    )
    session = PreviewAccessSession.objects.create(book=book)

    response = client.get(f"/api/access/reader/{session.token}/html/")

    assert response.status_code == 200
    body = response.content.decode("utf-8")
    assert "book-info-section" in body
    assert "অনুবাদ: সালমান হক, ইশরাক অর্ণব" in body
    assert "প্রথম প্রকাশ: মার্চ ২০২৩" in body
    main_content_fragment = body.split('<div class="main-content">', 1)[1]
    assert "অনুবাদ: সালমান হক, ইশরাক অর্ণব" not in main_content_fragment
    assert "প্রথম প্রকাশ: মার্চ ২০২৩" not in main_content_fragment


@pytest.mark.django_db
def test_only_superadmin_can_manage_grants(client):
    superadmin = User.objects.create_superuser(email="superadmin@example.com", password="strong-password-123")
    manager = User.objects.create_user(email="grant-manager@example.com", password="strong-password-123")
    target = User.objects.create_user(email="target@example.com", password="strong-password-123")
    book = Book.objects.create(title="Grant Scope Book", state="ready", review_state="approved")
    client.force_login(manager)

    denied = client.get("/api/access/references/")
    assert denied.status_code == 403

    client.force_login(superadmin)
    references = client.get("/api/access/references/")
    assert references.status_code == 200
    reference_payload = references.json()
    assert "account_scopes" in reference_payload
    assert "scoped_scopes" in reference_payload
    assert "admin:full_control" not in {scope["value"] for scope in reference_payload["account_scopes"]}
    assert "access:manage" not in {scope["value"] for scope in reference_payload["scoped_scopes"]}

    created = client.post(
        "/api/access/grants/",
        data={
            "user": str(target.id),
            "book": str(book.id),
            "scope": PermissionScope.DOWNLOAD_FILE,
            "notes": "Scoped by grant manager",
        },
    )
    assert created.status_code == 201

    deleted = client.delete(f"/api/access/grants/{created.json()['id']}/")
    assert deleted.status_code == 204


@pytest.mark.django_db
def test_superadmin_cannot_create_or_delete_own_scoped_access_grants(client):
    superadmin = User.objects.create_superuser(email="self-grant-block@example.com", password="strong-password-123")
    other_user = User.objects.create_user(email="self-grant-other@example.com", password="strong-password-123")
    book = Book.objects.create(title="Self Grant Scope Book", state="ready", review_state="approved")
    client.force_login(superadmin)

    create_self = client.post(
        "/api/access/grants/",
        data={
            "user": str(superadmin.id),
            "book": str(book.id),
            "scope": PermissionScope.DOWNLOAD_FILE,
            "notes": "Should be blocked",
        },
    )
    assert create_self.status_code == 403

    created_other = client.post(
        "/api/access/grants/",
        data={
            "user": str(other_user.id),
            "book": str(book.id),
            "scope": PermissionScope.DOWNLOAD_FILE,
            "notes": "Allowed",
        },
    )
    assert created_other.status_code == 201

    grant_id = created_other.json()["id"]
    grant = PermissionGrant.objects.get(pk=grant_id)
    grant.user = superadmin
    grant.save(update_fields=["user", "updated_at"])

    delete_self = client.delete(f"/api/access/grants/{grant_id}/")
    assert delete_self.status_code == 403


@pytest.mark.django_db
def test_category_and_writer_scoped_permissions_apply_to_matching_books():
    user = User.objects.create_user(email="scoped@example.com", password="strong-password-123")
    category = Category.objects.create(name="Thriller")
    writer = Contributor.objects.create(name="Writer One")
    category_book = Book.objects.create(title="Category Book", state="ready", review_state="approved")
    writer_book = Book.objects.create(title="Writer Book", state="ready", review_state="approved")
    other_book = Book.objects.create(title="Other Book", state="ready", review_state="approved")

    BookCategory.objects.create(book=category_book, category=category)
    BookContributor.objects.create(book=writer_book, contributor=writer, role=ContributorRole.AUTHOR)

    PermissionGrant.objects.create(user=user, category=category, scope=PermissionScope.DOWNLOAD_FILE)
    PermissionGrant.objects.create(user=user, contributor=writer, scope=PermissionScope.READ_DURABLE)

    assert user_has_scope(user, [PermissionScope.DOWNLOAD_FILE], book=category_book) is True
    assert user_has_scope(user, [PermissionScope.DOWNLOAD_FILE], book=other_book) is False
    assert user_has_scope(user, [PermissionScope.READ_DURABLE], book=writer_book) is True
    assert user_has_scope(user, [PermissionScope.READ_DURABLE], book=category_book) is False


@pytest.mark.django_db
def test_catalog_endpoints_require_authentication(client):
    book = Book.objects.create(title="Private Catalog Book", state="ready", review_state="approved")

    list_response = client.get("/api/catalog/books/")
    detail_response = client.get(f"/api/catalog/books/{book.slug}/")

    assert list_response.status_code == 403
    assert detail_response.status_code == 403


@pytest.mark.django_db
def test_reader_token_state_and_bookmark_endpoints_work(tmp_path, client):
    user = User.objects.create_user(email="token-reader@example.com", password="strong-password-123")
    book = Book.objects.create(title="Token Reader Book", state="ready", review_state="approved")
    epub_path = Path(tmp_path) / "token-reader.epub"
    epub_path.write_bytes(b"epub")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )

    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.PREVIEW_READ_ONCE)
    client.force_login(user)
    launch = client.post(f"/api/access/books/{book.slug}/reader-launch/")
    assert launch.status_code == 200

    manifest_path = launch.json()["manifest_url"].replace("http://testserver", "")
    manifest = client.get(manifest_path)
    assert manifest.status_code == 200
    payload = manifest.json()

    session_get = client.get(payload["reading_session_url"].replace("http://testserver", ""))
    assert session_get.status_code == 200

    session_post = client.post(
        payload["reading_session_url"].replace("http://testserver", ""),
        data={"last_location": "chapter-2", "progress_percent": 47},
    )
    assert session_post.status_code == 200
    assert session_post.json()["last_location"] == "chapter-2"

    bookmark_post = client.post(
        payload["bookmarks_url"].replace("http://testserver", ""),
        data={"location": "chapter-2", "label": "Keep", "note": "Token bookmark"},
    )
    assert bookmark_post.status_code == 201

    bookmark_list = client.get(payload["bookmarks_url"].replace("http://testserver", ""))
    assert bookmark_list.status_code == 200
    assert len(bookmark_list.json()) == 1

    delete_url = f"/api/access/reader/{manifest_path.split('/reader/')[1].split('/manifest/')[0]}/bookmarks/{bookmark_post.json()['id']}/"
    deleted = client.delete(delete_url)
    assert deleted.status_code == 204
