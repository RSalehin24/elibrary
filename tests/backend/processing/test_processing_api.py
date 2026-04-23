import json
import time as time_module
from datetime import time, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from django.db import IntegrityError
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
    PROCESSING_SYNC_KEY_CATALOG,
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


def rebuild_processing_ui_state():
    processing_services.rebuild_processing_ui_state()


def processing_state_payload(client, *, include_lists=True):
    query = "" if include_lists else "?includeLists=0"
    response = client.get(f"/api/processing/state/{query}")
    assert response.status_code == 200
    return response.json()


def processing_mutation(client, previous_versions, *, include_lists=False, extra=None):
    rebuild_processing_ui_state()
    changed_versions, _ = processing_services.processing_ui_versions_diff(
        previous_versions,
        domains=processing_services.PROCESSING_CARD_KEYS,
    )
    mutation = {
        "ok": True,
        "versions": changed_versions,
    }
    if extra:
        mutation.update(extra)
    return mutation, processing_state_payload(client, include_lists=include_lists)


def post_processing_mutation(
    client,
    path,
    body=None,
    *,
    include_lists=False,
):
    if path == "/api/processing/pipeline/advance/":
        previous_versions = processing_services.processing_ui_versions_map(
            domains=processing_services.PROCESSING_CARD_KEYS
        )
        advanced = processing_services.advance_pipeline_once()
        return processing_mutation(
            client,
            previous_versions,
            include_lists=include_lists,
            extra={"advancedCount": advanced},
        )

    if path == "/api/processing/sync/advance/" or (
        path.startswith("/api/processing/sync/")
        and path.endswith("/advance/")
    ):
        scope = None
        if path != "/api/processing/sync/advance/":
            scope = path.removeprefix("/api/processing/sync/").removesuffix("/advance/").strip("/") or None
        previous_versions = processing_services.processing_ui_versions_map(
            domains=processing_services.PROCESSING_CARD_KEYS
        )
        processing_services.advance_sync_once(scope)
        return processing_mutation(
            client,
            previous_versions,
            include_lists=include_lists,
        )

    response = client.post(path, body, content_type="application/json")
    assert response.status_code == 200
    mutation = response.json()
    assert mutation["ok"] is True
    assert "versions" in mutation
    rebuild_processing_ui_state()
    return mutation, processing_state_payload(client, include_lists=include_lists)


def advance_processing_sync(client, *, count=1):
    payload = None
    for _ in range(count):
        _mutation, payload = post_processing_mutation(
            client,
            "/api/processing/sync/advance/",
            include_lists=False,
        )
    return payload


def advance_processing_pipeline(client, *, count=1, include_lists=False):
    mutation = None
    payload = None
    for _ in range(count):
        mutation, payload = post_processing_mutation(
            client,
            "/api/processing/pipeline/advance/",
            include_lists=include_lists,
        )
    return mutation, payload


class FakeProcessingCheckpointRedis:
    def __init__(self, initial=None):
        self.store = dict(initial or {})

    def set(self, key, value):
        self.store[key] = value
        return True

    def delete(self, key):
        self.store.pop(key, None)
        return 1


def set_catalog_runtime_state(
    sync_state,
    *,
    sync_status,
    request_creation_status,
    top_status=None,
    sync_owner="manual",
    request_creation_owner="catalog_automation",
    next_page_index=0,
    fetched_count=0,
    session_id="catalog-matrix-session",
    request_creation=None,
):
    checkpoint_token = processing_services.catalog_sync_checkpoint_token(
        session_id,
        next_page_index=next_page_index,
        fetched_count=fetched_count,
    )
    sync_phase_state = processing_services._catalog_phase_state(
        processing_services.CATALOG_SYNC_PHASE,
        status=sync_status,
        owner=sync_owner if sync_status != "not_started" else "",
        trigger_source=processing_services.SYNC_TRIGGER_SOURCE_BUTTON,
        checkpoint=f"page-{next_page_index}" if sync_status != "not_started" else "",
        saved_data=(
            {
                "runMode": sync_owner,
                "triggerSource": processing_services.SYNC_TRIGGER_SOURCE_BUTTON,
                "sessionId": session_id,
                "checkpointToken": checkpoint_token,
                "nextPageIndex": next_page_index,
                "fetchedCount": fetched_count,
            }
            if sync_status != "not_started"
            else {}
        ),
    )
    request_creation_payload = request_creation
    if request_creation_payload is None and request_creation_status != "not_started":
        request_creation_payload = {
            "baseCheckpointToken": checkpoint_token,
            "lastRecordId": "matrix-record-1",
            "processedCount": 1,
            "createdCount": 1,
            "unsupportedCount": 0,
        }
    request_creation_phase_state = processing_services._catalog_phase_state(
        processing_services.CATALOG_REQUEST_CREATION_PHASE,
        status=request_creation_status,
        owner=request_creation_owner if request_creation_status != "not_started" else "",
        trigger_source=processing_services.SYNC_TRIGGER_SOURCE_BUTTON,
        checkpoint=(
            f"request-{request_creation_payload.get('lastRecordId') or request_creation_payload.get('processedCount', 0)}"
            if request_creation_payload
            else ""
        ),
        request_creation=request_creation_payload,
        base_sync_checkpoint_token=checkpoint_token if request_creation_payload else "",
    )
    phase_states = {
        processing_services.CATALOG_SYNC_PHASE: sync_phase_state,
        processing_services.CATALOG_REQUEST_CREATION_PHASE: request_creation_phase_state,
    }
    sync_state.status = top_status or processing_services.catalog_runtime_status(phase_states)
    sync_state.progress = processing_services.build_catalog_progress_payload(phase_states)
    sync_state.page_index = next_page_index
    sync_state.fetched_count = fetched_count
    sync_state.save(
        update_fields=[
            "status",
            "progress",
            "page_index",
            "fetched_count",
            "updated_at",
        ]
    )
    return sync_state


def catalog_matrix_request_creation_payload(
    *,
    session_id="catalog-matrix-session",
    next_page_index=1,
    fetched_count=1,
    last_record_id="matrix-record-1",
    processed_count=1,
    created_count=1,
    unsupported_count=0,
):
    return {
        "baseCheckpointToken": processing_services.catalog_sync_checkpoint_token(
            session_id,
            next_page_index=next_page_index,
            fetched_count=fetched_count,
        ),
        "lastRecordId": last_record_id,
        "processedCount": processed_count,
        "createdCount": created_count,
        "unsupportedCount": unsupported_count,
    }


def assert_catalog_matrix_payload(
    payload,
    *,
    status,
    phase,
    run_mode,
    sync_status,
    request_creation_status,
    sync_owner=None,
    request_creation_owner=None,
    request_creation=None,
):
    compatibility_status = (
        lambda value: "running" if value == "pausing" else value
    )
    assert payload["sync"]["status"] == status
    assert payload["sync"]["phase"] == phase
    assert payload["sync"]["runMode"] == run_mode
    assert (
        payload["sync"]["progress"]["phaseStatuses"]["sync"]
        == compatibility_status(sync_status)
    )
    assert (
        payload["sync"]["progress"]["phaseStatuses"]["request_creation"]
        == compatibility_status(request_creation_status)
    )
    assert payload["sync"]["progress"]["phaseStates"]["sync"]["status"] == sync_status
    assert (
        payload["sync"]["progress"]["phaseStates"]["request_creation"]["status"]
        == request_creation_status
    )
    if sync_owner is not None:
        assert payload["sync"]["progress"]["phaseStates"]["sync"]["owner"] == sync_owner
    if request_creation_owner is not None:
        assert (
            payload["sync"]["progress"]["phaseStates"]["request_creation"]["owner"]
            == request_creation_owner
        )
    if request_creation is None:
        assert "requestCreation" not in payload["sync"]["progress"]
    else:
        assert payload["sync"]["progress"]["requestCreation"] == request_creation


