import json
import time as time_module
from datetime import time, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from django.utils import timezone

from apps.accounts.models import User
from apps.catalog.models import Book
from apps.ingestion.models import BookSubmission, ProcessingJob, SourceCatalogEntry
from apps.processing import services as processing_services
from apps.processing.models import (
    BookCreationRequest,
    BookRecord,
    ProcessingAutomationKind,
    ProcessingAutomationSettings,
    ProcessingSyncStatus,
)
from apps.processing.services import (
    PROCESSING_SYNC_KEY_INCOMPLETE,
    dispatch_sync_task,
    get_sync_state,
)
from apps.processing.tasks import (
    kickoff_book_creation_request_task,
    run_processing_sync_task,
)


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


def test_parse_incomplete_catalog_page_reads_entry_title_links():
    soup = processing_services.BeautifulSoup(
        """
        <html>
          <body>
            <article>
              <h2 class="entry-title">
                <a href="/books/sample-incomplete-book/">Sample Incomplete Book - Sample Author</a>
              </h2>
            </article>
            <article>
              <h2 class="entry-title">
                <a href="/books/second-incomplete-book/">Second Incomplete Book</a>
              </h2>
            </article>
          </body>
        </html>
        """,
        "html.parser",
    )

    entries = processing_services.parse_incomplete_catalog_page(soup)

    assert [entry["source_url"] for entry in entries] == [
        "https://www.ebanglalibrary.com/books/sample-incomplete-book/",
        "https://www.ebanglalibrary.com/books/second-incomplete-book/",
    ]
    assert entries[0]["title"] == "Sample Incomplete Book"
    assert entries[0]["author_line"] == "Sample Author"
    assert entries[0]["raw_data"]["metadata_source"] == "incomplete_archive_page"


def test_fetch_live_incomplete_page_treats_paginated_404_as_end_of_archive(monkeypatch):
    class FakeHttpError(Exception):
        def __init__(self, response):
            super().__init__("404 not found")
            self.response = response

    class FakeResponse:
        status_code = 404
        text = ""

        def raise_for_status(self):
            raise FakeHttpError(self)

    monkeypatch.setattr(
        "apps.processing.services.get_with_host_fallback",
        lambda *_args, **_kwargs: FakeResponse(),
    )

    page = processing_services.fetch_live_incomplete_page(
        SimpleNamespace(session=object()),
        5,
    )

    assert page == []


@pytest.mark.django_db
def test_processing_invalidation_targets_ignore_incomplete_cards_for_unrelated_request_updates():
    record = BookRecord.objects.create(
        id="plain-record",
        name="Plain Record",
        url="https://example.test/books/plain-record",
        category="Novel",
        writer="Writer One",
        publisher="Example Press",
    )
    request = BookCreationRequest.objects.create(
        id="plain-request",
        book_record=record,
        state="initial",
    )
    previous_snapshot = processing_services.processing_invalidation_snapshot()

    request.state = "queued"
    request.save(update_fields=["state", "updated_at"])
    processing_services.sync_record_state(record)
    next_snapshot = processing_services.processing_invalidation_snapshot()

    targets = processing_services.processing_invalidation_targets(
        previous_snapshot,
        next_snapshot,
    )

    assert "create-queue" in targets
    assert processing_services.PROCESSING_CARD_INCOMPLETE_OVERVIEW not in targets
    assert "incomplete-records" not in targets
    assert "incomplete-completed" not in targets


@pytest.mark.django_db
def test_processing_invalidation_targets_include_incomplete_cards_for_incomplete_updates():
    record = BookRecord.objects.create(
        id="incomplete-target-record",
        name="Incomplete Target Record",
        url="https://example.test/books/incomplete-target-record",
        category="অসম্পূর্ণ বই",
        writer="Writer One",
        publisher="Example Press",
        was_incomplete=True,
        resolved_from_incomplete=False,
        will_resolve_to_category="Novel",
    )
    previous_snapshot = processing_services.processing_invalidation_snapshot()

    record.category = "Novel"
    record.resolved_from_incomplete = True
    record.save(update_fields=["category", "resolved_from_incomplete", "updated_at"])
    BookCreationRequest.objects.create(
        id="incomplete-target-request",
        book_record=record,
        state="created",
    )
    processing_services.sync_record_state(record)
    next_snapshot = processing_services.processing_invalidation_snapshot()

    targets = processing_services.processing_invalidation_targets(
        previous_snapshot,
        next_snapshot,
    )

    assert processing_services.PROCESSING_CARD_INCOMPLETE_OVERVIEW in targets
    assert "incomplete-records" in targets
    assert "incomplete-completed" in targets


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
def test_processing_stream_advances_sync_and_emits_invalidation(client, monkeypatch):
    login_processing_admin(client)
    processing_services.cache.delete(processing_services.PROCESSING_PUSH_TICK_LOCK_KEY)

    start_response = client.post(
        "/api/processing/sync/start/",
        {
            "remotePages": [
                [record_payload("stream-sync-record")],
                [],
            ]
        },
        content_type="application/json",
    )

    assert start_response.status_code == 200

    monkeypatch.setattr("apps.processing.views.time.sleep", lambda _seconds: None)

    response = client.get("/api/processing/stream/")

    assert response.status_code == 200
    stream = iter(response.streaming_content)
    assert next(stream).decode() == "event: connected\ndata: {}\n\n"

    invalidation = next(stream).decode()
    assert "event: invalidation" in invalidation
    assert '"catalog-sync"' in invalidation
    assert '"catalog-records"' in invalidation

    sync_state = get_sync_state()
    assert sync_state.status == "idle"
    assert BookRecord.objects.filter(pk="stream-sync-record").exists()


