import time as time_module
from datetime import time, timedelta
from pathlib import Path

import pytest
from django.utils import timezone

from apps.accounts.models import User
from apps.catalog.models import Book
from apps.ingestion.models import BookSubmission, ProcessingJob, SourceCatalogEntry
from apps.processing.models import (
    BookCreationRequest,
    BookRecord,
    ProcessingAutomationKind,
    ProcessingAutomationSettings,
)
from apps.processing.services import get_sync_state


def login_processing_admin(client, email="processing-admin@example.com"):
    user = User.objects.create_superuser(
        email=email,
        password="strong-password-123",
    )
    client.force_login(user)
    return user


def record_payload(record_id, **overrides):
    payload = {
        "id": record_id,
        "name": f"{record_id} title",
        "url": f"https://example.test/books/{record_id}",
        "category": "Fiction",
        "writer": "Writer One",
        "translator": "",
        "composer": "",
        "publisher": "Example Press",
        "updatedAt": timezone.now().isoformat(),
    }
    payload.update(overrides)
    return payload


@pytest.mark.django_db
def test_processing_sync_persists_records_and_reconciles_resume(client):
    login_processing_admin(client)
    BookRecord.objects.create(
        id="existing-record",
        name="Existing",
        url="https://example.test/books/existing",
        category="Old",
        writer="Writer",
        publisher="Press",
    )

    response = client.post(
        "/api/processing/sync/start/",
        {
            "remotePages": [
                [
                    record_payload(
                        "existing-record",
                        name="Existing Revised",
                        url="https://example.test/books/existing-revised",
                        category="Updated",
                        writer="Updated Writer",
                        translator="Updated Translator",
                        publisher="Updated Press",
                    )
                ],
                [
                    record_payload(
                        "new-record",
                        name="New Record",
                        category="Poetry",
                        writer="Remote Writer",
                        translator="Remote Translator",
                        publisher="Remote Press",
                    )
                ],
                [],
            ]
        },
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["updatedCount"] == 0
    assert BookRecord.objects.get(pk="existing-record").name == "Existing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["updatedCount"] == 1
    existing = BookRecord.objects.get(pk="existing-record")
    assert existing.name == "Existing Revised"
    assert existing.url == "https://example.test/books/existing-revised"
    assert existing.category == "Updated"
    assert existing.writer == "Updated Writer"
    assert existing.translator == "Updated Translator"
    assert existing.publisher == "Updated Press"

    response = client.post("/api/processing/sync/pause/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "pausing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["progress"]["savedData"]["nextPageIndex"] == 2
    assert payload["sync"]["updatedCount"] == 1
    assert payload["sync"]["appendedCount"] == 1
    new_record = BookRecord.objects.get(pk="new-record")
    assert new_record.name == "New Record"
    assert new_record.url == "https://example.test/books/new-record"
    assert new_record.category == "Poetry"
    assert new_record.writer == "Remote Writer"
    assert new_record.translator == "Remote Translator"
    assert new_record.publisher == "Remote Press"

    response = client.post("/api/processing/sync/resume/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    assert payload["sync"]["skippedCount"] == 2
    assert payload["sync"]["appendedCount"] == 1
    assert BookRecord.objects.filter(pk="new-record").exists()


@pytest.mark.django_db
def test_processing_sync_uses_persisted_source_catalog_when_no_remote_pages(client):
    login_processing_admin(client)
    entry = SourceCatalogEntry.objects.create(
        source_url="https://example.test/books/source-catalog-record",
        title="Source Catalog Record",
        author_line="Source Author",
        normalized_title="source catalog record",
        normalized_display="source catalog record source author",
        raw_data={"category": "Source Category", "publisher": "Source Publisher"},
    )

    response = client.post(
        "/api/processing/sync/start/",
        {},
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    record = BookRecord.objects.get(pk=str(entry.id))
    assert record.name == "Source Catalog Record"
    assert record.url == "https://example.test/books/source-catalog-record"
    assert record.category == "Source Category"
    assert record.writer == "Source Author"
    assert record.publisher == "Source Publisher"


@pytest.mark.django_db
def test_processing_state_returns_weekly_automation_defaults_without_placeholder(client):
    login_processing_admin(client)

    response = client.get("/api/processing/state/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["automation"]["catalog"]["interval"] == "weekly"
    assert payload["automation"]["catalog"]["time"] == "03:00:00"
    assert payload["automation"]["catalog"]["statusMessage"] == ""
    assert payload["automation"]["incomplete"]["interval"] == "weekly"
    assert payload["automation"]["incomplete"]["time"] == "03:00:00"
    assert payload["automation"]["incomplete"]["statusMessage"] == ""


@pytest.mark.django_db
def test_processing_state_exposes_decoded_bangla_display_urls(client):
    login_processing_admin(client)
    encoded_url = (
        "https://www.ebanglalibrary.com/books/"
        "%E0%A6%85%E0%A6%97%E0%A7%8D%E0%A6%A8%E0%A6%BF%E0%A6%AA%E0%A6%B0"
        "%E0%A7%80%E0%A6%95%E0%A7%8D%E0%A6%B7%E0%A6%BE-%E0%A6%86%E0%A6%B6"
        "%E0%A6%BE%E0%A6%AA%E0%A7%82%E0%A6%B0%E0%A7%8D%E0%A6%A3%E0%A6%BE/"
    )
    record = BookRecord.objects.create(
        id="bangla-link-record",
        name="অগ্নিপরীক্ষা",
        url=encoded_url,
        category="উপন্যাস",
        writer="আশাপূর্ণা দেবী",
        publisher="বাংলা লাইব্রেরি",
    )

    response = client.get("/api/processing/state/")

    assert response.status_code == 200
    payload = response.json()
    entry = next(item for item in payload["records"] if item["id"] == record.id)
    assert entry["url"] == encoded_url
    assert (
        entry["displayUrl"]
        == "https://www.ebanglalibrary.com/books/অগ্নিপরীক্ষা-আশাপূর্ণা/"
    )
    assert entry["displayPath"] == "books/অগ্নিপরীক্ষা-আশাপূর্ণা"


@pytest.mark.django_db
def test_processing_state_normalizes_legacy_automation_defaults(client):
    login_processing_admin(client)
    ProcessingAutomationSettings.objects.create(
        kind=ProcessingAutomationKind.CATALOG,
        enabled=False,
        interval="daily",
        time=time(2, 0),
        saved=False,
        status_message="Not configured.",
    )
    ProcessingAutomationSettings.objects.create(
        kind=ProcessingAutomationKind.INCOMPLETE,
        enabled=False,
        interval="daily",
        time=time(3, 0),
        saved=False,
        status_message="Not configured.",
    )

    response = client.get("/api/processing/state/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["automation"]["catalog"]["interval"] == "weekly"
    assert payload["automation"]["catalog"]["time"] == "03:00:00"
    assert payload["automation"]["catalog"]["statusMessage"] == ""
    assert payload["automation"]["incomplete"]["interval"] == "weekly"
    assert payload["automation"]["incomplete"]["time"] == "03:00:00"
    assert payload["automation"]["incomplete"]["statusMessage"] == ""

    catalog = ProcessingAutomationSettings.objects.get(
        kind=ProcessingAutomationKind.CATALOG
    )
    incomplete = ProcessingAutomationSettings.objects.get(
        kind=ProcessingAutomationKind.INCOMPLETE
    )
    assert catalog.interval == "weekly"
    assert catalog.time == time(3, 0)
    assert catalog.status_message == ""
    assert incomplete.interval == "weekly"
    assert incomplete.time == time(3, 0)
    assert incomplete.status_message == ""


@pytest.mark.django_db
def test_catalog_automation_reconciles_pending_remote_pages_before_creating_requests(client):
    login_processing_admin(client)
    BookRecord.objects.create(
        id="existing-record",
        name="Existing Record",
        url="https://example.test/books/existing-record",
        category="History",
        writer="Writer One",
        publisher="Example Press",
    )

    response = client.post(
        "/api/processing/sync/start/",
        {
            "remotePages": [
                [
                    record_payload(
                        "existing-record",
                        name="Existing Record Revised",
                        category="Updated",
                    )
                ],
                [record_payload("new-record", name="New Record", category="Poetry")],
                [],
            ]
        },
        content_type="application/json",
    )

    assert response.status_code == 200
    assert not BookRecord.objects.filter(pk="new-record").exists()

    response = client.post(
        "/api/processing/automation/catalog/run/",
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    assert BookRecord.objects.filter(pk="new-record").exists()
    assert BookRecord.objects.get(pk="existing-record").name == "Existing Record Revised"
    assert BookCreationRequest.objects.filter(
        book_record_id="existing-record",
        state="initial",
    ).exists()
    assert BookCreationRequest.objects.filter(
        book_record_id="new-record",
        state="initial",
    ).exists()
    assert payload["automation"]["catalog"]["statusMessage"] == "Created 2 requests."


@pytest.mark.django_db
def test_catalog_automation_can_pause_and_stop_active_sync(client):
    login_processing_admin(client)
    sync_state = get_sync_state()
    sync_state.remote_pages = [
        [record_payload("auto-page-1", name="Automation Page One")],
        [record_payload("auto-page-2", name="Automation Page Two")],
        [],
    ]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    response = client.post(
        "/api/processing/automation/catalog/run/",
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"

    response = client.post("/api/processing/sync/pause/", content_type="application/json")
    assert response.status_code == 200
    assert response.json()["sync"]["status"] == "pausing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["runMode"] == "catalog_automation"

    response = client.post("/api/processing/sync/stop/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    assert payload["sync"]["message"] == "Automated catalog sync stopped."
    assert payload["automation"]["catalog"]["statusMessage"] == "Automated catalog sync stopped."


@pytest.mark.django_db
def test_catalog_automation_ignores_incomplete_remote_pages_shape(client):
    login_processing_admin(client)
    entry = SourceCatalogEntry.objects.create(
        source_url="https://example.test/books/catalog-fallback-record",
        title="Catalog Fallback Record",
        author_line="Source Author",
        normalized_title="catalog fallback record",
        normalized_display="catalog fallback record source author",
        raw_data={"category": "Fallback Category", "publisher": "Source Publisher"},
    )
    sync_state = get_sync_state()
    sync_state.remote_pages = [["stale-incomplete-record"], []]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    response = client.post(
        "/api/processing/automation/catalog/run/",
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    assert BookRecord.objects.filter(pk=str(entry.id)).exists()
    assert BookCreationRequest.objects.filter(
        book_record_id=str(entry.id),
        state="initial",
    ).exists()
    assert payload["automation"]["catalog"]["statusMessage"] == "Created 1 request."


@pytest.mark.django_db
def test_processing_create_requests_and_pipeline_are_backend_owned(client, monkeypatch, tmp_path):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="request-record",
        name="Request Record",
        url="https://www.ebanglalibrary.com/books/request-record/",
        category="Fiction",
        writer="Writer One",
        translator="Translator One",
        publisher="Example Press",
    )

    sample = {
        "book_title": "Request Record",
        "author": "Writer One",
        "series": "",
        "book_type": "Fiction",
        "cover": "book_cover.jpg",
        "main_content": "<p>Request record body</p>",
        "book_info": "<p>অনুবাদ: Translator One</p>",
        "dedication": "",
        "toc": [{"title": "Chapter 1", "type": "lesson", "has_content": True}],
        "content_items": [
            {
                "title": "Chapter 1",
                "content": "<p>Request record body</p>",
                "type": "lesson",
                "parent": None,
            }
        ],
        "output_folder": str(tmp_path),
    }

    def fake_generate_exports(book_data):
        output_dir = Path(book_data["output_folder"])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "book.html").write_text("<html><body>book</body></html>", encoding="utf-8")
        (output_dir / "Request Record.epub").write_bytes(b"epub-bytes")
        (output_dir / "book_cover.jpg").write_bytes(b"cover-bytes")

    monkeypatch.setattr(
        "apps.processing.services.capture_source_page_metadata",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "apps.processing.services.find_existing_book_by_source_url",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr("apps.processing.services.scrape_book", lambda _url: sample, raising=False)
    monkeypatch.setattr(
        "apps.processing.services.generate_exports",
        fake_generate_exports,
        raising=False,
    )
    monkeypatch.setattr(
        "apps.ingestion.services.submissions.create_submission_records",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("legacy submission flow should not be used by /api/processing")
        ),
    )

    response = client.post(
        "/api/processing/records/create-requests/",
        {"ids": [record.id]},
        content_type="application/json",
    )

    assert response.status_code == 200
    request = BookCreationRequest.objects.get(book_record=record)
    assert request.state == BookCreationRequest.State.INITIAL
    assert BookRecord.objects.get(pk=record.pk).book_creation_state == "initial"

    for _ in range(20):
        response = client.post("/api/processing/pipeline/advance/", content_type="application/json")
        assert response.status_code == 200
        request.refresh_from_db()
        if request.state == BookCreationRequest.State.CREATED:
            break
        time_module.sleep(0.25)

    request.refresh_from_db()
    record.refresh_from_db()
    assert request.state == BookCreationRequest.State.CREATED
    assert record.book_creation_state == "created"
    assert request.submission_id is None
    assert request.linked_book is not None
    assert BookSubmission.objects.count() == 0
    assert ProcessingJob.objects.count() == 0
    created_book = Book.objects.get(pk=request.linked_book_id, deleted_at__isnull=True)
    assert created_book.title == "Request Record"
    assert created_book.raw_scraped_metadata["source_url"] == "https://www.ebanglalibrary.com/books/request-record/"
    assert record.linked_book_id == created_book.id


@pytest.mark.django_db
def test_processing_state_recovers_stale_processing_requests(client):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="stale-processing-record",
        name="Stale Processing Record",
        url="https://example.test/books/stale-processing-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="processing",
    )
    stale_request = BookCreationRequest.objects.create(
        id="stale-processing-request",
        book_record=record,
        state="processing",
    )
    BookCreationRequest.objects.filter(pk=stale_request.pk).update(
        updated_at=timezone.now() - timedelta(minutes=25)
    )

    response = client.get("/api/processing/state/")

    assert response.status_code == 200
    payload = response.json()
    stale_request.refresh_from_db()
    record.refresh_from_db()
    assert stale_request.state == "queued"
    assert stale_request.error_message == ""
    assert record.book_creation_state == "queued"
    row = next(item for item in payload["requests"] if item["id"] == stale_request.id)
    assert row["state"] == "queued"
    assert row["errorMessage"] == ""


@pytest.mark.django_db
def test_processing_duplicate_detection_is_backend_owned(client, monkeypatch):
    login_processing_admin(client)
    existing_book = Book.objects.create(title="Existing Request Record", state="ready")
    original_record = BookRecord.objects.create(
        id="original-record",
        name="Original Request Record",
        url="https://www.ebanglalibrary.com/books/original-request-record/",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="created",
        linked_book=existing_book,
    )
    original_request = BookCreationRequest.objects.create(
        id="original-request",
        book_record=original_record,
        state="created",
        linked_book=existing_book,
    )
    duplicate_record = BookRecord.objects.create(
        id="duplicate-record",
        name="Duplicate Request Record",
        url="https://www.ebanglalibrary.com/books/duplicate-request-record/",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
    )

    monkeypatch.setattr(
        "apps.processing.services.find_existing_book_by_source_url",
        lambda *_args, **_kwargs: existing_book,
    )
    monkeypatch.setattr(
        "apps.ingestion.services.submissions.create_submission_records",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("legacy submission flow should not be used by duplicate detection")
        ),
    )

    response = client.post(
        "/api/processing/records/create-requests/",
        {"ids": [duplicate_record.id]},
        content_type="application/json",
    )
    assert response.status_code == 200
    duplicate_request = BookCreationRequest.objects.get(book_record=duplicate_record)

    for _ in range(10):
        response = client.post("/api/processing/pipeline/advance/", content_type="application/json")
        assert response.status_code == 200
        duplicate_request.refresh_from_db()
        if duplicate_request.state == BookCreationRequest.State.DUPLICATE:
            break
        time_module.sleep(0.1)

    duplicate_request.refresh_from_db()
    duplicate_record.refresh_from_db()
    assert duplicate_request.state == "duplicate"
    assert duplicate_request.submission_id is None
    assert duplicate_request.duplicate_of_request_id == original_request.id
    assert duplicate_request.duplicate_of_record_id == original_record.id
    assert duplicate_record.book_creation_state == "duplicate"
    assert BookSubmission.objects.count() == 0
    assert ProcessingJob.objects.count() == 0


@pytest.mark.django_db
def test_processing_actions_persist_request_state_and_book_deletion(client):
    login_processing_admin(client)
    created_book = Book.objects.create(title="Created Book", state="ready")
    paused_record = BookRecord.objects.create(
        id="paused-record",
        name="Paused",
        url="https://example.test/books/paused",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="paused",
    )
    failed_record = BookRecord.objects.create(
        id="failed-record",
        name="Failed",
        url="https://example.test/books/failed",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="failed",
    )
    created_record = BookRecord.objects.create(
        id="created-record",
        name="Created",
        url="https://example.test/books/created",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="created",
        linked_book=created_book,
    )
    paused = BookCreationRequest.objects.create(
        id="paused-request",
        book_record=paused_record,
        state="paused",
        progress={"checkpoint": "chapter-4", "savedAt": timezone.now().isoformat(), "savedData": {}},
    )
    failed = BookCreationRequest.objects.create(
        id="failed-request",
        book_record=failed_record,
        state="failed",
        error_message="Retry threshold exceeded",
    )
    created = BookCreationRequest.objects.create(
        id="created-request",
        book_record=created_record,
        state="created",
        linked_book=created_book,
    )

    response = client.post(
        "/api/processing/requests/action/",
        {"ids": [paused.id], "action": "resume"},
        content_type="application/json",
    )
    assert response.status_code == 200
    paused.refresh_from_db()
    assert paused.state == "initial"
    assert paused.is_resumed is True

    response = client.post(
        "/api/processing/requests/action/",
        {"ids": [failed.id], "action": "retry"},
        content_type="application/json",
    )
    assert response.status_code == 200
    failed.refresh_from_db()
    assert failed.state == "initial"
    assert failed.error_message == ""

    response = client.post(
        "/api/processing/requests/action/",
        {"ids": [created.id], "action": "delete", "deleteBook": True},
        content_type="application/json",
    )
    assert response.status_code == 200
    created.refresh_from_db()
    created_book.refresh_from_db()
    assert created.state == "deleted"
    assert created_book.deleted_at is not None


@pytest.mark.django_db
def test_duplicate_confirmation_locks_record_until_original_terminal(client):
    login_processing_admin(client)
    original_record = BookRecord.objects.create(
        id="original-record",
        name="Original",
        url="https://example.test/books/original",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="processing",
    )
    duplicate_record = BookRecord.objects.create(
        id="duplicate-record",
        name="Duplicate",
        url="https://example.test/books/duplicate",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="duplicate",
    )
    original = BookCreationRequest.objects.create(
        id="original-request",
        book_record=original_record,
        state="processing",
    )
    duplicate = BookCreationRequest.objects.create(
        id="duplicate-request",
        book_record=duplicate_record,
        state="duplicate",
        duplicate_of_request=original,
        duplicate_of_record=original_record,
    )

    response = client.post(
        "/api/processing/requests/action/",
        {"ids": [duplicate.id], "action": "confirm_duplicate"},
        content_type="application/json",
    )
    assert response.status_code == 200
    payload = response.json()
    row = next(item for item in payload["records"] if item["id"] == duplicate_record.id)
    assert row["selectable"] is False

    original.state = "failed"
    original.save(update_fields=["state", "updated_at"])
    response = client.get("/api/processing/state/")
    row = next(item for item in response.json()["records"] if item["id"] == duplicate_record.id)
    assert row["selectable"] is True


@pytest.mark.django_db
def test_duplicate_new_action_clears_duplicate_locking_and_restarts_request(client):
    login_processing_admin(client)
    existing_book = Book.objects.create(title="Existing Book", state="ready")
    original_record = BookRecord.objects.create(
        id="original-record",
        name="Original",
        url="https://example.test/books/original",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="created",
        linked_book=existing_book,
    )
    duplicate_record = BookRecord.objects.create(
        id="duplicate-record",
        name="Duplicate",
        url="https://example.test/books/duplicate",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="duplicate",
        linked_book=existing_book,
        is_duplicate=True,
        duplicate_of_record=original_record,
    )
    duplicate_request = BookCreationRequest.objects.create(
        id="duplicate-request",
        book_record=duplicate_record,
        state="duplicate",
        linked_book=existing_book,
        duplicate_of_record=original_record,
    )

    response = client.post(
        "/api/processing/requests/action/",
        {"ids": [duplicate_request.id], "action": "new"},
        content_type="application/json",
    )

    assert response.status_code == 200
    duplicate_request.refresh_from_db()
    duplicate_record.refresh_from_db()
    assert duplicate_request.state == "initial"
    assert duplicate_request.is_confirmed_not_duplicate is True
    assert duplicate_request.duplicate_confirmed is False
    assert duplicate_request.duplicate_of_request_id is None
    assert duplicate_request.duplicate_of_record_id is None
    assert duplicate_request.linked_book_id is None
    assert duplicate_record.book_creation_state == "initial"
    assert duplicate_record.linked_book_id is None
    assert duplicate_record.is_duplicate is False
    assert duplicate_record.duplicate_of_record_id is None


@pytest.mark.django_db
def test_automation_and_incomplete_resolution_are_persisted(client):
    login_processing_admin(client)
    BookRecord.objects.create(
        id="auto-new",
        name="Auto New",
        url="https://example.test/books/auto-new",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="not_created",
    )
    BookRecord.objects.create(
        id="auto-created",
        name="Auto Created",
        url="https://example.test/books/auto-created",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="created",
    )
    incomplete = BookRecord.objects.create(
        id="incomplete-record",
        name="Incomplete Record",
        url="https://example.test/books/incomplete-record",
        category="অসম্পূর্ণ বই",
        writer="Writer",
        publisher="Press",
        was_incomplete=True,
        will_resolve_to_category="Novel",
    )

    response = client.post(
        "/api/processing/automation/catalog/",
        {"enabled": True, "interval": "weekly", "time": "04:30"},
        content_type="application/json",
    )
    assert response.status_code == 200
    response = client.post("/api/processing/automation/catalog/run/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    assert BookCreationRequest.objects.filter(book_record_id="auto-new", state="initial").exists()
    assert not BookCreationRequest.objects.filter(book_record_id="auto-created", state="initial").exists()

    response = client.post(
        "/api/processing/automation/incomplete/",
        {"enabled": True, "interval": "daily", "time": "03:00"},
        content_type="application/json",
    )
    assert response.status_code == 200
    response = client.post("/api/processing/automation/incomplete/run/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "incomplete_automation"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    incomplete.refresh_from_db()
    assert incomplete.category == "Novel"
    assert incomplete.resolved_from_incomplete is True
    assert BookCreationRequest.objects.filter(
        book_record=incomplete,
        state="created",
    ).exists()