CATALOG_MANUAL_MATRIX_CASES = [
    pytest.param(
        {
            "initial": {
                "sync_status": "not_started",
                "request_creation_status": "not_started",
                "top_status": ProcessingSyncStatus.IDLE,
                "sync_owner": "manual",
            },
            "action": {"path": "/api/processing/sync/start/"},
            "expected": {
                "status": "syncing",
                "phase": "sync",
                "run_mode": "manual",
                "sync_status": "running",
                "request_creation_status": "not_started",
                "sync_owner": "manual",
                "request_creation": None,
            },
        },
        id="manual-not_started-not_started",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "running",
                "request_creation_status": "not_started",
                "top_status": ProcessingSyncStatus.SYNCING,
                "sync_owner": "manual",
            },
            "action": {"path": "/api/processing/sync/catalog/pause/"},
            "expected": {
                "status": "pausing",
                "phase": "sync",
                "run_mode": "manual",
                "sync_status": "pausing",
                "request_creation_status": "not_started",
                "sync_owner": "manual",
                "request_creation": None,
            },
        },
        id="manual-running-not_started",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "pausing",
                "request_creation_status": "not_started",
                "top_status": ProcessingSyncStatus.PAUSING,
                "sync_owner": "manual",
            },
            "action": {"path": "/api/processing/sync/start/"},
            "expected": {
                "status": "pausing",
                "phase": "sync",
                "run_mode": "manual",
                "sync_status": "pausing",
                "request_creation_status": "not_started",
                "sync_owner": "manual",
                "request_creation": None,
            },
        },
        id="manual-pausing-not_started",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "paused",
                "request_creation_status": "not_started",
                "top_status": ProcessingSyncStatus.PAUSED,
                "sync_owner": "manual",
            },
            "action": {
                "path": "/api/processing/sync/catalog/resume/",
                "body": {"runMode": "manual"},
            },
            "expected": {
                "status": "syncing",
                "phase": "sync",
                "run_mode": "manual",
                "sync_status": "running",
                "request_creation_status": "not_started",
                "sync_owner": "manual",
                "request_creation": None,
            },
        },
        id="manual-paused-not_started",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "completed",
                "request_creation_status": "not_started",
                "top_status": ProcessingSyncStatus.IDLE,
                "sync_owner": "manual",
            },
            "action": {"path": "/api/processing/sync/start/"},
            "expected": {
                "status": "syncing",
                "phase": "sync",
                "run_mode": "manual",
                "sync_status": "running",
                "request_creation_status": "not_started",
                "sync_owner": "manual",
                "request_creation": None,
            },
        },
        id="manual-completed-not_started",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "completed",
                "request_creation_status": "running",
                "top_status": ProcessingSyncStatus.SYNCING,
                "sync_owner": "manual",
            },
            "action": {"path": "/api/processing/sync/start/"},
            "expected": {
                "status": "syncing",
                "phase": "request_creation",
                "run_mode": "catalog_automation",
                "sync_status": "completed",
                "request_creation_status": "running",
                "sync_owner": "manual",
                "request_creation_owner": "catalog_automation",
                "request_creation": catalog_matrix_request_creation_payload(),
            },
        },
        id="manual-completed-running",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "completed",
                "request_creation_status": "pausing",
                "top_status": ProcessingSyncStatus.PAUSING,
                "sync_owner": "manual",
            },
            "action": {"path": "/api/processing/sync/start/"},
            "expected": {
                "status": "pausing",
                "phase": "request_creation",
                "run_mode": "catalog_automation",
                "sync_status": "completed",
                "request_creation_status": "pausing",
                "sync_owner": "manual",
                "request_creation_owner": "catalog_automation",
                "request_creation": catalog_matrix_request_creation_payload(),
            },
        },
        id="manual-completed-pausing",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "completed",
                "request_creation_status": "paused",
                "top_status": ProcessingSyncStatus.PAUSED,
                "sync_owner": "manual",
            },
            "action": {"path": "/api/processing/sync/start/"},
            "expected": {
                "status": "syncing",
                "phase": "sync",
                "run_mode": "manual",
                "sync_status": "running",
                "request_creation_status": "paused",
                "sync_owner": "manual",
                "request_creation_owner": "catalog_automation",
                "request_creation": catalog_matrix_request_creation_payload(),
            },
        },
        id="manual-completed-paused",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "completed",
                "request_creation_status": "completed",
                "top_status": ProcessingSyncStatus.IDLE,
                "sync_owner": "manual",
                "request_creation": {},
            },
            "action": {"path": "/api/processing/sync/start/"},
            "expected": {
                "status": "syncing",
                "phase": "sync",
                "run_mode": "manual",
                "sync_status": "running",
                "request_creation_status": "not_started",
                "sync_owner": "manual",
                "request_creation": None,
            },
        },
        id="manual-completed-completed",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "paused",
                "request_creation_status": "paused",
                "top_status": ProcessingSyncStatus.PAUSED,
                "sync_owner": "manual",
            },
            "action": {
                "path": "/api/processing/sync/catalog/resume/",
                "body": {"runMode": "manual"},
            },
            "expected": {
                "status": "syncing",
                "phase": "sync",
                "run_mode": "manual",
                "sync_status": "running",
                "request_creation_status": "paused",
                "sync_owner": "manual",
                "request_creation_owner": "catalog_automation",
                "request_creation": catalog_matrix_request_creation_payload(),
            },
        },
        id="manual-paused-paused",
    ),
]


CATALOG_AUTOMATION_MATRIX_CASES = [
    pytest.param(
        {
            "initial": {
                "sync_status": "not_started",
                "request_creation_status": "not_started",
                "top_status": ProcessingSyncStatus.IDLE,
                "sync_owner": "catalog_automation",
            },
            "action": {"path": "/api/processing/automation/catalog/run/"},
            "expected": {
                "status": "syncing",
                "phase": "sync",
                "run_mode": "catalog_automation",
                "sync_status": "running",
                "request_creation_status": "not_started",
                "sync_owner": "catalog_automation",
                "request_creation": None,
            },
        },
        id="automation-not_started-not_started",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "running",
                "request_creation_status": "not_started",
                "top_status": ProcessingSyncStatus.SYNCING,
                "sync_owner": "catalog_automation",
            },
            "action": {"path": "/api/processing/sync/catalog/pause/"},
            "expected": {
                "status": "pausing",
                "phase": "sync",
                "run_mode": "catalog_automation",
                "sync_status": "pausing",
                "request_creation_status": "not_started",
                "sync_owner": "catalog_automation",
                "request_creation": None,
            },
        },
        id="automation-running-not_started",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "pausing",
                "request_creation_status": "not_started",
                "top_status": ProcessingSyncStatus.PAUSING,
                "sync_owner": "catalog_automation",
            },
            "action": {"path": "/api/processing/automation/catalog/run/"},
            "expected": {
                "status": "pausing",
                "phase": "sync",
                "run_mode": "catalog_automation",
                "sync_status": "pausing",
                "request_creation_status": "not_started",
                "sync_owner": "catalog_automation",
                "request_creation": None,
            },
        },
        id="automation-pausing-not_started",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "paused",
                "request_creation_status": "not_started",
                "top_status": ProcessingSyncStatus.PAUSED,
                "sync_owner": "catalog_automation",
            },
            "action": {
                "path": "/api/processing/sync/catalog/resume/",
                "body": {"runMode": "catalog_automation"},
            },
            "expected": {
                "status": "syncing",
                "phase": "sync",
                "run_mode": "catalog_automation",
                "sync_status": "running",
                "request_creation_status": "not_started",
                "sync_owner": "catalog_automation",
                "request_creation": None,
            },
        },
        id="automation-paused-not_started",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "completed",
                "request_creation_status": "not_started",
                "top_status": ProcessingSyncStatus.IDLE,
                "sync_owner": "manual",
            },
            "action": {"path": "/api/processing/automation/catalog/run/"},
            "expected": {
                "status": "syncing",
                "phase": "request_creation",
                "run_mode": "catalog_automation",
                "sync_status": "completed",
                "request_creation_status": "running",
                "sync_owner": "manual",
                "request_creation_owner": "catalog_automation",
                "request_creation": {
                    **catalog_matrix_request_creation_payload(),
                    "lastRecordId": "",
                    "processedCount": 0,
                    "createdCount": 0,
                },
            },
        },
        id="automation-completed-not_started",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "completed",
                "request_creation_status": "running",
                "top_status": ProcessingSyncStatus.SYNCING,
                "sync_owner": "manual",
            },
            "action": {"path": "/api/processing/sync/catalog/pause/"},
            "expected": {
                "status": "pausing",
                "phase": "request_creation",
                "run_mode": "catalog_automation",
                "sync_status": "completed",
                "request_creation_status": "pausing",
                "sync_owner": "manual",
                "request_creation_owner": "catalog_automation",
                "request_creation": catalog_matrix_request_creation_payload(),
            },
        },
        id="automation-completed-running",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "completed",
                "request_creation_status": "pausing",
                "top_status": ProcessingSyncStatus.PAUSING,
                "sync_owner": "manual",
            },
            "action": {"path": "/api/processing/automation/catalog/run/"},
            "expected": {
                "status": "pausing",
                "phase": "request_creation",
                "run_mode": "catalog_automation",
                "sync_status": "completed",
                "request_creation_status": "pausing",
                "sync_owner": "manual",
                "request_creation_owner": "catalog_automation",
                "request_creation": catalog_matrix_request_creation_payload(),
            },
        },
        id="automation-completed-pausing",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "completed",
                "request_creation_status": "paused",
                "top_status": ProcessingSyncStatus.PAUSED,
                "sync_owner": "manual",
            },
            "action": {
                "path": "/api/processing/sync/catalog/resume/",
                "body": {"runMode": "catalog_automation"},
            },
            "expected": {
                "status": "syncing",
                "phase": "request_creation",
                "run_mode": "catalog_automation",
                "sync_status": "completed",
                "request_creation_status": "running",
                "sync_owner": "manual",
                "request_creation_owner": "catalog_automation",
                "request_creation": catalog_matrix_request_creation_payload(),
            },
        },
        id="automation-completed-paused",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "completed",
                "request_creation_status": "completed",
                "top_status": ProcessingSyncStatus.IDLE,
                "sync_owner": "manual",
                "request_creation": {},
            },
            "action": {"path": "/api/processing/automation/catalog/run/"},
            "expected": {
                "status": "syncing",
                "phase": "sync",
                "run_mode": "catalog_automation",
                "sync_status": "running",
                "request_creation_status": "not_started",
                "sync_owner": "catalog_automation",
                "request_creation": None,
            },
        },
        id="automation-completed-completed",
    ),
    pytest.param(
        {
            "initial": {
                "sync_status": "paused",
                "request_creation_status": "paused",
                "top_status": ProcessingSyncStatus.PAUSED,
                "sync_owner": "manual",
            },
            "action": {
                "path": "/api/processing/sync/catalog/resume/",
                "body": {"runMode": "catalog_automation"},
            },
            "expected": {
                "status": "syncing",
                "phase": "request_creation",
                "run_mode": "catalog_automation",
                "sync_status": "paused",
                "request_creation_status": "running",
                "sync_owner": "manual",
                "request_creation_owner": "catalog_automation",
                "request_creation": catalog_matrix_request_creation_payload(),
            },
        },
        id="automation-paused-paused",
    ),
]


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
def test_processing_domains_for_request_change_ignore_incomplete_domains_for_regular_request_updates():
    record = BookRecord.objects.create(
        id="plain-record",
        name="Plain Record",
        url="https://example.test/books/plain-record",
        category="Novel",
        writer="Writer One",
        publisher="Example Press",
    )
    domains = processing_services.processing_domains_for_request_change(
        "initial",
        "queued",
        record=record,
    )

    assert "create-requests" in domains
    assert "create-queue" in domains
    assert processing_services.PROCESSING_CARD_INCOMPLETE_OVERVIEW not in domains
    assert "incomplete-records" not in domains
    assert "incomplete-completed" not in domains