@pytest.mark.django_db
def test_processing_push_tick_advances_processing_pipeline_without_client_polling(
    monkeypatch,
):
    record = BookRecord.objects.create(
        id="push-pipeline-record",
        name="Push Pipeline Record",
        url="https://example.test/books/push-pipeline-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="processing",
    )
    processing_request = BookCreationRequest.objects.create(
        id="push-pipeline-request",
        book_record=record,
        state="processing",
    )

    def fake_run_processing_request(request):
        request.state = "created"
        request.error_message = ""
        request.save(update_fields=["state", "error_message", "updated_at"])
        processing_services.sync_record_state(request.book_record)
        return request

    monkeypatch.setattr(
        "apps.processing.services.should_run_processing_jobs_inline",
        lambda: False,
    )
    monkeypatch.setattr(
        "apps.processing.services.processing_workers_available",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(
        "apps.processing.services._run_processing_request",
        fake_run_processing_request,
    )

    processing_services.cache.delete(processing_services.PROCESSING_PUSH_TICK_LOCK_KEY)

    has_active_work = processing_services.advance_processing_push_tick()

    assert has_active_work is True
    processing_request.refresh_from_db()
    record.refresh_from_db()
    assert processing_request.state == "created"
    assert record.book_creation_state == "created"


@pytest.mark.django_db
def test_processing_state_returns_weekly_automation_defaults_without_placeholder(client):
    login_processing_admin(client)

    response = client.get("/api/processing/state/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["automation"]["catalog"]["interval"] == "weekly"
    assert payload["automation"]["catalog"]["time"] == "03:00"
    assert payload["automation"]["catalog"]["statusMessage"] == ""
    assert payload["automation"]["incomplete"]["interval"] == "weekly"
    assert payload["automation"]["incomplete"]["time"] == "03:00"
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
    assert payload["automation"]["catalog"]["time"] == "03:00"
    assert payload["automation"]["catalog"]["statusMessage"] == ""
    assert payload["automation"]["incomplete"]["interval"] == "weekly"
    assert payload["automation"]["incomplete"]["time"] == "03:00"
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
def test_processing_state_supports_summary_only_payload(client):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="summary-only-record",
        name="Summary Only",
        url="https://example.test/books/summary-only",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="not_created",
        was_incomplete=True,
    )
    BookCreationRequest.objects.create(
        id="summary-only-request",
        book_record=record,
        state="failed",
        error_message="Pipeline failed after retries.",
    )

    response = client.get("/api/processing/state/?includeLists=0")

    assert response.status_code == 200
    payload = response.json()
    assert "records" not in payload
    assert "requests" not in payload
    assert payload["summary"]["catalog"]["records"] == 1
    assert payload["summary"]["catalog"]["onHold"] == 1
    assert payload["summary"]["onHold"]["failed"] == 1
    assert payload["summary"]["incomplete"]["incomplete"] == 1
    assert (
        payload["summary"]["notifications"]["latestFailedMessage"]
        == "Pipeline failed after retries."
    )


@pytest.mark.django_db
def test_processing_table_paginates_catalog_rows_and_applies_filters(client):
    login_processing_admin(client)

    created_ids = set()
    for index in range(75):
        record = BookRecord.objects.create(
            id=f"table-record-{index:02d}",
            name=f"Table Record {index:02d}",
            url=f"https://example.test/books/table-record-{index:02d}",
            category="Poetry" if index % 2 == 0 else "Novel",
            writer="Writer",
            publisher="Press",
            book_creation_state="not_created",
        )
        if index < 6:
            BookCreationRequest.objects.create(
                id=f"table-request-{index:02d}",
                book_record=record,
                state="created",
            )
            created_ids.add(record.id)

    response = client.get("/api/processing/table/?card=catalog-records&limit=60")

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["rows"]) == 60
    assert payload["pagination"]["totalCount"] == 75
    assert payload["pagination"]["hasMore"] is True
    assert payload["pagination"]["nextOffset"] == 60
    assert "Novel" in payload["filters"]["categoryOptions"]
    assert "Poetry" in payload["filters"]["categoryOptions"]
    assert "created" in payload["filters"]["statusOptions"]
    assert "not_created" in payload["filters"]["statusOptions"]

    response = client.get("/api/processing/table/?card=catalog-records&offset=60&limit=60")

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["rows"]) == 15
    assert payload["pagination"]["hasMore"] is False

    response = client.get(
        "/api/processing/table/?card=catalog-records&category=Poetry&status=created"
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["pagination"]["totalCount"] == 3
    assert {row["recordId"] for row in payload["rows"]} == {
        record_id for record_id in created_ids if record_id.endswith(("00", "02", "04"))
    }
    assert all(row["category"] == "Poetry" for row in payload["rows"])
    assert all(row["status"] == "created" for row in payload["rows"])


@pytest.mark.django_db
def test_processing_table_keeps_create_cards_scoped_to_request_status(client):
    login_processing_admin(client)

    card_states = {
        "create-requests": "initial",
        "create-queue": "queued",
        "create-processing": "processing",
        "create-created": "created",
    }
    request_ids = {}

    for card_id, status in card_states.items():
        record = BookRecord.objects.create(
            id=f"{card_id}-record",
            name=f"{card_id} title",
            url=f"https://example.test/books/{card_id}",
            category="Reference",
            writer="Writer One",
            publisher="Example Press",
            book_creation_state=status,
        )
        request = BookCreationRequest.objects.create(
            id=f"{card_id}-request",
            book_record=record,
            state=status,
        )
        request_ids[card_id] = str(request.id)

    for card_id, status in card_states.items():
        response = client.get(f"/api/processing/table/?card={card_id}")

        assert response.status_code == 200
        payload = response.json()
        assert [row["requestId"] for row in payload["rows"]] == [request_ids[card_id]]
        assert {row["status"] for row in payload["rows"]} == {status}
        assert payload["filters"]["statusOptions"] == [status]


@pytest.mark.django_db
def test_processing_table_keeps_on_hold_cards_scoped_to_request_status(client):
    login_processing_admin(client)

    card_states = {
        "on-hold-paused": "paused",
        "on-hold-failed": "failed",
        "on-hold-duplicate": "duplicate",
        "on-hold-deleted": "deleted",
    }
    request_ids = {}

    for card_id, status in card_states.items():
        record = BookRecord.objects.create(
            id=f"{card_id}-record",
            name=f"{card_id} title",
            url=f"https://example.test/books/{card_id}",
            category="Reference",
            writer="Writer One",
            publisher="Example Press",
            book_creation_state=status,
        )
        request = BookCreationRequest.objects.create(
            id=f"{card_id}-request",
            book_record=record,
            state=status,
        )
        request_ids[card_id] = str(request.id)

    for card_id, status in card_states.items():
        response = client.get(f"/api/processing/table/?card={card_id}")

        assert response.status_code == 200
        payload = response.json()
        assert [row["requestId"] for row in payload["rows"]] == [request_ids[card_id]]
        assert {row["status"] for row in payload["rows"]} == {status}
        assert payload["filters"]["statusOptions"] == [status]


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
def test_processing_sync_start_ignores_remote_pages_when_overrides_are_disabled(client, monkeypatch):
    login_processing_admin(client)
    monkeypatch.setattr(
        "apps.processing.views.allow_processing_remote_page_payloads",
        lambda: False,
    )

    response = client.post(
        "/api/processing/sync/start/",
        {"remotePages": [[record_payload("ignored-record")], []]},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json()["sync"]["status"] == "syncing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    assert not BookRecord.objects.filter(pk="ignored-record").exists()


@pytest.mark.django_db
def test_catalog_automation_ignores_stale_remote_pages_when_overrides_are_disabled(client, monkeypatch):
    login_processing_admin(client)
    monkeypatch.setattr(
        "apps.processing.services.allow_processing_remote_page_payloads",
        lambda: False,
    )

    sync_state = get_sync_state()
    sync_state.remote_pages = [[record_payload("stale-remote-record")], []]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    entry = SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/fallback-live-record/",
        title="Fallback Live Record",
        author_line="Source Author",
        normalized_title="fallback live record",
        normalized_display="fallback live record source author",
        raw_data={"category": "Fallback Category", "publisher": "Source Publisher"},
    )

    response = client.post(
        "/api/processing/automation/catalog/run/",
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json()["sync"]["status"] == "syncing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    assert not BookRecord.objects.filter(pk="stale-remote-record").exists()
    assert BookRecord.objects.filter(pk=str(entry.id)).exists()
    assert BookCreationRequest.objects.filter(
        book_record_id=str(entry.id),
        state="initial",
    ).exists()


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

    response = client.post("/api/processing/sync/resume/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"
    assert payload["sync"]["message"] == "Restarting automated catalog sync from the beginning."

    response = client.post("/api/processing/sync/stop/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    assert payload["sync"]["message"] == "Automated catalog sync stopped."
    assert payload["automation"]["catalog"]["statusMessage"] == "Automated catalog sync stopped."


@pytest.mark.django_db
def test_manual_sync_start_reuses_paused_automation_checkpoint(client):
    login_processing_admin(client)
    sync_state = get_sync_state()
    sync_state.remote_pages = [
        [record_payload("shared-page-1", name="Shared Page One")],
        [record_payload("shared-page-2", name="Shared Page Two")],
        [],
    ]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    response = client.post(
        "/api/processing/automation/catalog/run/",
        content_type="application/json",
    )
    assert response.status_code == 200
    assert response.json()["sync"]["runMode"] == "catalog_automation"

    response = client.post("/api/processing/sync/pause/", content_type="application/json")
    assert response.status_code == 200
    assert response.json()["sync"]["status"] == "pausing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["runMode"] == "catalog_automation"
    assert payload["sync"]["fetchedCount"] == 1

    response = client.post("/api/processing/sync/start/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "manual"
    assert payload["sync"]["message"] == "Reconciling saved records from the beginning."
    assert payload["sync"]["fetchedCount"] == 1
    assert payload["sync"]["pageIndex"] == 0
    assert payload["sync"]["progress"]["savedData"]["fetchedCount"] == 1
    assert payload["sync"]["progress"]["savedData"]["nextPageIndex"] == 0


@pytest.mark.django_db
def test_catalog_automation_run_reuses_paused_manual_checkpoint_and_creates_requests(client):
    login_processing_admin(client)

    response = client.post(
        "/api/processing/sync/start/",
        {
            "remotePages": [
                [record_payload("resume-auto-page-1", name="Resume Auto Page One")],
                [record_payload("resume-auto-page-2", name="Resume Auto Page Two")],
                [],
            ]
        },
        content_type="application/json",
    )
    assert response.status_code == 200
    assert response.json()["sync"]["runMode"] == "manual"

    response = client.post("/api/processing/sync/pause/", content_type="application/json")
    assert response.status_code == 200
    assert response.json()["sync"]["status"] == "pausing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["runMode"] == "manual"
    assert payload["sync"]["fetchedCount"] == 1

    response = client.post(
        "/api/processing/automation/catalog/run/",
        content_type="application/json",
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"
    assert payload["sync"]["message"] == "Restarting automated catalog sync from the beginning."
    assert payload["sync"]["fetchedCount"] == 1
    assert payload["sync"]["pageIndex"] == 0

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    assert response.json()["sync"]["status"] == "syncing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    assert BookCreationRequest.objects.filter(
        book_record_id="resume-auto-page-1",
        state="initial",
    ).exists()
    assert BookCreationRequest.objects.filter(
        book_record_id="resume-auto-page-2",
        state="initial",
    ).exists()


@pytest.mark.django_db
def test_processing_sync_honors_pause_requested_during_page_advance(client, monkeypatch):
    login_processing_admin(client)

    response = client.post(
        "/api/processing/sync/start/",
        {
            "remotePages": [
                [record_payload("mid-page-pause-a")],
                [record_payload("mid-page-pause-b")],
                [],
            ]
        },
        content_type="application/json",
    )

    assert response.status_code == 200

    original_upsert = processing_services.upsert_remote_records

    def pause_after_upsert(*args, **kwargs):
        result = original_upsert(*args, **kwargs)
        processing_services.pause_sync()
        return result

    monkeypatch.setattr(
        "apps.processing.services.upsert_remote_records",
        pause_after_upsert,
    )

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["progress"]["savedData"]["nextPageIndex"] == 1
    assert payload["sync"]["fetchedCount"] == 1
    assert BookRecord.objects.filter(pk="mid-page-pause-a").exists()
    assert not BookRecord.objects.filter(pk="mid-page-pause-b").exists()


@pytest.mark.django_db
def test_incomplete_sync_honors_pause_requested_during_batch_advance(client, monkeypatch):
    login_processing_admin(client)
    BookRecord.objects.create(
        id="mid-incomplete-a",
        name="Mid Incomplete A",
        url="https://example.test/books/mid-incomplete-a",
        category="অসম্পূর্ণ বই",
        writer="Writer One",
        publisher="Example Press",
        was_incomplete=True,
        resolved_from_incomplete=False,
        will_resolve_to_category="Novel",
    )
    BookRecord.objects.create(
        id="mid-incomplete-b",
        name="Mid Incomplete B",
        url="https://example.test/books/mid-incomplete-b",
        category="অসম্পূর্ণ বই",
        writer="Writer Two",
        publisher="Example Press",
        was_incomplete=True,
        resolved_from_incomplete=False,
        will_resolve_to_category="Novel",
    )

    response = client.post(
        "/api/processing/automation/incomplete/run/",
        content_type="application/json",
    )

    assert response.status_code == 200
    sync_state = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    sync_state.remote_pages = [["mid-incomplete-a"], ["mid-incomplete-b"], []]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    original_resolve = processing_services.resolve_incomplete_records

    def pause_after_resolve(*args, **kwargs):
        resolved = original_resolve(*args, **kwargs)
        processing_services.pause_sync()
        return resolved

    monkeypatch.setattr(
        "apps.processing.services.resolve_incomplete_records",
        pause_after_resolve,
    )

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["runMode"] == "incomplete_automation"
    assert payload["sync"]["progress"]["savedData"]["nextPageIndex"] == 1
    assert payload["sync"]["updatedCount"] == 1
    assert BookRecord.objects.get(pk="mid-incomplete-a").resolved_from_incomplete is True
    assert BookRecord.objects.get(pk="mid-incomplete-b").resolved_from_incomplete is False


@pytest.mark.django_db
def test_incomplete_automation_can_pause_resume_and_complete(client):
    login_processing_admin(client)
    BookRecord.objects.create(
        id="resume-incomplete-a",
        name="Resume Incomplete A",
        url="https://example.test/books/resume-incomplete-a",
        category="অসম্পূর্ণ বই",
        writer="Writer One",
        publisher="Example Press",
        was_incomplete=True,
        resolved_from_incomplete=False,
        will_resolve_to_category="Novel",
    )
    BookRecord.objects.create(
        id="resume-incomplete-b",
        name="Resume Incomplete B",
        url="https://example.test/books/resume-incomplete-b",
        category="অসম্পূর্ণ বই",
        writer="Writer Two",
        publisher="Example Press",
        was_incomplete=True,
        resolved_from_incomplete=False,
        will_resolve_to_category="Novel",
    )

    response = client.post(
        "/api/processing/automation/incomplete/run/",
        content_type="application/json",
    )

    assert response.status_code == 200
    sync_state = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    sync_state.remote_pages = [["resume-incomplete-a"], ["resume-incomplete-b"], []]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    response = client.post("/api/processing/sync/pause/", content_type="application/json")
    assert response.status_code == 200
    assert response.json()["sync"]["status"] == "pausing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["runMode"] == "incomplete_automation"
    assert BookRecord.objects.get(pk="resume-incomplete-a").resolved_from_incomplete is True
    assert BookRecord.objects.get(pk="resume-incomplete-b").resolved_from_incomplete is False

    response = client.post("/api/processing/sync/resume/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "incomplete_automation"
    assert payload["sync"]["message"] == "Restarting incomplete catalog sync from the beginning."

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    assert payload["sync"]["message"] == "Incomplete catalog sync complete. Resolved 2 books."
    assert BookRecord.objects.get(pk="resume-incomplete-b").resolved_from_incomplete is True


@pytest.mark.django_db
def test_incomplete_automation_uses_incomplete_sync_remote_pages_source(client, monkeypatch):
    login_processing_admin(client)
    expected_pages = [
        [
            {
                "id": "live-incomplete-record",
                "name": "Live Incomplete Record",
                "url": "https://www.ebanglalibrary.com/books/live-incomplete-record/",
                "category": "অসম্পূর্ণ বই",
                "writer": "Live Writer",
                "translator": "",
                "composer": "",
                "publisher": "Live Press",
                "updatedAt": timezone.now().isoformat(),
                "wasIncomplete": True,
                "willResolveToCategory": "Novel",
            }
        ],
        [],
    ]
    monkeypatch.setattr(
        "apps.processing.services.incomplete_sync_remote_pages",
        lambda: expected_pages,
    )

    response = client.post(
        "/api/processing/automation/incomplete/run/",
        content_type="application/json",
    )

    assert response.status_code == 200
    sync_state = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    assert sync_state.remote_pages == expected_pages
    assert response.json()["sync"]["runMode"] == "incomplete_automation"


@pytest.mark.django_db
def test_incomplete_automation_live_sync_fetches_incrementally_and_resolves_stale_records(
    client,
    monkeypatch,
):
    login_processing_admin(client)
    BookRecord.objects.create(
        id="stale-incomplete-live",
        name="Stale Incomplete Live",
        url="https://www.ebanglalibrary.com/books/stale-incomplete-live/",
        category="অসম্পূর্ণ বই",
        writer="Writer One",
        publisher="Example Press",
        was_incomplete=True,
        resolved_from_incomplete=False,
        will_resolve_to_category="Novel",
    )

    page_calls = []

    def fake_fetch_live_incomplete_page(_resolver, page_number):
        page_calls.append(page_number)
        if page_number == 1:
            return [
                {
                    "id": "live-incomplete-page-1",
                    "name": "Live Incomplete Page 1",
                    "url": "https://www.ebanglalibrary.com/books/live-incomplete-page-1/",
                    "category": "অসম্পূর্ণ বই",
                    "writer": "Live Writer",
                    "translator": "",
                    "composer": "",
                    "publisher": "Live Press",
                    "updatedAt": timezone.now().isoformat(),
                    "wasIncomplete": True,
                    "resolvedFromIncomplete": False,
                    "willResolveToCategory": "Novel",
                }
            ]
        return []

    monkeypatch.setattr(
        "apps.processing.services.should_use_live_incomplete_fetch",
        lambda: True,
    )
    monkeypatch.setattr(
        "apps.processing.services.fetch_live_incomplete_page",
        fake_fetch_live_incomplete_page,
    )

    response = client.post(
        "/api/processing/automation/incomplete/run/",
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "incomplete_automation"
    assert payload["sync"]["remotePages"] == []
    assert payload["sync"]["progress"]["savedData"]["liveFetch"] is True

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["fetchedCount"] == 1
    assert BookRecord.objects.filter(pk="live-incomplete-page-1").exists()

    response = client.post("/api/processing/sync/advance/", content_type="application/json")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "idle"
    assert payload["sync"]["message"] == "Incomplete catalog sync complete. Resolved 1 book."
    assert page_calls == [1, 2]
    stale_record = BookRecord.objects.get(pk="stale-incomplete-live")
    assert stale_record.resolved_from_incomplete is True
    assert stale_record.category == "Novel"


@pytest.mark.django_db
def test_incomplete_automation_live_sync_pause_and_resume_restarts_from_beginning(
    client,
    monkeypatch,
):
    login_processing_admin(client)

    def fake_fetch_live_incomplete_page(_resolver, page_number):
        if page_number == 1:
            return [
                {
                    "id": "paused-live-incomplete",
                    "name": "Paused Live Incomplete",
                    "url": "https://www.ebanglalibrary.com/books/paused-live-incomplete/",
                    "category": "অসম্পূর্ণ বই",
                    "writer": "Live Writer",
                    "translator": "",
                    "composer": "",
                    "publisher": "Live Press",
                    "updatedAt": timezone.now().isoformat(),
                    "wasIncomplete": True,
                    "resolvedFromIncomplete": False,
                    "willResolveToCategory": "Novel",
                }
            ]
        return []

    monkeypatch.setattr(
        "apps.processing.services.should_use_live_incomplete_fetch",
        lambda: True,
    )
    monkeypatch.setattr(
        "apps.processing.services.fetch_live_incomplete_page",
        fake_fetch_live_incomplete_page,
    )

    response = client.post(
        "/api/processing/automation/incomplete/run/",
        content_type="application/json",
    )

    assert response.status_code == 200

    response = client.post("/api/processing/sync/pause/", content_type="application/json")
    assert response.status_code == 200
    assert response.json()["sync"]["status"] == "pausing"

    response = client.post("/api/processing/sync/advance/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["progress"]["savedData"]["liveFetch"] is True
    assert payload["sync"]["progress"]["savedData"]["nextPageIndex"] == 1

    sync_state = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    assert sync_state.page_index == 1
    assert len(sync_state.remote_pages) == 1

    response = client.post("/api/processing/sync/resume/", content_type="application/json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["message"] == "Restarting incomplete catalog sync from the beginning."
    assert payload["sync"]["progress"]["savedData"]["liveFetch"] is True
    assert payload["sync"]["progress"]["savedData"]["nextPageIndex"] == 0

    sync_state.refresh_from_db()
    assert sync_state.page_index == 0
    assert sync_state.remote_pages == []


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


def test_processing_task_requeues_if_worker_child_is_lost():
    assert kickoff_book_creation_request_task.acks_late is True
    assert kickoff_book_creation_request_task.reject_on_worker_lost is True


def test_processing_task_handles_missing_request_gracefully(monkeypatch):
    missing_request_id = "missing-processing-request"

    def raise_missing(_request_id):
        raise BookCreationRequest.DoesNotExist

    monkeypatch.setattr(
        "apps.processing.tasks.kickoff_request_processing",
        raise_missing,
    )

    result = kickoff_book_creation_request_task.run(missing_request_id)

    assert result == {
        "request_id": missing_request_id,
        "state": "deleted",
        "submission_id": "",
        "missing": True,
    }


@pytest.mark.django_db
def test_processing_sync_task_returns_json_safe_sync_snapshot(monkeypatch):
    sync_state = get_sync_state()
    remote_pages = [[record_payload("task-sync-record")], []]
    sync_state.status = ProcessingSyncStatus.PAUSED
    sync_state.progress = {
        "runMode": "catalog_automation",
        "savedData": {
            "runMode": "catalog_automation",
            "nextPageIndex": 2,
            "fetchedCount": 3,
        },
    }
    sync_state.remote_pages = remote_pages
    sync_state.page_index = 2
    sync_state.fetched_count = 3
    sync_state.skipped_count = 1
    sync_state.updated_count = 2
    sync_state.appended_count = 1
    sync_state.message = "Sync progress saved."
    sync_state.save(
        update_fields=[
            "status",
            "progress",
            "remote_pages",
            "page_index",
            "fetched_count",
            "skipped_count",
            "updated_count",
            "appended_count",
            "message",
            "updated_at",
        ]
    )

    monkeypatch.setattr(
        "apps.processing.tasks.run_processing_sync",
        lambda **_kwargs: sync_state,
    )

    result = run_processing_sync_task.run("default")

    assert result["singleton_key"] == "catalog"
    assert result["status"] == "paused"
    assert result["run_mode"] == "catalog_automation"
    assert result["page_index"] == 2
    assert result["fetched_count"] == 3
    assert result["remote_pages"] == remote_pages
    json.dumps(result)


@pytest.mark.django_db
def test_processing_pipeline_does_not_reenqueue_queued_request_while_dispatch_is_pending(
    client, monkeypatch
):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="pending-dispatch-record",
        name="Pending Dispatch Record",
        url="https://example.test/books/pending-dispatch-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
    )
    dispatch_calls = []

    def fake_apply_async(*, args, **kwargs):
        dispatch_calls.append({"args": tuple(args), "kwargs": dict(kwargs)})
        return SimpleNamespace(id=f"task-{len(dispatch_calls)}")

    monkeypatch.setattr(
        "apps.processing.services.should_run_processing_jobs_inline",
        lambda: False,
    )
    monkeypatch.setattr(
        "apps.processing.services.processing_workers_available",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        "apps.processing.tasks.kickoff_book_creation_request_task.apply_async",
        fake_apply_async,
    )

    response = client.post(
        "/api/processing/records/create-requests/",
        {"ids": [record.id]},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert dispatch_calls == [
        {
            "args": ("request-pending-dispatch-record",),
            "kwargs": {"queue": "processing"},
        }
    ]
    processing_request = BookCreationRequest.objects.get(book_record=record)
    assert processing_request.state == "queued"

    response = client.post("/api/processing/pipeline/advance/", content_type="application/json")

    assert response.status_code == 200
    assert response.json()["advancedCount"] == 0
    processing_request.refresh_from_db()
    assert processing_request.state == "queued"

    response = client.post("/api/processing/pipeline/advance/", content_type="application/json")

    assert response.status_code == 200
    assert response.json()["advancedCount"] == 0
    processing_request.refresh_from_db()
    assert processing_request.state == "queued"
    assert dispatch_calls == [
        {
            "args": ("request-pending-dispatch-record",),
            "kwargs": {"queue": "processing"},
        }
    ]


@pytest.mark.django_db
def test_processing_pipeline_dispatches_queued_request_even_with_initial_backlog(
    client, monkeypatch
):
    login_processing_admin(client)
    queued_record = BookRecord.objects.create(
        id="queued-backlog-record",
        name="Queued Backlog Record",
        url="https://example.test/books/queued-backlog-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="queued",
    )
    initial_record = BookRecord.objects.create(
        id="initial-backlog-record",
        name="Initial Backlog Record",
        url="https://example.test/books/initial-backlog-record",
        category="Fiction",
        writer="Writer Two",
        publisher="Example Press",
        book_creation_state="initial",
    )
    queued_request = BookCreationRequest.objects.create(
        id="queued-backlog-request",
        book_record=queued_record,
        state="queued",
    )
    initial_request = BookCreationRequest.objects.create(
        id="initial-backlog-request",
        book_record=initial_record,
        state="initial",
    )
    dispatch_calls = []

    def fake_apply_async(*, args, **kwargs):
        dispatch_calls.append({"args": tuple(args), "kwargs": dict(kwargs)})
        return SimpleNamespace(id=f"task-{len(dispatch_calls)}")

    monkeypatch.setattr(
        "apps.processing.services.should_run_processing_jobs_inline",
        lambda: False,
    )
    monkeypatch.setattr(
        "apps.processing.services.processing_workers_available",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        "apps.processing.tasks.kickoff_book_creation_request_task.apply_async",
        fake_apply_async,
    )

    response = client.post("/api/processing/pipeline/advance/", content_type="application/json")

    assert response.status_code == 200
    assert response.json()["advancedCount"] == 2
    queued_request.refresh_from_db()
    initial_request.refresh_from_db()
    assert queued_request.state == "queued"
    assert initial_request.state == "queued"
    assert dispatch_calls == [
        {
            "args": ("queued-backlog-request",),
            "kwargs": {"queue": "processing"},
        }
    ]


@pytest.mark.django_db
def test_processing_pipeline_requeues_stale_dispatch_marker(client, monkeypatch):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="stale-dispatch-record",
        name="Stale Dispatch Record",
        url="https://example.test/books/stale-dispatch-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="queued",
    )
    processing_request = BookCreationRequest.objects.create(
        id="stale-dispatch-request",
        book_record=record,
        state="queued",
        progress={
            "_dispatchRequestedAt": (
                timezone.now() - timedelta(minutes=5)
            ).isoformat(),
            "_dispatchTaskId": "stale-processing-task",
        },
    )
    dispatch_calls = []

    def fake_apply_async(*, args, **kwargs):
        dispatch_calls.append({"args": tuple(args), "kwargs": dict(kwargs)})
        return SimpleNamespace(id="fresh-processing-task")

    monkeypatch.setattr(
        "apps.processing.services.should_run_processing_jobs_inline",
        lambda: False,
    )
    monkeypatch.setattr(
        "apps.processing.services.processing_workers_available",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        "apps.processing.tasks.kickoff_book_creation_request_task.apply_async",
        fake_apply_async,
    )

    response = client.post("/api/processing/pipeline/advance/", content_type="application/json")

    assert response.status_code == 200
    assert response.json()["advancedCount"] == 1
    processing_request.refresh_from_db()
    assert processing_request.state == "queued"
    assert processing_request.progress["_dispatchTaskId"] == "fresh-processing-task"
    assert dispatch_calls == [
        {
            "args": ("stale-dispatch-request",),
            "kwargs": {"queue": "processing"},
        }
    ]


@pytest.mark.django_db
def test_processing_sync_dispatches_to_processing_queue(monkeypatch):
    sync_state = get_sync_state()
    sync_state.status = ProcessingSyncStatus.SYNCING
    sync_state.task_id = ""
    sync_state.queue_name = ""
    sync_state.last_error = "stale error"
    sync_state.save(update_fields=["status", "task_id", "queue_name", "last_error", "updated_at"])

    dispatch_calls = []

    def fake_apply_async(*, args, **kwargs):
        dispatch_calls.append({"args": tuple(args), "kwargs": dict(kwargs)})
        return SimpleNamespace(id=kwargs.get("task_id"))

    monkeypatch.setattr(
        "apps.processing.tasks.run_processing_sync_task.apply_async",
        fake_apply_async,
    )

    dispatch_sync_task(sync_state, force=True)

    sync_state.refresh_from_db()
    assert sync_state.queue_name == "processing"
    assert sync_state.last_error == ""
    assert len(dispatch_calls) == 1
    assert dispatch_calls[0]["args"] == ("catalog",)
    assert dispatch_calls[0]["kwargs"]["queue"] == "processing"
    assert dispatch_calls[0]["kwargs"]["task_id"] == sync_state.task_id


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
def test_processing_table_includes_linked_book_slug_for_created_requests(client):
    login_processing_admin(client)
    linked_book = Book.objects.create(title="Linked Created Book", state="ready")
    record = BookRecord.objects.create(
        id="created-linked-record",
        name="Created Linked Record",
        url="https://example.test/books/created-linked-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="created",
        linked_book=linked_book,
    )
    BookCreationRequest.objects.create(
        id="created-linked-request",
        book_record=record,
        state="created",
        linked_book=linked_book,
    )

    response = client.get("/api/processing/table/?card=create-created")

    assert response.status_code == 200
    payload = response.json()
    assert payload["rows"][0]["linkedBookId"] == str(linked_book.id)
    assert payload["rows"][0]["linkedBookSlug"] == linked_book.slug


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
