from datetime import time, timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import User
from apps.catalog.models import Book
from apps.ingestion.models import SourceCatalogEntry
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
                        category="Updated",
                    )
                ],
                [record_payload("new-record", name="New Record")],
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
    assert BookRecord.objects.get(pk="existing-record").name == "Existing Revised"

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
    assert BookRecord.objects.filter(pk="new-record").exists()

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
def test_processing_create_requests_and_pipeline_are_backend_owned(client):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="request-record",
        name="Request Record",
        url="https://example.test/books/request-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
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

    for _ in range(3):
        response = client.post("/api/processing/pipeline/advance/", content_type="application/json")
        assert response.status_code == 200

    request.refresh_from_db()
    record.refresh_from_db()
    assert request.state == BookCreationRequest.State.CREATED
    assert record.book_creation_state == "created"
    assert request.linked_book is not None
    assert Book.objects.filter(pk=request.linked_book_id, deleted_at__isnull=True).exists()


@pytest.mark.django_db
def test_processing_state_marks_stale_processing_requests_as_failed(client):
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
    assert stale_request.state == "failed"
    assert stale_request.error_message == "Processing exceeded 20 minutes without completing."
    assert record.book_creation_state == "failed"
    row = next(item for item in payload["requests"] if item["id"] == stale_request.id)
    assert row["state"] == "failed"
    assert row["errorMessage"] == "Processing exceeded 20 minutes without completing."


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