@pytest.mark.django_db
def test_processing_domains_for_request_change_include_catalog_domains_for_request_progression():
    record = BookRecord.objects.create(
        id="catalog-pipeline-record",
        name="Catalog Pipeline Record",
        url="https://example.test/books/catalog-pipeline-record",
        category="Novel",
        writer="Writer One",
        publisher="Example Press",
    )
    domains = processing_services.processing_domains_for_request_change(
        "initial",
        "queued",
        record=record,
    )

    assert "create-requests" in domains
    assert "create-queue" in domains
    assert "catalog-overview" in domains
    assert "catalog-records" in domains


@pytest.mark.django_db
def test_processing_domains_for_record_change_include_incomplete_domains_for_resolution_updates():
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
    before_snapshot = processing_services.processing_record_snapshot(record)

    record.category = "Novel"
    record.resolved_from_incomplete = True
    record.book_creation_state = "created"
    after_snapshot = processing_services.processing_record_snapshot(record)

    domains = processing_services.processing_domains_for_record_change(
        before_snapshot,
        after_snapshot,
        current_request_state="created",
    )

    assert processing_services.PROCESSING_CARD_INCOMPLETE_OVERVIEW in domains
    assert "incomplete-records" in domains
    assert "incomplete-completed" in domains


@pytest.mark.django_db
def test_processing_domains_for_record_change_keep_completed_idle_during_incomplete_hydration():
    record = BookRecord.objects.create(
        id="hydrating-incomplete-record",
        name="Hydrating Incomplete Record",
        url="https://example.test/books/hydrating-incomplete-record",
        category="অসম্পূর্ণ বই",
        writer="Writer One",
        publisher="Example Press",
        was_incomplete=True,
        resolved_from_incomplete=False,
        will_resolve_to_category="Novel",
    )
    domains = processing_services.processing_domains_for_record_change(
        None,
        processing_services.processing_record_snapshot(record),
        current_request_state=None,
    )

    assert processing_services.PROCESSING_CARD_INCOMPLETE_OVERVIEW in domains
    assert "incomplete-records" in domains
    assert "incomplete-completed" not in domains


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

    _mutation, payload = post_processing_mutation(
        client,
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
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["updatedCount"] == 0
    assert BookRecord.objects.get(pk="existing-record").name == "Existing"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["updatedCount"] == 1
    existing = BookRecord.objects.get(pk="existing-record")
    assert existing.name == "Existing Revised"
    assert existing.url == "https://example.test/books/existing-revised"
    assert existing.category == "Updated"
    assert existing.writer == "Updated Writer"
    assert existing.translator == "Updated Translator"
    assert existing.publisher == "Updated Press"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/pause/",
    )
    assert payload["sync"]["status"] == "pausing"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/resume/",
    )
    assert payload["sync"]["status"] == "syncing"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "idle"
    assert payload["sync"]["skippedCount"] == 0
    assert payload["sync"]["appendedCount"] == 1
    assert BookRecord.objects.filter(pk="new-record").exists()

    _mutation, payload = post_processing_mutation(
        client,
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
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["message"] == "Syncing catalog records."
    assert payload["sync"]["pageIndex"] == 0
    assert payload["sync"]["fetchedCount"] == 0


@pytest.mark.django_db
def test_processing_sync_mirrors_checkpoint_progress_and_clears_it_on_stop(
    client, monkeypatch
):
    login_processing_admin(client)

    class FakeCheckpointClient:
        def __init__(self):
            self.store = {}

        def set(self, key, value):
            self.store[key] = value

        def delete(self, key):
            self.store.pop(key, None)

    fake_checkpoint_client = FakeCheckpointClient()
    monkeypatch.setattr(
        "apps.processing.services.processing_checkpoint_client",
        lambda: fake_checkpoint_client,
    )

    response = client.post(
        "/api/processing/sync/start/",
        {
            "remotePages": [
                [record_payload("mirrored-sync-record", name="Mirrored Sync Record")],
                [],
            ]
        },
        content_type="application/json",
    )

    assert response.status_code == 200
    checkpoint_key = processing_services.processing_sync_checkpoint_key("catalog")
    mirrored_payload = json.loads(fake_checkpoint_client.store[checkpoint_key])
    assert mirrored_payload["status"] == "syncing"
    assert mirrored_payload["progress"]["savedData"]["nextPageIndex"] == 0

    response = client.post("/api/processing/sync/pause/", content_type="application/json")
    assert response.status_code == 200
    _mutation, _payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )

    mirrored_payload = json.loads(fake_checkpoint_client.store[checkpoint_key])
    assert mirrored_payload["status"] == "paused"
    assert mirrored_payload["progress"]["savedData"]["nextPageIndex"] == 1
    assert mirrored_payload["fetchedCount"] == 1

    response = client.post("/api/processing/sync/stop/", content_type="application/json")
    assert response.status_code == 200
    assert checkpoint_key not in fake_checkpoint_client.store


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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/start/",
        {},
    )
    assert payload["sync"]["status"] == "syncing"

    payload = advance_processing_sync(client, count=2)
    assert payload["sync"]["status"] == "idle"
    record = BookRecord.objects.get(pk=str(entry.id))
    assert record.name == "Source Catalog Record"
    assert record.url == "https://example.test/books/source-catalog-record"
    assert record.category == "Source Category"
    assert record.writer == "Source Author"
    assert record.publisher == "Source Publisher"


@pytest.mark.django_db
def test_processing_stream_emits_versions_without_advancing_sync(client, monkeypatch):
    login_processing_admin(client)

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
    diff_calls = {"count": 0}

    def fake_versions_diff(previous_versions, *, domains=None):
        diff_calls["count"] += 1
        if diff_calls["count"] == 1:
            next_versions = dict(previous_versions)
            next_versions["catalog-sync"] = 1
            return {"catalog-sync": 1}, next_versions
        raise GeneratorExit

    monkeypatch.setattr(
        "apps.processing.views.processing_ui_versions_diff",
        fake_versions_diff,
    )

    response = client.get("/api/processing/stream/?page=catalog")

    assert response.status_code == 200
    stream = iter(response.streaming_content)
    assert next(stream).decode() == "event: connected\ndata: {}\n\n"

    versions_event = next(stream).decode()
    assert "event: versions" in versions_event
    payload = json.loads(versions_event.split("data: ", 1)[1])
    assert payload["versions"] == {"catalog-sync": 1}

    sync_state = get_sync_state()
    assert sync_state.status == "syncing"
    assert not BookRecord.objects.filter(pk="stream-sync-record").exists()


@pytest.mark.django_db
def test_processing_runtime_tick_advances_sync_and_pipeline_without_browser(client, monkeypatch):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="runtime-tick-request-record",
        name="Runtime Tick Request Record",
        url="https://www.ebanglalibrary.com/books/runtime-tick-request-record/",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
    )
    BookCreationRequest.objects.create(
        id="runtime-tick-request",
        book_record=record,
        state="initial",
    )

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/start/",
        {
            "remotePages": [
                [record_payload("runtime-tick-sync-record")],
                [],
            ]
        },
    )
    assert payload["sync"]["status"] == "syncing"

    monkeypatch.setattr(
        "apps.processing.services.should_run_processing_jobs_inline",
        lambda: False,
    )
    monkeypatch.setattr(
        "apps.processing.services.processing_workers_available",
        lambda *_args, **_kwargs: False,
    )

    result = processing_services.run_processing_runtime_tick()

    sync_state = get_sync_state()
    processing_request = BookCreationRequest.objects.get(pk="runtime-tick-request")
    synced_record = BookRecord.objects.get(pk="runtime-tick-sync-record")

    assert result["advancedCount"] == 1
    assert result["sync"]["catalog"]["status"] == "idle"
    assert sync_state.status == "idle"
    assert synced_record.name == "runtime-tick-sync-record title"
    assert processing_request.state == "queued"


@pytest.mark.django_db
def test_processing_state_does_not_advance_processing_pipeline(client, monkeypatch):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="read-only-pipeline-record",
        name="Read Only Pipeline Record",
        url="https://example.test/books/read-only-pipeline-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="processing",
    )
    processing_request = BookCreationRequest.objects.create(
        id="read-only-pipeline-request",
        book_record=record,
        state="processing",
    )
    run_calls = {"count": 0}

    monkeypatch.setattr(
        "apps.processing.services._run_processing_request",
        lambda request: run_calls.__setitem__("count", run_calls["count"] + 1),
    )

    response = client.get("/api/processing/state/?includeLists=0")

    assert response.status_code == 200
    processing_request.refresh_from_db()
    record.refresh_from_db()
    assert run_calls["count"] == 0
    assert processing_request.state == "processing"
    assert record.book_creation_state == "processing"


@pytest.mark.django_db
def test_processing_table_does_not_advance_processing_pipeline(client, monkeypatch):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="read-only-table-record",
        name="Read Only Table Record",
        url="https://example.test/books/read-only-table-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="processing",
    )
    processing_request = BookCreationRequest.objects.create(
        id="read-only-table-request",
        book_record=record,
        state="processing",
    )
    run_calls = {"count": 0}

    monkeypatch.setattr(
        "apps.processing.services._run_processing_request",
        lambda request: run_calls.__setitem__("count", run_calls["count"] + 1),
    )

    response = client.get("/api/processing/table/?card=create-processing")

    assert response.status_code == 200
    processing_request.refresh_from_db()
    record.refresh_from_db()
    assert run_calls["count"] == 0
    assert processing_request.state == "processing"
    assert record.book_creation_state == "processing"


