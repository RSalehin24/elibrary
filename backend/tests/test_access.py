from pathlib import Path

import pytest

from apps.access.models import PermissionGrant, PermissionScope
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
