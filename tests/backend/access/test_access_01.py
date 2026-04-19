from pathlib import Path
from smtplib import SMTPAuthenticationError
from urllib.parse import quote

import pytest
from bs4 import BeautifulSoup
from django.core import mail
from django.core.files.base import ContentFile
from django.test import override_settings

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
@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    ACCOUNT_INVITE_FROM_EMAIL="kindle-sender@example.com",
)
def test_book_can_be_sent_to_all_configured_kindle_emails(tmp_path, client):
    user = User.objects.create_user(
        email="kindle-reader@example.com",
        password="strong-password-123",
        kindle_emails=["reader-one@kindle.com", "reader-two@kindle.com"],
    )
    book = Book.objects.create(title="Kindle Delivery Book", state="ready", review_state="approved")
    epub_path = Path(tmp_path) / "kindle-delivery.epub"
    epub_path.write_bytes(b"epub")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.DOWNLOAD_FILE)
    client.force_login(user)

    response = client.post(f"/api/access/books/{book.slug}/send-to-kindle/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["deliveredEmails"] == user.kindle_emails
    assert payload["failedEmails"] == []
    assert payload["senderEmail"] == "kindle-sender@example.com"
    assert len(mail.outbox) == 2
    assert {message.to[0] for message in mail.outbox} == set(user.kindle_emails)
    assert all(message.from_email == "kindle-sender@example.com" for message in mail.outbox)
    assert all(message.body == "" for message in mail.outbox)
    assert all(message.attachments[0][0] == "Kindle Delivery Book.epub" for message in mail.outbox)


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="anymail.backends.brevo.EmailBackend",
    EMAIL_HOST="smtp.example.com",
    EMAIL_PORT=587,
    ACCOUNT_INVITE_FROM_EMAIL="kindle-sender@example.com",
)
def test_send_to_kindle_falls_back_to_smtp_when_primary_backend_is_brevo(tmp_path, client, monkeypatch):
    selected_backends = []
    closed_connections = []

    class DummyConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def close(self):
            closed_connections.append(True)

    def fake_get_connection(*args, **kwargs):
        selected_backends.append(kwargs.get("backend"))
        return DummyConnection()

    sent_bodies = []

    def fake_send(self, fail_silently=False):
        sent_bodies.append(self.body)
        return 1

    monkeypatch.setattr("apps.access.views.assets.get_connection", fake_get_connection)
    monkeypatch.setattr("django.core.mail.message.EmailMessage.send", fake_send)

    user = User.objects.create_user(
        email="kindle-reader-brevo@example.com",
        password="strong-password-123",
        kindle_emails=["reader-one@kindle.com"],
    )
    book = Book.objects.create(title="Kindle Brevo Fallback", state="ready", review_state="approved")
    epub_path = Path(tmp_path) / "kindle-brevo-fallback.epub"
    epub_path.write_bytes(b"epub")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.DOWNLOAD_FILE)
    client.force_login(user)

    response = client.post(f"/api/access/books/{book.slug}/send-to-kindle/")

    assert response.status_code == 200
    assert selected_backends == ["django.core.mail.backends.smtp.EmailBackend"]
    assert sent_bodies == [""]
    assert closed_connections == [True]


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="anymail.backends.brevo.EmailBackend",
    EMAIL_HOST="smtp-relay.brevo.com",
    EMAIL_PORT=587,
    EMAIL_HOST_USER="library@example.com",
    EMAIL_HOST_PASSWORD="smtp-key",
    EMAIL_USE_TLS=True,
    ACCOUNT_INVITE_FROM_EMAIL="kindle-sender@example.com",
)
def test_send_to_kindle_uses_configured_smtp_credentials_for_brevo_backend(
    tmp_path, client, monkeypatch
):
    selected_connection_kwargs = []
    closed_connections = []

    class DummyConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def close(self):
            closed_connections.append(True)

    def fake_get_connection(*args, **kwargs):
        selected_connection_kwargs.append(kwargs)
        return DummyConnection()

    monkeypatch.setattr("apps.access.views.assets.get_connection", fake_get_connection)
    monkeypatch.setattr("django.core.mail.message.EmailMessage.send", lambda self, fail_silently=False: 1)

    user = User.objects.create_user(
        email="kindle-reader-brevo-smtp-defaults@example.com",
        password="strong-password-123",
        kindle_emails=["reader-one@kindle.com"],
    )
    book = Book.objects.create(title="Kindle Brevo SMTP Defaults", state="ready", review_state="approved")
    epub_path = Path(tmp_path) / "kindle-brevo-smtp-defaults.epub"
    epub_path.write_bytes(b"epub")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.DOWNLOAD_FILE)
    client.force_login(user)

    response = client.post(f"/api/access/books/{book.slug}/send-to-kindle/")

    assert response.status_code == 200
    assert len(selected_connection_kwargs) == 1
    connection_kwargs = selected_connection_kwargs[0]
    assert connection_kwargs["backend"] == "django.core.mail.backends.smtp.EmailBackend"
    assert connection_kwargs["host"] == "smtp-relay.brevo.com"
    assert connection_kwargs["port"] == 587
    assert connection_kwargs["username"] == "library@example.com"
    assert connection_kwargs["password"] == "smtp-key"
    assert connection_kwargs["use_tls"] is True
    assert closed_connections == [True]


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="anymail.backends.brevo.EmailBackend",
    EMAIL_HOST="",
    EMAIL_PORT=587,
    EMAIL_HOST_USER="library@example.com",
    EMAIL_HOST_PASSWORD="",
    EMAIL_USE_TLS=True,
    ACCOUNT_INVITE_FROM_EMAIL="kindle-sender@example.com",
)
def test_send_to_kindle_returns_502_when_smtp_config_is_missing(tmp_path, client):
    user = User.objects.create_user(
        email="kindle-reader-missing-smtp@example.com",
        password="strong-password-123",
        kindle_emails=["reader-one@kindle.com"],
    )
    book = Book.objects.create(title="Kindle Missing SMTP Host", state="ready", review_state="approved")
    epub_path = Path(tmp_path) / "kindle-missing-smtp.epub"
    epub_path.write_bytes(b"epub")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.DOWNLOAD_FILE)
    client.force_login(user)

    response = client.post(f"/api/access/books/{book.slug}/send-to-kindle/")

    assert response.status_code == 502
    payload = response.json()
    assert "Kindle delivery requires SMTP" in payload["detail"]
    assert payload["failedEmails"] == ["reader-one@kindle.com"]
    assert payload["senderEmail"] == "kindle-sender@example.com"


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="anymail.backends.brevo.EmailBackend",
    EMAIL_HOST="smtp-relay.brevo.com",
    EMAIL_PORT=587,
    EMAIL_HOST_USER="library@example.com",
    EMAIL_HOST_PASSWORD="wrong-smtp-password",
    EMAIL_USE_TLS=True,
    ACCOUNT_INVITE_FROM_EMAIL="kindle-sender@example.com",
)
def test_send_to_kindle_returns_specific_502_when_smtp_authentication_fails(
    tmp_path, client, monkeypatch
):
    selected_connection_kwargs = []
    closed_connections = []

    class DummyConnection:
        def __init__(self, kwargs):
            self.kwargs = kwargs

        def close(self):
            closed_connections.append(
                (self.kwargs.get("username"), self.kwargs.get("password"))
            )

    def fake_get_connection(*args, **kwargs):
        selected_connection_kwargs.append(kwargs)
        return DummyConnection(kwargs)

    def fake_send(self, fail_silently=False):
        raise SMTPAuthenticationError(535, b"5.7.8 Authentication failed")

    monkeypatch.setattr("apps.access.views.assets.get_connection", fake_get_connection)
    monkeypatch.setattr("django.core.mail.message.EmailMessage.send", fake_send)

    user = User.objects.create_user(
        email="kindle-reader-brevo-auth-fail@example.com",
        password="strong-password-123",
        kindle_emails=["reader-one@kindle.com"],
    )
    book = Book.objects.create(
        title="Kindle Brevo SMTP Auth Failure",
        state="ready",
        review_state="approved",
    )
    epub_path = Path(tmp_path) / "kindle-brevo-auth-failure.epub"
    epub_path.write_bytes(b"epub")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.DOWNLOAD_FILE)
    client.force_login(user)

    response = client.post(f"/api/access/books/{book.slug}/send-to-kindle/")

    assert response.status_code == 502
    payload = response.json()
    assert "could not authenticate with Brevo SMTP" in payload["detail"]
    assert "API key will not work for SMTP" in payload["detail"]
    assert payload["failedEmails"] == ["reader-one@kindle.com"]
    assert len(selected_connection_kwargs) == 1
    assert selected_connection_kwargs[0]["username"] == "library@example.com"
    assert selected_connection_kwargs[0]["password"] == "wrong-smtp-password"
    assert closed_connections == [("library@example.com", "wrong-smtp-password")]