@pytest.mark.django_db
def test_processing_state_reads_primary_sync_from_projection_rows_only(monkeypatch):
    rebuild_processing_ui_state()

    catalog_projection = processing_services.ProcessingUiProjection.objects.get(
        key="catalog-sync"
    )
    incomplete_projection = processing_services.ProcessingUiProjection.objects.get(
        key="incomplete-automation"
    )
    catalog_payload = {
        **catalog_projection.payload,
        "sync": {
            **catalog_projection.payload["sync"],
            "status": "idle",
            "message": "Catalog idle first.",
        },
    }
    incomplete_payload = {
        **incomplete_projection.payload,
        "sync": {
            **incomplete_projection.payload["sync"],
            "status": "idle",
            "message": "Incomplete idle last.",
            "runMode": "incomplete_automation",
            "scope": "incomplete",
        },
    }
    now = timezone.now()
    processing_services.ProcessingUiProjection.objects.filter(
        pk=catalog_projection.pk
    ).update(payload=catalog_payload, updated_at=now - timedelta(minutes=2))
    processing_services.ProcessingUiProjection.objects.filter(
        pk=incomplete_projection.pk
    ).update(payload=incomplete_payload, updated_at=now - timedelta(minutes=1))

    monkeypatch.setattr(
        "apps.processing.services.processing_shared_projection_payloads",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("processing state should not rebuild shared projections")
        ),
    )

    payload = processing_services.processing_state_payload(include_lists=False)
    assert payload["sync"]["scope"] == "incomplete"
    assert payload["sync"]["message"] == "Incomplete idle last."


@pytest.mark.django_db
def test_save_sync_state_catalog_publishes_only_catalog_sync_domain(
    django_capture_on_commit_callbacks,
):
    state = get_sync_state(PROCESSING_SYNC_KEY_CATALOG)
    previous_versions = processing_services.processing_ui_versions_map(
        domains=["catalog-sync", "catalog-automation"]
    )

    state.status = ProcessingSyncStatus.SYNCING
    state.message = "Catalog sync is running."
    with django_capture_on_commit_callbacks(execute=True):
        processing_services.save_sync_state(state)

    current_versions = processing_services.processing_ui_versions_map(
        domains=["catalog-sync", "catalog-automation"]
    )
    assert current_versions["catalog-sync"] == previous_versions["catalog-sync"] + 1
    assert current_versions["catalog-automation"] == previous_versions["catalog-automation"]


@pytest.mark.django_db
def test_save_sync_state_refreshes_catalog_automation_projection_without_bumping_its_domain(
    django_capture_on_commit_callbacks,
):
    state = get_sync_state(PROCESSING_SYNC_KEY_CATALOG)
    previous_versions = processing_services.processing_ui_versions_map(
        domains=["catalog-sync", "catalog-automation"]
    )

    state.status = ProcessingSyncStatus.SYNCING
    state.message = "Catalog sync is running."
    with django_capture_on_commit_callbacks(execute=True):
        processing_services.save_sync_state(state)

    current_versions = processing_services.processing_ui_versions_map(
        domains=["catalog-sync", "catalog-automation"]
    )
    catalog_automation_projection = processing_services.processing_ui_shared_projection_payload(
        "catalog-automation"
    )

    assert current_versions["catalog-sync"] == previous_versions["catalog-sync"] + 1
    assert current_versions["catalog-automation"] == previous_versions["catalog-automation"]
    assert catalog_automation_projection["sync"]["status"] == "syncing"
    assert catalog_automation_projection["sync"]["message"] == "Catalog sync is running."


@pytest.mark.django_db
def test_collect_processing_ui_version_updates_tracks_committed_versions(
    django_capture_on_commit_callbacks,
):
    state = get_sync_state(PROCESSING_SYNC_KEY_CATALOG)
    previous_versions = processing_services.processing_ui_versions_map(
        domains=["catalog-sync"]
    )

    state.status = ProcessingSyncStatus.SYNCING
    state.message = "Catalog sync is running."
    with processing_services.collect_processing_ui_version_updates() as versions:
        with django_capture_on_commit_callbacks(execute=True):
            processing_services.save_sync_state(state)

    assert versions == {
        "catalog-sync": previous_versions["catalog-sync"] + 1,
    }


@pytest.mark.django_db
def test_save_sync_state_incomplete_publishes_only_incomplete_automation_domain(
    django_capture_on_commit_callbacks,
):
    state = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    previous_versions = processing_services.processing_ui_versions_map(
        domains=["incomplete-automation", "catalog-sync"]
    )

    state.status = ProcessingSyncStatus.SYNCING
    state.message = "Incomplete sync is running."
    with django_capture_on_commit_callbacks(execute=True):
        processing_services.save_sync_state(state)

    current_versions = processing_services.processing_ui_versions_map(
        domains=["incomplete-automation", "catalog-sync"]
    )
    assert (
        current_versions["incomplete-automation"]
        == previous_versions["incomplete-automation"] + 1
    )
    assert current_versions["catalog-sync"] == previous_versions["catalog-sync"]


@pytest.mark.django_db
def test_processing_request_action_response_excludes_unrelated_version_bumps(
    client,
    monkeypatch,
):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="mutation-scope-record",
        name="Mutation Scope Record",
        url="https://example.test/books/mutation-scope-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="initial",
    )
    processing_request = BookCreationRequest.objects.create(
        id="mutation-scope-request",
        book_record=record,
        state="initial",
    )
    rebuild_processing_ui_state()

    real_apply_request_action = processing_services.apply_request_action

    def apply_action_with_unrelated_bump(*args, **kwargs):
        changed = real_apply_request_action(*args, **kwargs)
        version_row = processing_services.ProcessingUiDomainVersion.objects.get(
            domain="catalog-sync"
        )
        version_row.version += 1
        version_row.save(update_fields=["version", "updated_at"])
        return changed

    monkeypatch.setattr(
        "apps.processing.views.apply_request_action",
        apply_action_with_unrelated_bump,
    )

    response = client.post(
        "/api/processing/requests/action/",
        {
            "ids": [processing_request.id],
            "action": "delete",
            "deleteBook": False,
        },
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["versions"]
    assert "catalog-sync" not in payload["versions"]


@pytest.mark.django_db
def test_catalog_record_upsert_bumps_only_catalog_domains(
    django_capture_on_commit_callbacks,
):
    record = BookRecord.objects.create(
        id="catalog-upsert-record",
        name="Catalog Upsert Record",
        url="https://example.test/books/catalog-upsert-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="initial",
    )
    BookCreationRequest.objects.create(
        id="catalog-upsert-request",
        book_record=record,
        state="initial",
    )
    rebuild_processing_ui_state()
    previous_versions = processing_services.processing_ui_versions_map(
        domains=["catalog-overview", "catalog-records", "create-requests"]
    )

    with django_capture_on_commit_callbacks(execute=True):
        processing_services.upsert_remote_records(
            [
                record_payload(
                    "catalog-upsert-record",
                    name="Catalog Upsert Record Revised",
                    category="History",
                )
            ]
        )

    current_versions = processing_services.processing_ui_versions_map(
        domains=["catalog-overview", "catalog-records", "create-requests"]
    )
    assert (
        current_versions["catalog-overview"]
        == previous_versions["catalog-overview"] + 1
    )
    assert (
        current_versions["catalog-records"]
        == previous_versions["catalog-records"] + 1
    )
    assert current_versions["create-requests"] == previous_versions["create-requests"]


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
    catalog = ProcessingAutomationSettings.objects.get(
        kind=ProcessingAutomationKind.CATALOG
    )
    catalog.interval = "daily"
    catalog.time = time(2, 0)
    catalog.saved = False
    catalog.status_message = "Not configured."
    catalog.save(
        update_fields=["interval", "time", "saved", "status_message", "updated_at"]
    )
    incomplete = ProcessingAutomationSettings.objects.get(
        kind=ProcessingAutomationKind.INCOMPLETE
    )
    incomplete.interval = "daily"
    incomplete.time = time(3, 0)
    incomplete.saved = False
    incomplete.status_message = "Not configured."
    incomplete.save(
        update_fields=["interval", "time", "saved", "status_message", "updated_at"]
    )
    rebuild_processing_ui_state()

    response = client.get("/api/processing/state/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["automation"]["catalog"]["interval"] == "weekly"
    assert payload["automation"]["catalog"]["time"] == "03:00"
    assert payload["automation"]["catalog"]["statusMessage"] == ""
    assert payload["automation"]["incomplete"]["interval"] == "weekly"
    assert payload["automation"]["incomplete"]["time"] == "03:00"
    assert payload["automation"]["incomplete"]["statusMessage"] == ""

    catalog.refresh_from_db()
    incomplete.refresh_from_db()
    assert catalog.interval == "daily"
    assert catalog.time == time(2, 0)
    assert catalog.status_message == "Not configured."
    assert incomplete.interval == "daily"
    assert incomplete.time == time(3, 0)
    assert incomplete.status_message == "Not configured."


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
    rebuild_processing_ui_state()

    response = client.get("/api/processing/state/?includeLists=0")

    assert response.status_code == 200
    payload = response.json()
    assert "records" not in payload
    assert "requests" not in payload
    assert "versions" in payload
    assert payload["summary"]["catalog"]["records"] == 1
    assert payload["summary"]["catalog"]["onHold"] == 1
    assert payload["summary"]["onHold"]["failed"] == 1
    assert payload["summary"]["incomplete"]["incomplete"] == 1
    assert (
        payload["summary"]["notifications"]["latestFailedMessage"]
        == "Pipeline failed after retries."
    )
    assert payload["cards"]["catalog-overview"]["card"] == "catalog-overview"
    assert payload["cards"]["create-overview"]["card"] == "create-overview"
    assert payload["cards"]["catalog-sync"]["card"] == "catalog-sync"


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
    assert payload["hasMore"] is True
    assert payload["pagination"]["nextOffset"] == 60
    assert "Novel" in payload["filters"]["categoryOptions"]
    assert "Poetry" in payload["filters"]["categoryOptions"]
    assert "created" in payload["filters"]["statusOptions"]
    assert "not_created" in payload["filters"]["statusOptions"]
    assert {row["status"] for row in payload["rows"]} == {"not_created"}

    response = client.get("/api/processing/table/?card=catalog-records&offset=60&limit=60")

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["rows"]) == 15
    assert payload["pagination"]["hasMore"] is False
    assert payload["hasMore"] is False
    assert [row["status"] for row in payload["rows"][:9]] == ["not_created"] * 9
    assert [row["status"] for row in payload["rows"][9:]] == ["created"] * 6

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
def test_upsert_remote_records_recovers_when_concurrent_insert_wins(monkeypatch):
    payload = record_payload(
        "race-record",
        name="Race Winner",
        url="https://example.test/books/race-record",
        category="Novel",
        writer="Writer One",
        publisher="Example Press",
    )
    original_create = BookRecord.objects.create
    race_triggered = {"value": False}

    def create_with_concurrent_insert(**kwargs):
        if race_triggered["value"]:
            return original_create(**kwargs)

        race_triggered["value"] = True
        original_create(
            id="race-record-competing",
            name="Competing Insert",
            url=kwargs["url"],
            category="Poetry",
            writer="Other Writer",
            publisher="Other Press",
        )
        raise IntegrityError("duplicate key value violates unique constraint")

    monkeypatch.setattr(BookRecord.objects, "create", create_with_concurrent_insert)

    result = processing_services.upsert_remote_records([payload])

    record = BookRecord.objects.get(url=payload["url"])
    assert BookRecord.objects.count() == 1
    assert result["appended_count"] == 0
    assert result["updated_count"] == 1
    assert result["skipped_count"] == 0
    assert record.name == "Race Winner"
    assert record.category == "Novel"
    assert record.writer == "Writer One"
    assert record.publisher == "Example Press"


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
def test_catalog_automation_waits_for_manual_runtime_before_creating_requests(client):
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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "manual"
    assert not BookCreationRequest.objects.exists()

    payload = advance_processing_sync(client, count=2)
    assert payload["sync"]["status"] == "idle"
    assert BookRecord.objects.filter(pk="new-record").exists()
    assert BookRecord.objects.get(pk="existing-record").name == "Existing Record Revised"
    assert not BookCreationRequest.objects.exists()

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"

    payload = advance_processing_sync(client, count=3)
    assert payload["sync"]["status"] == "idle"
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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/start/",
        {"remotePages": [[record_payload("ignored-record")], []]},
    )
    assert payload["sync"]["status"] == "syncing"

    payload = advance_processing_sync(client, count=2)
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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["status"] == "syncing"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "request_creation"
    assert not BookRecord.objects.filter(pk="stale-remote-record").exists()
    assert BookRecord.objects.filter(pk=str(entry.id)).exists()

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "idle"
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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/pause/",
    )
    assert payload["sync"]["status"] == "pausing"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["runMode"] == "catalog_automation"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/resume/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"
    assert payload["sync"]["message"] == "Continuing automated catalog sync from the saved endpoint."
    assert payload["sync"]["pageIndex"] == 1

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/stop/",
    )
    assert payload["sync"]["status"] == "idle"
    assert payload["sync"]["message"] == "Automated catalog sync stopped."
    assert payload["automation"]["catalog"]["statusMessage"] == "Automated catalog sync stopped."


@pytest.mark.django_db
def test_manual_sync_start_takes_over_paused_automation_runtime(client):
    login_processing_admin(client)
    sync_state = get_sync_state()
    sync_state.remote_pages = [
        [record_payload("shared-page-1", name="Shared Page One")],
        [record_payload("shared-page-2", name="Shared Page Two")],
        [],
    ]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["runMode"] == "catalog_automation"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/pause/",
    )
    assert payload["sync"]["status"] == "pausing"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["runMode"] == "catalog_automation"
    assert payload["sync"]["fetchedCount"] == 1

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/start/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "manual"
    assert payload["sync"]["message"] == "Continuing catalog sync from the saved endpoint."
    assert payload["sync"]["fetchedCount"] == 1
    assert payload["sync"]["pageIndex"] == 1
    assert payload["sync"]["progress"]["savedData"]["fetchedCount"] == 1
    assert payload["sync"]["progress"]["savedData"]["nextPageIndex"] == 1
    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "idle"
    assert BookRecord.objects.filter(pk="shared-page-2").exists()
    assert not BookCreationRequest.objects.exists()


@pytest.mark.django_db
def test_catalog_automation_run_takes_over_paused_manual_runtime(client):
    login_processing_admin(client)

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/start/",
        {
            "remotePages": [
                [record_payload("resume-auto-page-1", name="Resume Auto Page One")],
                [record_payload("resume-auto-page-2", name="Resume Auto Page Two")],
                [],
            ]
        },
    )
    assert payload["sync"]["runMode"] == "manual"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/pause/",
    )
    assert payload["sync"]["status"] == "pausing"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["runMode"] == "manual"
    assert payload["sync"]["fetchedCount"] == 1

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"
    assert payload["sync"]["message"] == "Continuing automated catalog sync from the saved endpoint."
    assert payload["sync"]["fetchedCount"] == 1
    assert payload["sync"]["pageIndex"] == 1
    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "request_creation"
    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "idle"
    assert BookCreationRequest.objects.exists()


@pytest.mark.django_db
def test_catalog_automation_request_creation_phase_can_pause_and_resume(client, monkeypatch):
    login_processing_admin(client)
    monkeypatch.setattr(
        "apps.processing.services.CATALOG_REQUEST_CREATION_BATCH_SIZE",
        1,
    )
    BookRecord.objects.create(
        id="phase-request-a",
        name="Phase Request A",
        url="https://example.test/books/phase-request-a",
        category="Reference",
        writer="Writer One",
        publisher="Press",
    )
    BookRecord.objects.create(
        id="phase-request-b",
        name="Phase Request B",
        url="https://example.test/books/phase-request-b",
        category="Reference",
        writer="Writer Two",
        publisher="Press",
    )
    sync_state = get_sync_state()
    sync_state.remote_pages = [[record_payload("phase-request-c")], []]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    _mutation, _payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )

    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "request_creation"
    assert payload["sync"]["message"] == "Creating book requests from the synced catalog records."

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/pause/",
    )
    assert payload["sync"]["status"] == "pausing"
    assert payload["sync"]["message"] == "Pausing automated request creation after the current batch finishes."

    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["phase"] == "request_creation"
    assert payload["sync"]["progress"]["requestCreation"]["processedCount"] == 1
    assert payload["sync"]["progress"]["requestCreation"]["createdCount"] == 1

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/resume/",
        {"runMode": "catalog_automation"},
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "request_creation"
    assert payload["sync"]["message"] == "Resuming automated request creation from saved progress."

    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["progress"]["requestCreation"]["processedCount"] == 2
    assert payload["sync"]["progress"]["requestCreation"]["createdCount"] == 2

    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "idle"
    assert BookCreationRequest.objects.filter(book_record_id="phase-request-a", state="initial").exists()
    assert BookCreationRequest.objects.filter(book_record_id="phase-request-b", state="initial").exists()
    assert BookCreationRequest.objects.filter(book_record_id="phase-request-c", state="initial").exists()
    assert payload["automation"]["catalog"]["statusMessage"] == "Created 3 requests."


@pytest.mark.django_db
def test_manual_start_from_paused_automation_request_creation_preserves_phase_two_checkpoint(
    client,
    monkeypatch,
):
    login_processing_admin(client)
    monkeypatch.setattr(
        "apps.processing.services.CATALOG_REQUEST_CREATION_BATCH_SIZE",
        1,
    )
    BookRecord.objects.create(
        id="carry-existing",
        name="Carry Existing",
        url="https://example.test/books/carry-existing",
        category="Reference",
        writer="Writer One",
        publisher="Press",
    )
    sync_state = get_sync_state()
    sync_state.remote_pages = [[record_payload("carry-new")], []]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    _mutation, _payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )

    payload = advance_processing_sync(client)
    assert payload["sync"]["phase"] == "request_creation"

    _mutation, _payload = post_processing_mutation(
        client,
        "/api/processing/sync/pause/",
    )
    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["progress"]["requestCreation"]["processedCount"] == 1

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/start/",
        {"remotePages": [[record_payload("carry-new")], []]},
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "manual"
    assert payload["sync"]["message"] == "Syncing catalog records."
    assert payload["sync"]["pageIndex"] == 0
    assert payload["sync"]["fetchedCount"] == 0
    assert payload["sync"]["progress"]["phaseStatuses"]["sync"] == "running"
    assert payload["sync"]["progress"]["phaseStatuses"]["request_creation"] == "paused"
    assert payload["sync"]["progress"]["requestCreation"]["processedCount"] == 1
    assert (
        payload["sync"]["progress"]["phaseStates"]["request_creation"]["status"]
        == "paused"
    )

    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["message"].startswith("Sync complete.")
    assert payload["sync"]["progress"]["phaseStatuses"]["sync"] == "completed"
    assert payload["sync"]["progress"]["phaseStatuses"]["request_creation"] == "paused"
    assert payload["sync"]["progress"]["requestCreation"]["processedCount"] == 1
    assert BookCreationRequest.objects.count() == 1

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "request_creation"
    assert payload["sync"]["message"] == "Resuming automated request creation from saved progress."
    assert payload["sync"]["progress"]["phaseStatuses"]["sync"] == "completed"
    assert payload["sync"]["progress"]["phaseStatuses"]["request_creation"] == "running"

    payload = advance_processing_sync(client, count=2)
    assert payload["sync"]["status"] == "idle"
    assert BookCreationRequest.objects.count() == 2


@pytest.mark.django_db
def test_catalog_automation_rerun_after_completion_starts_from_beginning(client):
    login_processing_admin(client)
    sync_state = get_sync_state()
    sync_state.remote_pages = [
        [record_payload("rerun-auto-page-1", name="Rerun Auto Page One")],
        [record_payload("rerun-auto-page-2", name="Rerun Auto Page Two")],
        [],
    ]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    _mutation, _payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )

    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "syncing"
    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "request_creation"
    payload = advance_processing_sync(client)
    assert payload["sync"]["status"] == "idle"
    assert payload["sync"]["progress"]["phaseStatuses"]["sync"] == "completed"
    assert payload["sync"]["progress"]["phaseStatuses"]["request_creation"] == "completed"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "sync"
    assert payload["sync"]["pageIndex"] == 0
    assert payload["sync"]["fetchedCount"] == 0
    assert payload["sync"]["message"] == "Automated catalog sync is running."
    assert payload["sync"]["progress"]["phaseStatuses"]["sync"] == "running"
    assert payload["sync"]["progress"]["phaseStatuses"]["request_creation"] == "not_started"
    assert "requestCreation" not in payload["sync"]["progress"]