@pytest.mark.django_db
def test_send_to_kindle_ignores_invalid_legacy_domains(tmp_path, client):
    user = User.objects.create_user(
        email="kindle-reader-legacy@example.com",
        password="strong-password-123",
        kindle_emails=["reader-one@kindle.com", "reader-two@example.com"],
    )
    book = Book.objects.create(title="Kindle Delivery Legacy", state="ready", review_state="approved")
    epub_path = Path(tmp_path) / "kindle-delivery-legacy.epub"
    epub_path.write_bytes(b"epub")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.DOWNLOAD_FILE)
    client.force_login(user)

    response = client.post(f"/api/access/books/{book.slug}/send-to-kindle/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["deliveredEmails"] == ["reader-one@kindle.com"]
    assert payload["failedEmails"] == []
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == ["reader-one@kindle.com"]


@pytest.mark.django_db
def test_send_to_kindle_requires_configured_emails(tmp_path, client):
    user = User.objects.create_user(
        email="missing-kindle@example.com",
        password="strong-password-123",
    )
    book = Book.objects.create(title="Missing Kindle Config", state="ready", review_state="approved")
    epub_path = Path(tmp_path) / "missing-kindle.epub"
    epub_path.write_bytes(b"epub")

    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    PermissionGrant.objects.create(user=user, book=book, scope=PermissionScope.DOWNLOAD_FILE)
    client.force_login(user)

    response = client.post(f"/api/access/books/{book.slug}/send-to-kindle/")

    assert response.status_code == 400
    assert response.json()["detail"] == "Add at least one Kindle email in your profile before sending."


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