@pytest.mark.django_db
@pytest.mark.parametrize("case", CATALOG_MANUAL_MATRIX_CASES)
def test_catalog_manual_matrix_rows(client, case):
    login_processing_admin(client)
    sync_state = get_sync_state()
    set_catalog_runtime_state(
        sync_state,
        sync_status=case["initial"]["sync_status"],
        request_creation_status=case["initial"]["request_creation_status"],
        top_status=case["initial"]["top_status"],
        sync_owner=case["initial"]["sync_owner"],
        request_creation_owner=case["initial"].get(
            "request_creation_owner",
            "catalog_automation",
        ),
        next_page_index=case["initial"].get("next_page_index", 1),
        fetched_count=case["initial"].get("fetched_count", 1),
        request_creation=case["initial"].get("request_creation"),
    )

    _mutation, payload = post_processing_mutation(
        client,
        case["action"]["path"],
        case["action"].get("body"),
    )

    assert_catalog_matrix_payload(payload, **case["expected"])


@pytest.mark.django_db
@pytest.mark.parametrize("case", CATALOG_AUTOMATION_MATRIX_CASES)
def test_catalog_automation_matrix_rows(client, case):
    login_processing_admin(client)
    sync_state = get_sync_state()
    set_catalog_runtime_state(
        sync_state,
        sync_status=case["initial"]["sync_status"],
        request_creation_status=case["initial"]["request_creation_status"],
        top_status=case["initial"]["top_status"],
        sync_owner=case["initial"]["sync_owner"],
        request_creation_owner=case["initial"].get(
            "request_creation_owner",
            "catalog_automation",
        ),
        next_page_index=case["initial"].get("next_page_index", 1),
        fetched_count=case["initial"].get("fetched_count", 1),
        request_creation=case["initial"].get("request_creation"),
    )

    _mutation, payload = post_processing_mutation(
        client,
        case["action"]["path"],
        case["action"].get("body"),
    )

    assert_catalog_matrix_payload(payload, **case["expected"])


@pytest.mark.django_db
def test_catalog_phase_one_pause_request_preserves_paused_phase_two_checkpoint(client):
    login_processing_admin(client)
    sync_state = get_sync_state()
    paused_request_creation = catalog_matrix_request_creation_payload(
        next_page_index=3,
        fetched_count=42,
        last_record_id="matrix-running-paused",
        processed_count=7,
        created_count=5,
    )
    set_catalog_runtime_state(
        sync_state,
        sync_status="running",
        request_creation_status="paused",
        top_status=ProcessingSyncStatus.SYNCING,
        sync_owner="manual",
        next_page_index=3,
        fetched_count=42,
        request_creation=paused_request_creation,
    )

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/catalog/pause/",
    )

    assert_catalog_matrix_payload(
        payload,
        status="pausing",
        phase="sync",
        run_mode="manual",
        sync_status="pausing",
        request_creation_status="paused",
        sync_owner="manual",
        request_creation_owner="catalog_automation",
        request_creation=paused_request_creation,
    )
    assert (
        payload["sync"]["progress"]["phaseStates"]["request_creation"][
            "baseSyncCheckpointToken"
        ]
        == paused_request_creation["baseCheckpointToken"]
    )


@pytest.mark.django_db
def test_catalog_phase_states_preserve_pausing_phase_one_and_paused_phase_two_checkpoints():
    sync_state = get_sync_state()
    paused_request_creation = catalog_matrix_request_creation_payload(
        next_page_index=4,
        fetched_count=12,
        last_record_id="matrix-pausing-paused",
        processed_count=3,
        created_count=2,
    )
    set_catalog_runtime_state(
        sync_state,
        sync_status="pausing",
        request_creation_status="paused",
        top_status=ProcessingSyncStatus.PAUSING,
        sync_owner="manual",
        next_page_index=4,
        fetched_count=12,
        request_creation=paused_request_creation,
    )

    payload = processing_services.serialize_sync_state(
        sync_state,
        include_remote_pages=False,
    )

    assert payload["status"] == "pausing"
    assert payload["progress"]["phaseStatuses"]["sync"] == "running"
    assert payload["progress"]["phaseStatuses"]["request_creation"] == "paused"
    assert payload["progress"]["phaseStates"]["sync"]["status"] == "pausing"
    assert payload["progress"]["phaseStates"]["sync"]["savedData"]["checkpointToken"] == (
        processing_services.catalog_sync_checkpoint_token(
            "catalog-matrix-session",
            next_page_index=4,
            fetched_count=12,
        )
    )
    assert payload["progress"]["phaseStates"]["request_creation"]["status"] == "paused"
    assert payload["progress"]["phaseStates"]["request_creation"][
        "baseSyncCheckpointToken"
    ] == paused_request_creation["baseCheckpointToken"]
    assert payload["progress"]["requestCreation"] == paused_request_creation


@pytest.mark.django_db
def test_catalog_automation_run_starts_request_creation_from_completed_sync_checkpoint(client):
    login_processing_admin(client)
    BookRecord.objects.create(
        id="matrix-phase-two-a",
        name="Matrix Phase Two A",
        url="https://example.test/books/matrix-phase-two-a",
        category="Reference",
        writer="Writer One",
        publisher="Press",
    )
    sync_state = get_sync_state()
    set_catalog_runtime_state(
        sync_state,
        sync_status="completed",
        request_creation_status="not_started",
        sync_owner="manual",
        next_page_index=1,
        fetched_count=1,
    )

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )

    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "request_creation"
    assert payload["sync"]["message"] == "Creating book requests from the synced catalog records."
    assert payload["sync"]["progress"]["phaseStatuses"]["sync"] == "completed"
    assert payload["sync"]["progress"]["phaseStatuses"]["request_creation"] == "running"
    assert payload["sync"]["progress"]["phaseStates"]["request_creation"][
        "baseSyncCheckpointToken"
    ] == payload["sync"]["progress"]["requestCreation"]["baseCheckpointToken"]


@pytest.mark.django_db
def test_manual_and_automation_can_resume_different_paused_catalog_phases(client):
    login_processing_admin(client)
    sync_state = get_sync_state()
    sync_state.remote_pages = [
        [record_payload("matrix-paused-phase-1", name="Matrix Paused Phase 1")],
        [],
    ]
    sync_state.save(update_fields=["remote_pages", "updated_at"])
    paused_request_creation = {
        "baseCheckpointToken": processing_services.catalog_sync_checkpoint_token(
            "catalog-matrix-session",
            next_page_index=1,
            fetched_count=1,
        ),
        "lastRecordId": "matrix-record-1",
        "processedCount": 1,
        "createdCount": 1,
        "unsupportedCount": 0,
    }
    set_catalog_runtime_state(
        sync_state,
        sync_status="paused",
        request_creation_status="paused",
        sync_owner="manual",
        request_creation=paused_request_creation,
        next_page_index=1,
        fetched_count=1,
    )

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/start/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "sync"
    assert payload["sync"]["runMode"] == "manual"
    assert payload["sync"]["message"] == "Continuing catalog sync from the saved endpoint."
    assert payload["sync"]["progress"]["phaseStatuses"]["sync"] == "running"
    assert payload["sync"]["progress"]["phaseStatuses"]["request_creation"] == "paused"
    assert payload["sync"]["progress"]["requestCreation"] == paused_request_creation

    set_catalog_runtime_state(
        sync_state,
        sync_status="paused",
        request_creation_status="paused",
        sync_owner="manual",
        request_creation=paused_request_creation,
        next_page_index=1,
        fetched_count=1,
    )
    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "request_creation"
    assert payload["sync"]["runMode"] == "catalog_automation"
    assert payload["sync"]["message"] == "Resuming automated request creation from saved progress."
    assert payload["sync"]["progress"]["phaseStatuses"]["sync"] == "paused"
    assert payload["sync"]["progress"]["phaseStatuses"]["request_creation"] == "running"


@pytest.mark.django_db
def test_processing_sync_serialization_normalizes_legacy_catalog_progress_into_phase_states():
    sync_state = get_sync_state()
    sync_state.status = ProcessingSyncStatus.PAUSED
    sync_state.progress = {
        "runMode": "catalog_automation",
        "triggerSource": "button",
        "phase": "request_creation",
        "checkpoint": "request-1",
        "savedAt": timezone.now().isoformat(),
        "savedData": {
            "runMode": "catalog_automation",
            "triggerSource": "button",
            "sessionId": "legacy-catalog-session",
            "checkpointToken": "legacy-catalog-session:0:1:1",
            "nextPageIndex": 1,
            "fetchedCount": 1,
        },
        "requestCreation": {
            "baseCheckpointToken": "legacy-catalog-session:0:1:1",
            "lastRecordId": "legacy-record-1",
            "processedCount": 1,
            "createdCount": 1,
            "unsupportedCount": 0,
        },
    }
    sync_state.page_index = 1
    sync_state.fetched_count = 1
    sync_state.save(
        update_fields=[
            "status",
            "progress",
            "page_index",
            "fetched_count",
            "updated_at",
        ]
    )

    payload = processing_services.serialize_sync_state(sync_state, include_remote_pages=False)

    assert payload["progress"]["phaseStatuses"]["sync"] == "completed"
    assert payload["progress"]["phaseStatuses"]["request_creation"] == "paused"
    assert payload["progress"]["phaseStates"]["sync"]["status"] == "completed"
    assert payload["progress"]["phaseStates"]["request_creation"]["status"] == "paused"
    assert payload["progress"]["phaseStates"]["request_creation"][
        "baseSyncCheckpointToken"
    ] == "legacy-catalog-session:0:1:1"


@pytest.mark.django_db
def test_processing_sync_serialization_normalizes_legacy_catalog_pausing_progress():
    sync_state = get_sync_state()
    saved_at = timezone.now().isoformat()
    sync_state.status = ProcessingSyncStatus.PAUSING
    sync_state.progress = {
        "runMode": "manual",
        "triggerSource": "button",
        "phase": "sync",
        "checkpoint": "page-2",
        "savedData": {
            "runMode": "manual",
            "triggerSource": "button",
            "sessionId": "legacy-catalog-pausing",
            "checkpointToken": "legacy-catalog-pausing:0:2:8",
            "nextPageIndex": 2,
            "fetchedCount": 8,
        },
        "phaseStatuses": {
            "sync": "running",
            "request_creation": "paused",
        },
        "requestCreation": {
            "baseCheckpointToken": "legacy-catalog-pausing:0:1:4",
            "lastRecordId": "legacy-paused-request",
            "processedCount": 4,
            "createdCount": 2,
            "unsupportedCount": 0,
        },
        "savedAt": saved_at,
    }
    sync_state.page_index = 2
    sync_state.fetched_count = 8
    sync_state.save(
        update_fields=[
            "status",
            "progress",
            "page_index",
            "fetched_count",
            "updated_at",
        ]
    )

    payload = processing_services.serialize_sync_state(sync_state, include_remote_pages=False)

    assert payload["status"] == "pausing"
    assert payload["progress"]["phaseStatuses"]["sync"] == "running"
    assert payload["progress"]["phaseStatuses"]["request_creation"] == "paused"
    assert payload["progress"]["phaseStates"]["sync"]["status"] == "pausing"
    assert payload["progress"]["phaseStates"]["sync"]["savedAt"] == saved_at
    assert payload["progress"]["phaseStates"]["request_creation"]["status"] == "paused"
    assert payload["progress"]["phaseStates"]["request_creation"][
        "baseSyncCheckpointToken"
    ] == "legacy-catalog-pausing:0:1:4"


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("progress_phase", "expected_sync_status", "expected_request_creation_status"),
    [
        (
            "sync",
            "running",
            "paused",
        ),
        (
            "request_creation",
            "completed",
            "running",
        ),
    ],
)
def test_processing_sync_serialization_normalizes_dual_active_catalog_phase_states(
    progress_phase,
    expected_sync_status,
    expected_request_creation_status,
):
    sync_state = get_sync_state()
    session_id = "dual-active-session"
    checkpoint_token = processing_services.catalog_sync_checkpoint_token(
        session_id,
        next_page_index=2,
        fetched_count=8,
    )
    request_creation = {
        "baseCheckpointToken": checkpoint_token,
        "lastRecordId": "dual-active-record",
        "processedCount": 3,
        "createdCount": 2,
        "unsupportedCount": 0,
    }
    sync_state.status = ProcessingSyncStatus.SYNCING
    sync_state.progress = {
        "runMode": "catalog_automation",
        "triggerSource": "button",
        "phase": progress_phase,
        "phaseStatuses": {
            "sync": "running",
            "request_creation": "running",
        },
        "phaseStates": {
            "sync": processing_services._catalog_phase_state(
                processing_services.CATALOG_SYNC_PHASE,
                status="running",
                owner="manual",
                trigger_source=processing_services.SYNC_TRIGGER_SOURCE_BUTTON,
                checkpoint="page-2",
                saved_data={
                    "runMode": "manual",
                    "triggerSource": "button",
                    "sessionId": session_id,
                    "checkpointToken": checkpoint_token,
                    "nextPageIndex": 2,
                    "fetchedCount": 8,
                },
            ),
            "request_creation": processing_services._catalog_phase_state(
                processing_services.CATALOG_REQUEST_CREATION_PHASE,
                status="running",
                owner="catalog_automation",
                trigger_source=processing_services.SYNC_TRIGGER_SOURCE_BUTTON,
                checkpoint="request-dual-active-record",
                request_creation=request_creation,
                base_sync_checkpoint_token=checkpoint_token,
            ),
        },
        "savedData": {
            "runMode": "manual",
            "triggerSource": "button",
            "sessionId": session_id,
            "checkpointToken": checkpoint_token,
            "nextPageIndex": 2,
            "fetchedCount": 8,
        },
        "requestCreation": request_creation,
    }
    sync_state.page_index = 2
    sync_state.fetched_count = 8
    sync_state.save(
        update_fields=[
            "status",
            "progress",
            "page_index",
            "fetched_count",
            "updated_at",
        ]
    )

    payload = processing_services.serialize_sync_state(sync_state, include_remote_pages=False)

    assert payload["progress"]["phaseStates"]["sync"]["status"] == expected_sync_status
    assert (
        payload["progress"]["phaseStates"]["request_creation"]["status"]
        == expected_request_creation_status
    )
    assert (
        payload["progress"]["phaseStatuses"]["sync"]
        == ("running" if expected_sync_status == "pausing" else expected_sync_status)
    )
    assert (
        payload["progress"]["phaseStatuses"]["request_creation"]
        == (
            "running"
            if expected_request_creation_status == "pausing"
            else expected_request_creation_status
        )
    )


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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
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

    _mutation, _payload = post_processing_mutation(
        client,
        "/api/processing/automation/incomplete/run/",
    )
    sync_state = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    sync_state.remote_pages = [["resume-incomplete-a"], ["resume-incomplete-b"], []]
    sync_state.save(update_fields=["remote_pages", "updated_at"])

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/pause/",
    )
    assert payload["sync"]["status"] == "pausing"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["runMode"] == "incomplete_automation"
    assert BookRecord.objects.get(pk="resume-incomplete-a").resolved_from_incomplete is True
    assert BookRecord.objects.get(pk="resume-incomplete-b").resolved_from_incomplete is False

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/resume/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "incomplete_automation"
    assert payload["sync"]["message"] == "Restarting incomplete catalog sync from the beginning."

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "idle"
    assert payload["sync"]["message"] == "Incomplete catalog sync complete. Updated 2 books."
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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/incomplete/run/",
    )
    sync_state = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    assert sync_state.remote_pages == expected_pages
    assert payload["sync"]["runMode"] == "incomplete_automation"


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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/incomplete/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "incomplete_automation"
    assert "remotePages" not in payload["sync"]
    assert payload["sync"]["progress"]["savedData"]["liveFetch"] is True

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["fetchedCount"] == 1
    assert BookRecord.objects.filter(pk="live-incomplete-page-1").exists()

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "idle"
    assert payload["sync"]["message"] == "Incomplete catalog sync complete. Updated 1 book."
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

    _mutation, _payload = post_processing_mutation(
        client,
        "/api/processing/automation/incomplete/run/",
    )

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/pause/",
    )
    assert payload["sync"]["status"] == "pausing"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "paused"
    assert payload["sync"]["progress"]["savedData"]["liveFetch"] is True
    assert payload["sync"]["progress"]["savedData"]["nextPageIndex"] == 1

    sync_state = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    assert sync_state.page_index == 1
    assert len(sync_state.remote_pages) == 1

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/resume/",
    )
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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["phase"] == "request_creation"
    assert BookRecord.objects.filter(pk=str(entry.id)).exists()

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    assert payload["sync"]["status"] == "idle"
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
        _mutation, _payload = advance_processing_pipeline(client)
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
def test_processing_sync_serialization_repairs_stale_checkpoint_mirror(monkeypatch):
    fake_redis = FakeProcessingCheckpointRedis()
    monkeypatch.setattr(
        "apps.processing.services.processing_checkpoint_client",
        lambda: fake_redis,
    )

    sync_state = get_sync_state()
    sync_state.status = ProcessingSyncStatus.PAUSED
    sync_state.progress = {
        "runMode": "manual",
        "triggerSource": "button",
        "savedAt": timezone.now().isoformat(),
        "savedData": {
            "runMode": "manual",
            "triggerSource": "button",
            "nextPageIndex": 3,
            "fetchedCount": 42,
        },
    }
    sync_state.page_index = 3
    sync_state.fetched_count = 42
    sync_state.message = "Sync progress saved."
    sync_state.save(
        update_fields=[
            "status",
            "progress",
            "page_index",
            "fetched_count",
            "message",
            "updated_at",
        ]
    )

    checkpoint_key = processing_services.processing_sync_checkpoint_key("catalog")
    fake_redis.store[checkpoint_key] = json.dumps(
        {
            "scope": "catalog",
            "status": "paused",
            "runMode": "manual",
            "triggerSource": "button",
            "pageIndex": 1,
            "fetchedCount": 7,
            "progress": {
                "savedAt": "2000-01-01T00:00:00+00:00",
                "savedData": {"nextPageIndex": 1},
            },
        }
    )

    payload = processing_services.serialize_sync_state(
        sync_state,
        include_remote_pages=False,
    )
    processing_services.sync_checkpoint_progress(sync_state)

    assert payload["pageIndex"] == 3
    mirrored_payload = json.loads(fake_redis.store[checkpoint_key])
    assert mirrored_payload["pageIndex"] == 3
    assert mirrored_payload["fetchedCount"] == 42
    assert mirrored_payload["progress"]["savedData"]["nextPageIndex"] == 3


@pytest.mark.django_db
def test_processing_sync_checkpoint_mirror_clears_when_runtime_returns_to_idle(monkeypatch):
    fake_redis = FakeProcessingCheckpointRedis()
    monkeypatch.setattr(
        "apps.processing.services.processing_checkpoint_client",
        lambda: fake_redis,
    )

    processing_services.run_manual_catalog_sync(
        [[record_payload("mirror-stop-record")], []]
    )

    checkpoint_key = processing_services.processing_sync_checkpoint_key("catalog")
    assert checkpoint_key in fake_redis.store

    processing_services.stop_sync("catalog")

    assert checkpoint_key not in fake_redis.store


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

    mutation, _payload = advance_processing_pipeline(client)

    assert mutation["advancedCount"] == 0
    processing_request.refresh_from_db()
    assert processing_request.state == "queued"

    mutation, _payload = advance_processing_pipeline(client)

    assert mutation["advancedCount"] == 0
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

    mutation, _payload = advance_processing_pipeline(client)

    assert mutation["advancedCount"] == 2
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
def test_processing_create_requests_dispatches_without_worker_probe(client, monkeypatch):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="probe-free-dispatch-record",
        name="Probe Free Dispatch Record",
        url="https://example.test/books/probe-free-dispatch-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
    )
    dispatch_calls = []

    def fake_apply_async(*, args, **kwargs):
        dispatch_calls.append({"args": tuple(args), "kwargs": dict(kwargs)})
        return SimpleNamespace(id="probe-free-task")

    monkeypatch.setattr(
        "apps.processing.services.should_run_processing_jobs_inline",
        lambda: False,
    )
    monkeypatch.setattr(
        "apps.processing.services.processing_workers_available",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
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
    processing_request = BookCreationRequest.objects.get(book_record=record)
    assert processing_request.state == "queued"
    assert processing_request.progress["_dispatchTaskId"] == "probe-free-task"
    assert dispatch_calls == [
        {
            "args": ("request-probe-free-dispatch-record",),
            "kwargs": {"queue": "processing"},
        }
    ]


@pytest.mark.django_db
def test_processing_pipeline_falls_back_to_inline_when_dispatch_fails(
    client, monkeypatch
):
    login_processing_admin(client)
    record = BookRecord.objects.create(
        id="dispatch-failure-record",
        name="Dispatch Failure Record",
        url="https://example.test/books/dispatch-failure-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="queued",
    )
    processing_request = BookCreationRequest.objects.create(
        id="dispatch-failure-request",
        book_record=record,
        state="queued",
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
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setattr(
        "apps.processing.tasks.kickoff_book_creation_request_task.apply_async",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("broker unavailable")),
    )
    monkeypatch.setattr(
        "apps.processing.services._run_processing_request",
        fake_run_processing_request,
    )

    mutation, _payload = advance_processing_pipeline(client)

    assert mutation["advancedCount"] == 1
    processing_request.refresh_from_db()
    record.refresh_from_db()
    assert processing_request.state == "created"
    assert record.book_creation_state == "created"


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

    mutation, _payload = advance_processing_pipeline(client)

    assert mutation["advancedCount"] == 1
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
def test_reset_processing_data_can_revoke_tasks_and_purge_processing_queue(
    monkeypatch,
):
    record = BookRecord.objects.create(
        id="reset-processing-record",
        name="Reset Processing Record",
        url="https://example.test/books/reset-processing-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="queued",
    )
    BookCreationRequest.objects.create(
        id="reset-processing-request",
        book_record=record,
        state="queued",
        progress={
            processing_services.PROCESSING_DISPATCH_TASK_ID_KEY: "request-task-id",
        },
    )
    sync_state = get_sync_state()
    sync_state.status = ProcessingSyncStatus.SYNCING
    sync_state.task_id = "sync-task-id"
    sync_state.queue_name = "processing"
    sync_state.save(update_fields=["status", "task_id", "queue_name", "updated_at"])

    revoked = []
    purged = []

    monkeypatch.setattr(
        processing_services.celery_app.control,
        "revoke",
        lambda task_id, terminate=False: revoked.append((task_id, terminate)),
    )
    monkeypatch.setattr(
        processing_services,
        "purge_processing_task_queue",
        lambda: purged.append(True) or 1,
    )

    processing_services.reset_processing_data(revoke_tasks=True, purge_queue=True)

    record.refresh_from_db()
    sync_state.refresh_from_db()
    assert {task_id for task_id, _terminate in revoked} == {
        "request-task-id",
        "sync-task-id",
    }
    assert purged == [True]
    assert BookCreationRequest.objects.count() == 0
    assert record.book_creation_state == "not_created"
    assert sync_state.status == ProcessingSyncStatus.IDLE
    assert sync_state.task_id == ""
    assert sync_state.queue_name == ""


@pytest.mark.django_db
def test_processing_state_does_not_recover_stale_processing_requests(client):
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
    assert stale_request.state == "processing"
    assert stale_request.error_message == ""
    assert record.book_creation_state == "processing"
    row = next(item for item in payload["requests"] if item["id"] == stale_request.id)
    assert row["state"] == "processing"
    assert row["errorMessage"] == ""

    processing_services.mark_stale_processing_requests()
    stale_request.refresh_from_db()
    record.refresh_from_db()
    assert stale_request.state == "queued"
    assert record.book_creation_state == "queued"


@pytest.mark.django_db
def test_processing_maintenance_recovers_stale_processing_requests_without_browser():
    record = BookRecord.objects.create(
        id="maintenance-stale-record",
        name="Maintenance Stale Record",
        url="https://example.test/books/maintenance-stale-record",
        category="Fiction",
        writer="Writer One",
        publisher="Example Press",
        book_creation_state="processing",
    )
    stale_request = BookCreationRequest.objects.create(
        id="maintenance-stale-request",
        book_record=record,
        state="processing",
    )
    BookCreationRequest.objects.filter(pk=stale_request.pk).update(
        updated_at=timezone.now() - timedelta(minutes=25)
    )

    result = processing_services.run_processing_maintenance()

    stale_request.refresh_from_db()
    record.refresh_from_db()
    assert result["recoveredCount"] == 1
    assert result["repairedCount"] == 0
    assert stale_request.state == "queued"
    assert record.book_creation_state == "queued"


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
        _mutation, _payload = advance_processing_pipeline(client)
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
def test_processing_create_again_reuses_own_linked_book_and_finishes_created(
    client,
    monkeypatch,
):
    login_processing_admin(client)
    existing_book = Book.objects.create(title="Existing Created Book", state="ready")
    record = BookRecord.objects.create(
        id="recreate-created-record",
        name="Recreate Created",
        url="https://www.ebanglalibrary.com/books/recreate-created/",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="deleted",
        linked_book=existing_book,
    )
    processing_request = BookCreationRequest.objects.create(
        id="recreate-created-request",
        book_record=record,
        state="deleted",
        linked_book=existing_book,
    )

    monkeypatch.setattr(
        "apps.processing.services.capture_source_page_metadata",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "apps.processing.services.find_existing_book_by_source_url",
        lambda *_args, **_kwargs: existing_book,
    )
    monkeypatch.setattr(
        "apps.processing.services.find_exact_existing_book",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "apps.processing.services.detect_metadata_duplicate",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "apps.processing.services.scrape_book",
        lambda *_args, **_kwargs: {
            "book_info": "",
            "main_content": "<p>body</p>",
        },
        raising=False,
    )
    monkeypatch.setattr(
        "apps.processing.services._persist_processing_book",
        lambda *_args, **_kwargs: existing_book,
    )

    response = client.post(
        "/api/processing/requests/action/",
        {"ids": [processing_request.id], "action": "create_again"},
        content_type="application/json",
    )
    assert response.status_code == 200

    for _ in range(10):
        _mutation, _payload = advance_processing_pipeline(client)
        processing_request.refresh_from_db()
        if processing_request.state == BookCreationRequest.State.CREATED:
            break
        time_module.sleep(0.1)

    processing_request.refresh_from_db()
    record.refresh_from_db()
    assert processing_request.state == "created"
    assert processing_request.linked_book_id == existing_book.id
    assert processing_request.duplicate_of_request_id is None
    assert processing_request.duplicate_of_record_id is None
    assert record.book_creation_state == "created"
    assert record.linked_book_id == existing_book.id
    assert record.is_duplicate is False
    assert record.duplicate_of_record_id is None


@pytest.mark.django_db
def test_processing_tables_repair_self_linked_duplicates_to_created(client):
    login_processing_admin(client)
    existing_book = Book.objects.create(title="Existing Ready Book", state="ready")
    record = BookRecord.objects.create(
        id="self-linked-duplicate-record",
        name="Self Linked Duplicate",
        url="https://example.test/books/self-linked-duplicate",
        category="Fiction",
        writer="Writer",
        publisher="Press",
        book_creation_state="duplicate",
        linked_book=existing_book,
        is_duplicate=True,
    )
    processing_request = BookCreationRequest.objects.create(
        id="self-linked-duplicate-request",
        book_record=record,
        state="duplicate",
        linked_book=existing_book,
    )
    processing_services.repair_self_linked_duplicate_requests()

    duplicate_response = client.get("/api/processing/table/?card=on-hold-duplicate")
    assert duplicate_response.status_code == 200
    assert duplicate_response.json()["pagination"]["totalCount"] == 0

    processing_request.refresh_from_db()
    record.refresh_from_db()
    assert processing_request.state == "created"
    assert processing_request.duplicate_of_request_id is None
    assert processing_request.duplicate_of_record_id is None
    assert record.book_creation_state == "created"
    assert record.is_duplicate is False
    assert record.duplicate_of_record_id is None

    created_response = client.get("/api/processing/table/?card=create-created")
    assert created_response.status_code == 200
    created_ids = {
        row["requestId"] or row["id"] for row in created_response.json()["rows"]
    }
    assert processing_request.id in created_ids


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

    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/requests/action/",
        {"ids": [duplicate.id], "action": "confirm_duplicate"},
        include_lists=True,
    )
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

    _mutation, _payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/",
        {"enabled": True, "interval": "weekly", "time": "04:30"},
    )
    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/catalog/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "catalog_automation"

    response = advance_processing_sync(client, count=2)
    assert BookCreationRequest.objects.filter(book_record_id="auto-new", state="initial").exists()
    assert not BookCreationRequest.objects.filter(book_record_id="auto-created", state="initial").exists()

    _mutation, _payload = post_processing_mutation(
        client,
        "/api/processing/automation/incomplete/",
        {"enabled": True, "interval": "daily", "time": "03:00"},
    )
    _mutation, payload = post_processing_mutation(
        client,
        "/api/processing/automation/incomplete/run/",
    )
    assert payload["sync"]["status"] == "syncing"
    assert payload["sync"]["runMode"] == "incomplete_automation"

    _mutation, _payload = post_processing_mutation(
        client,
        "/api/processing/sync/advance/",
    )
    incomplete.refresh_from_db()
    assert incomplete.category == "Novel"
    assert incomplete.resolved_from_incomplete is True
    assert BookCreationRequest.objects.filter(
        book_record=incomplete,
        state="created",
    ).exists()
