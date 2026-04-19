import logging
import os
import sys
import uuid
from datetime import timedelta, time as time_type
from types import SimpleNamespace
from urllib.parse import unquote, urlparse
from uuid import uuid4

from bs4 import BeautifulSoup
from django.conf import settings
from django.db import transaction
from django.db.models import CharField, F, OuterRef, Prefetch, Q, Subquery
from django.db.models.functions import Coalesce
from django.utils import timezone

from apps.catalog.services import find_existing_book_by_source_url
from apps.ingestion.models import SourceCatalogEntry, SubmissionOrigin
from apps.ingestion.pipeline.scraper_support.network import create_session_with_retries
from apps.ingestion.services.normalization import promote_leading_front_matter
from apps.ingestion.services.resolution import CATALOG_URL, TitleResolver, get_with_host_fallback
from apps.ingestion.services.resolution_support import (
    fetch_source_page_metadata,
    upsert_source_catalog_entry,
)
from apps.ingestion.services.submissions_support.persistence import export_payload_from_book

from .models import (
    BookCreationRequest,
    BookCreationRequestState,
    BookCreationState,
    BookRecord,
    ProcessingAutomationKind,
    ProcessingAutomationSettings,
    ProcessingSyncState,
    ProcessingSyncStatus,
)
from .source import (
    capture_source_page_metadata,
    detect_metadata_duplicate,
    find_exact_existing_book,
    generate_exports,
    normalize_source_url,
    persist_scraped_book,
    scrape_book,
    sync_assets,
)


logger = logging.getLogger(__name__)

SYNC_RUN_MODE_MANUAL = "manual"
SYNC_RUN_MODE_CATALOG_AUTOMATION = "catalog_automation"
SYNC_RUN_MODE_INCOMPLETE_AUTOMATION = "incomplete_automation"
INCOMPLETE_CATEGORY_KEYWORDS = (
    "incomplete",
    "unfinished",
    "অসম্পূর্ণ",
    "অসম্পূর্ণ বই",
)
TERMINAL_STATES = {
    BookCreationRequestState.CREATED,
    BookCreationRequestState.FAILED,
    BookCreationRequestState.DUPLICATE,
    BookCreationRequestState.DELETED,
}
ACTIVE_STATES = {
    BookCreationRequestState.INITIAL,
    BookCreationRequestState.QUEUED,
    BookCreationRequestState.PROCESSING,
}
SYNC_ACTIVE_STATUSES = {
    ProcessingSyncStatus.SYNCING,
    ProcessingSyncStatus.PAUSING,
}
PROCESSING_STALE_AFTER = timedelta(minutes=20)
PROCESSING_STALE_MESSAGE = "Processing exceeded 20 minutes without completing."
MAX_PROCESSING_REQUEST_ATTEMPTS = 3
DEFAULT_AUTOMATION_INTERVAL = "weekly"
DEFAULT_AUTOMATION_TIME = time_type(3, 0)
LEGACY_AUTOMATION_STATUS_MESSAGE = "Not configured."
PROCESSING_TASK_QUEUE = "processing"
PROCESSING_DISPATCH_REQUESTED_AT_KEY = "_dispatchRequestedAt"
PROCESSING_DISPATCH_TASK_ID_KEY = "_dispatchTaskId"
PROCESSING_TABLE_DEFAULT_LIMIT = 60
PROCESSING_TABLE_MAX_LIMIT = 600

PROCESSING_REQUEST_CARD_STATES = {
    "create-requests": {BookCreationRequestState.INITIAL},
    "create-queue": {BookCreationRequestState.QUEUED},
    "create-processing": {BookCreationRequestState.PROCESSING},
    "create-created": {BookCreationRequestState.CREATED},
    "on-hold-paused": {BookCreationRequestState.PAUSED},
    "on-hold-failed": {BookCreationRequestState.FAILED},
    "on-hold-duplicate": {BookCreationRequestState.DUPLICATE},
    "on-hold-deleted": {BookCreationRequestState.DELETED},
}


def normalize_category_key(value):
    return str(value or "").strip().casefold()


def category_is_incomplete(value):
    normalized = normalize_category_key(value)
    return any(keyword in normalized for keyword in INCOMPLETE_CATEGORY_KEYWORDS)


def incomplete_category_query(field_name="category"):
    query = Q()
    for keyword in INCOMPLETE_CATEGORY_KEYWORDS:
        query |= Q(**{f"{field_name}__icontains": keyword})
    return query


def sync_run_mode(state):
    progress = state.progress if isinstance(state.progress, dict) else {}
    saved_data = progress.get("savedData") if isinstance(progress.get("savedData"), dict) else {}
    return progress.get("runMode") or saved_data.get("runMode") or SYNC_RUN_MODE_MANUAL


def should_run_processing_jobs_inline():
    return bool(
        settings.CELERY_TASK_ALWAYS_EAGER
        or getattr(settings, "PROCESSING_INLINE_PIPELINE_ADVANCE", False)
        or os.environ.get("PYTEST_CURRENT_TEST")
    )


def should_enqueue_processing_work():
    return not should_run_processing_jobs_inline()


def should_skip_processing_metadata_duplicate_check():
    return bool(
        getattr(settings, "PROCESSING_SKIP_METADATA_DUPLICATE_CHECK", True)
    )


def sync_uses_live_fetch(state):
    progress = state.progress if isinstance(state.progress, dict) else {}
    saved_data = progress.get("savedData") if isinstance(progress.get("savedData"), dict) else {}
    return bool(saved_data.get("liveFetch"))


def sync_run_label(run_mode):
    if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
        return "Automated catalog sync"
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        return "Incomplete catalog sync"
    return "Catalog sync"


def sync_start_message(run_mode):
    if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
        return "Automated catalog sync is running."
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        return "Incomplete catalog sync is running."
    return "Syncing catalog records."


def sync_progress_message(run_mode, processed_count):
    label = "record" if processed_count == 1 else "records"
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        return f"Processed {processed_count} incomplete {label} so far."
    return f"Fetched {processed_count} {label} so far."


def sync_pause_message(run_mode):
    if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
        return "Pausing automated catalog sync after the current page finishes."
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        return "Pausing incomplete catalog sync after the current batch finishes."
    return "Pausing after the current page finishes."


def build_sync_progress(run_mode, *, next_page_index=0, fetched_count=0, saved_at=None, live_fetch=False):
    payload = {
        "runMode": run_mode,
        "checkpoint": f"page-{next_page_index}",
        "savedData": {
            "runMode": run_mode,
            "fetchedCount": fetched_count,
            "nextPageIndex": next_page_index,
        },
    }
    if live_fetch:
        payload["savedData"]["liveFetch"] = True
    if saved_at:
        payload["savedAt"] = saved_at
    return payload


def update_automation_run_status(run_mode, message, *, last_run_at=None):
    if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
        automation_settings = get_automation_settings(ProcessingAutomationKind.CATALOG)
    elif run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        automation_settings = get_automation_settings(ProcessingAutomationKind.INCOMPLETE)
    else:
        return None

    update_fields = ["status_message", "updated_at"]
    automation_settings.status_message = message
    if last_run_at is not None:
        automation_settings.last_run_at = last_run_at
        update_fields.append("last_run_at")
    automation_settings.save(update_fields=update_fields)
    return automation_settings


def get_sync_state():
    state, _ = ProcessingSyncState.objects.get_or_create(
        singleton_key="default",
        defaults={"message": "Ready to sync."},
    )
    return state


def normalize_automation_settings(automation_settings):
    update_fields = []

    if not automation_settings.saved:
        if automation_settings.interval != DEFAULT_AUTOMATION_INTERVAL:
            automation_settings.interval = DEFAULT_AUTOMATION_INTERVAL
            update_fields.append("interval")
        if automation_settings.time != DEFAULT_AUTOMATION_TIME:
            automation_settings.time = DEFAULT_AUTOMATION_TIME
            update_fields.append("time")

    if automation_settings.status_message == LEGACY_AUTOMATION_STATUS_MESSAGE:
        automation_settings.status_message = ""
        update_fields.append("status_message")

    if update_fields:
        automation_settings.save(update_fields=[*update_fields, "updated_at"])

    return automation_settings


def get_automation_settings(kind):
    automation_settings, _ = ProcessingAutomationSettings.objects.get_or_create(
        kind=kind,
        defaults={
            "enabled": False,
            "interval": DEFAULT_AUTOMATION_INTERVAL,
            "time": DEFAULT_AUTOMATION_TIME,
            "status_message": "",
        },
    )
    return normalize_automation_settings(automation_settings)


def processing_request_prefetch():
    return Prefetch(
        "creation_requests",
        queryset=BookCreationRequest.objects.select_related("duplicate_of_request").order_by(
            "-updated_at",
            "-created_at",
            "id",
        ),
    )


def record_request_list(record):
    cached = getattr(record, "_prefetched_objects_cache", {}).get("creation_requests")
    if cached is not None:
        return list(cached)
    return list(record.creation_requests.order_by("-updated_at", "-created_at", "id"))


def latest_request_for_record(record):
    requests = record_request_list(record)
    return requests[0] if requests else None


def linked_book_for_remote_url(url):
    try:
        normalized_url = normalize_source_url(url)
    except ValueError:
        return None
    return find_existing_book_by_source_url(normalized_url)


def sync_record_state(record):
    latest_request = latest_request_for_record(record)
    if latest_request:
        next_state = latest_request.state
    elif record.linked_book_id:
        next_state = BookCreationState.CREATED
    elif record.book_creation_state not in BookCreationState.values:
        next_state = BookCreationState.NOT_CREATED
    else:
        next_state = record.book_creation_state

    if record.book_creation_state != next_state:
        record.book_creation_state = next_state
        record.save(update_fields=["book_creation_state", "updated_at"])
    return record


def sync_records_for_requests(requests):
    record_ids = {request.book_record_id for request in requests}
    for record in BookRecord.objects.filter(pk__in=record_ids):
        sync_record_state(record)


def normalize_remote_record(payload):
    timestamp = payload.get("updatedAt") or payload.get("updated_at") or timezone.now().isoformat()
    category = str(payload.get("category") or "Uncategorized")
    was_incomplete = payload.get("wasIncomplete")
    if was_incomplete is None:
        was_incomplete = payload.get("was_incomplete")
    if was_incomplete is None:
        was_incomplete = category_is_incomplete(category)
    return {
        "id": str(payload.get("id") or payload.get("url") or ""),
        "name": str(payload.get("name") or payload.get("title") or "Untitled book"),
        "url": str(payload.get("url") or ""),
        "category": category,
        "writer": str(payload.get("writer") or payload.get("author") or ""),
        "translator": str(payload.get("translator") or ""),
        "composer": str(payload.get("composer") or ""),
        "publisher": str(payload.get("publisher") or ""),
        "updatedAt": timestamp,
        "bookCreationState": str(
            payload.get("bookCreationState")
            or payload.get("book_creation_state")
            or BookCreationState.NOT_CREATED
        ),
        "wasIncomplete": bool(was_incomplete),
        "resolvedFromIncomplete": bool(
            payload.get("resolvedFromIncomplete") or payload.get("resolved_from_incomplete")
        ),
        "willResolveToCategory": str(
            payload.get("willResolveToCategory")
            or payload.get("will_resolve_to_category")
            or ""
        ),
    }


def is_catalog_remote_page(page):
    return isinstance(page, list) and all(isinstance(item, dict) for item in page)


def catalog_remote_pages(remote_pages):
    if isinstance(remote_pages, list) and all(is_catalog_remote_page(page) for page in remote_pages):
        return remote_pages
    return []


def source_catalog_entry_payload(entry):
    raw_data = entry.raw_data or {}
    category = (
        raw_data.get("category")
        or raw_data.get("resolvedCategory")
        or raw_data.get("resolved_category")
        or "Uncategorized"
    )
    parsed = urlparse((entry.source_url or "").strip())
    return {
        "id": str(entry.id),
        "name": entry.title,
        "url": entry.source_url,
        "displayUrl": unquote(entry.source_url or ""),
        "displayPath": unquote(parsed.path).strip("/") or parsed.netloc,
        "category": category,
        "writer": entry.author_line,
        "translator": raw_data.get("translator") or "",
        "composer": raw_data.get("composer") or "",
        "publisher": raw_data.get("publisher") or "",
        "updatedAt": entry.updated_at.isoformat(),
        "wasIncomplete": category_is_incomplete(category),
        "willResolveToCategory": raw_data.get("willResolveToCategory")
        or raw_data.get("will_resolve_to_category")
        or raw_data.get("resolvedCategory")
        or raw_data.get("resolved_category")
        or "",
    }


def is_valid_uuid_string(value):
    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return False
    return True


def upsert_remote_records(records):
    skipped_count = 0
    updated_count = 0
    appended_count = 0

    for raw_record in records:
        data = normalize_remote_record(raw_record)
        if not data["url"]:
            continue

        source_entry_filters = Q(source_url=data["url"])
        if is_valid_uuid_string(data["id"]):
            source_entry_filters |= Q(pk=data["id"])
        source_entry = SourceCatalogEntry.objects.filter(source_entry_filters).order_by("-updated_at").first()
        linked_book = linked_book_for_remote_url(data["url"])
        desired_state = (
            data["bookCreationState"]
            if data["bookCreationState"] in BookCreationState.values
            else BookCreationState.CREATED if linked_book else BookCreationState.NOT_CREATED
        )
        defaults = {
            "name": data["name"],
            "url": data["url"],
            "category": data["category"],
            "writer": data["writer"],
            "translator": data["translator"],
            "composer": data["composer"],
            "publisher": data["publisher"],
            "book_creation_state": desired_state,
            "linked_book": linked_book,
            "source_catalog_entry": source_entry,
            "was_incomplete": data["wasIncomplete"],
            "resolved_from_incomplete": data["resolvedFromIncomplete"],
            "will_resolve_to_category": data["willResolveToCategory"],
        }

        record = (
            BookRecord.objects.select_related("linked_book")
            .filter(Q(pk=data["id"]) | Q(url=data["url"]))
            .order_by("id")
            .first()
        )
        if record is None:
            preferred_id = data["id"] or None
            create_kwargs = dict(defaults)
            if preferred_id and not BookRecord.objects.filter(pk=preferred_id).exists():
                create_kwargs["id"] = preferred_id
            BookRecord.objects.create(**create_kwargs)
            appended_count += 1
            continue

        changed_fields = [
            field_name
            for field_name, value in defaults.items()
            if getattr(record, field_name) != value
        ]
        if changed_fields:
            for field_name in changed_fields:
                setattr(record, field_name, defaults[field_name])
            record.save(update_fields=[*changed_fields, "updated_at"])
            updated_count += 1
        else:
            skipped_count += 1

        sync_record_state(record)

    return {
        "skipped_count": skipped_count,
        "updated_count": updated_count,
        "appended_count": appended_count,
    }


def source_catalog_remote_pages(page_size=100):
    entries = SourceCatalogEntry.objects.order_by("title", "id")
    pages = []
    current_page = []
    for entry in entries.iterator(chunk_size=page_size):
        current_page.append(source_catalog_entry_payload(entry))
        if len(current_page) >= page_size:
            pages.append(current_page)
            current_page = []
    if current_page:
        pages.append(current_page)
    pages.append([])
    return pages


def reconcile_remote_pages(remote_pages):
    remote_pages = remote_pages if isinstance(remote_pages, list) else []
    fetched_count = 0
    skipped_count = 0
    updated_count = 0
    appended_count = 0
    page_index = 0
    completed = False

    for page in remote_pages:
        if not page:
            completed = True
            break

        result = upsert_remote_records(page)
        fetched_count += len(page)
        skipped_count += result["skipped_count"]
        updated_count += result["updated_count"]
        appended_count += result["appended_count"]
        page_index += 1

    if remote_pages and not completed:
        page_index = len(remote_pages)

    return {
        "fetched_count": fetched_count,
        "skipped_count": skipped_count,
        "updated_count": updated_count,
        "appended_count": appended_count,
        "page_index": page_index,
        "completed": completed or not remote_pages,
    }


def should_dispatch_live_sync(remote_pages, run_mode):
    return (
        bool(getattr(settings, "PROCESSING_USE_LIVE_SYNC", False))
        and not settings.CELERY_TASK_ALWAYS_EAGER
        and "pytest" not in sys.modules
        and not os.environ.get("PYTEST_CURRENT_TEST")
        and not remote_pages
        and run_mode in {SYNC_RUN_MODE_MANUAL, SYNC_RUN_MODE_CATALOG_AUTOMATION}
    )


def dispatch_sync_task(sync_state, *, force=False):
    from .tasks import run_processing_sync_task

    sync_state.refresh_from_db(fields=["status", "task_id", "queue_name", "updated_at"])
    if sync_state.status not in SYNC_ACTIVE_STATUSES:
        return sync_state
    if not force and sync_state.task_id:
        return sync_state

    assigned_task_id = str(uuid4())
    sync_state.task_id = assigned_task_id
    sync_state.queue_name = PROCESSING_TASK_QUEUE
    sync_state.last_error = ""
    sync_state.save(update_fields=["task_id", "queue_name", "last_error", "updated_at"])

    try:
        async_result = run_processing_sync_task.apply_async(
            args=[sync_state.singleton_key],
            task_id=assigned_task_id,
            queue=PROCESSING_TASK_QUEUE,
        )
        dispatched_task_id = getattr(async_result, "id", assigned_task_id) or assigned_task_id
        if dispatched_task_id != assigned_task_id:
            sync_state.task_id = dispatched_task_id
            sync_state.save(update_fields=["task_id", "updated_at"])
    except Exception as exc:
        logger.warning("Processing sync task dispatch failed.", exc_info=True)
        sync_state.task_id = ""
        sync_state.queue_name = "inline-fallback"
        sync_state.last_error = str(exc)
        sync_state.save(update_fields=["task_id", "queue_name", "last_error", "updated_at"])
        run_processing_sync(singleton_key=sync_state.singleton_key, task_id="")
    return sync_state


def fetch_live_catalog_page(resolver, page_number):
    response = get_with_host_fallback(
        resolver.session,
        CATALOG_URL,
        params=resolver.archive_query_params(page_number=page_number),
        timeout=30,
    )
    response.raise_for_status()
    page_entries = resolver.parse_catalog_page(BeautifulSoup(response.text, "html.parser"))

    normalized_entries = []
    for entry in page_entries:
        enriched_entry = dict(entry)
        try:
            metadata = fetch_source_page_metadata(entry["source_url"], session=resolver.session)
            enriched_entry = {
                **metadata,
                "raw_data": {
                    **(entry.get("raw_data") or {}),
                    **(metadata.get("raw_data") or {}),
                },
            }
        except Exception:
            logger.warning(
                "Catalog metadata enrichment failed for %s; falling back to archive metadata.",
                entry.get("source_url", ""),
                exc_info=True,
            )
        stored_entry = upsert_source_catalog_entry(enriched_entry)
        normalized_entries.append(source_catalog_entry_payload(stored_entry))
    return normalized_entries


def start_sync(remote_pages=None, *, run_mode=SYNC_RUN_MODE_MANUAL):
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        if remote_pages is None:
            remote_pages = incomplete_automation_pages()
        elif not isinstance(remote_pages, list):
            remote_pages = incomplete_automation_pages()
    else:
        remote_pages = catalog_remote_pages(remote_pages)
        if not remote_pages and SourceCatalogEntry.objects.exists():
            remote_pages = source_catalog_remote_pages()

    live_fetch = should_dispatch_live_sync(remote_pages, run_mode)
    state = get_sync_state()
    state.remote_pages = remote_pages
    state.status = ProcessingSyncStatus.SYNCING
    state.progress = build_sync_progress(run_mode, live_fetch=live_fetch)
    state.page_index = 0
    state.fetched_count = 0
    state.skipped_count = 0
    state.updated_count = 0
    state.appended_count = 0
    state.message = sync_start_message(run_mode)
    state.task_id = ""
    state.queue_name = ""
    state.last_error = ""
    state.save()
    update_automation_run_status(run_mode, state.message)
    if live_fetch:
        dispatch_sync_task(state, force=True)
    return state


def pause_sync():
    state = get_sync_state()
    if state.status == ProcessingSyncStatus.SYNCING:
        run_mode = sync_run_mode(state)
        state.status = ProcessingSyncStatus.PAUSING
        state.progress = build_sync_progress(
            run_mode,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            live_fetch=sync_uses_live_fetch(state),
        )
        state.message = sync_pause_message(run_mode)
        state.save(update_fields=["status", "progress", "message", "updated_at"])
        update_automation_run_status(run_mode, state.message)
    return state


def resume_sync():
    state = get_sync_state()
    run_mode = sync_run_mode(state)
    live_fetch = sync_uses_live_fetch(state)
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        state.remote_pages = incomplete_automation_pages()
    state.status = ProcessingSyncStatus.SYNCING
    state.progress = build_sync_progress(
        run_mode,
        next_page_index=0,
        fetched_count=state.fetched_count,
        live_fetch=live_fetch,
    )
    state.page_index = 0
    state.task_id = ""
    state.queue_name = ""
    if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
        state.message = "Restarting automated catalog sync from the beginning."
    elif run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        state.message = "Restarting incomplete catalog sync from the beginning."
    else:
        state.message = "Reconciling saved records from the beginning."
    state.save(
        update_fields=[
            "remote_pages",
            "status",
            "progress",
            "page_index",
            "task_id",
            "queue_name",
            "message",
            "updated_at",
        ]
    )
    update_automation_run_status(run_mode, state.message)
    if live_fetch and not settings.CELERY_TASK_ALWAYS_EAGER:
        dispatch_sync_task(state, force=True)
    return state


def stop_sync():
    state = get_sync_state()
    if state.status not in {
        ProcessingSyncStatus.SYNCING,
        ProcessingSyncStatus.PAUSING,
        ProcessingSyncStatus.PAUSED,
    }:
        return state

    run_mode = sync_run_mode(state)
    state.status = ProcessingSyncStatus.IDLE
    state.progress = None
    state.task_id = ""
    state.queue_name = ""
    state.message = f"{sync_run_label(run_mode)} stopped."
    state.save(
        update_fields=[
            "status",
            "progress",
            "task_id",
            "queue_name",
            "message",
            "updated_at",
        ]
    )
    update_automation_run_status(run_mode, state.message)
    return state


def finalize_sync(state, *, message=None):
    state.status = ProcessingSyncStatus.IDLE
    state.progress = None
    state.task_id = ""
    state.queue_name = ""
    state.message = message or (
        f"Sync complete. Updated {state.updated_count}, "
        f"Skipped {state.skipped_count}, Added {state.appended_count}."
    )
    state.save(
        update_fields=[
            "status",
            "progress",
            "task_id",
            "queue_name",
            "message",
            "page_index",
            "fetched_count",
            "skipped_count",
            "updated_count",
            "appended_count",
            "updated_at",
        ]
    )
    return state


def fail_sync(state, error):
    run_mode = sync_run_mode(state)
    state.status = ProcessingSyncStatus.IDLE
    state.progress = None
    state.task_id = ""
    state.queue_name = ""
    state.last_error = str(error)
    state.message = f"{sync_run_label(run_mode)} failed: {error}"
    state.save(
        update_fields=[
            "status",
            "progress",
            "task_id",
            "queue_name",
            "last_error",
            "message",
            "updated_at",
        ]
    )
    update_automation_run_status(run_mode, state.message)
    return state


def complete_catalog_automation(state):
    created = []
    for record in BookRecord.objects.order_by("name"):
        latest_request = latest_request_for_record(record)
        latest_state = latest_request.state if latest_request else record.book_creation_state
        eligible = (
            latest_request is None and record.book_creation_state == BookCreationState.NOT_CREATED
        ) or latest_state in {
            BookCreationRequestState.FAILED,
            BookCreationRequestState.DELETED,
        }
        if eligible:
            created.append(create_request_for_record(record, origin=SubmissionOrigin.AUTOMATION))

    finished_at = timezone.now()
    update_automation_run_status(
        SYNC_RUN_MODE_CATALOG_AUTOMATION,
        f"Created {len(created)} {'request' if len(created) == 1 else 'requests'}.",
        last_run_at=finished_at,
    )
    return finalize_sync(
        state,
        message=(
            f"Automated catalog sync complete. Updated {state.updated_count}, "
            f"Skipped {state.skipped_count}, Added {state.appended_count}."
        ),
    )


def incomplete_automation_pages(page_size=100):
    record_ids = [
        str(record.id)
        for record in BookRecord.objects.filter(resolved_from_incomplete=False)
        .exclude(will_resolve_to_category="")
        .order_by("name", "id")
        .only("id", "category", "was_incomplete")
        if record.was_incomplete or category_is_incomplete(record.category)
    ]

    pages = []
    for index in range(0, len(record_ids), page_size):
        pages.append(record_ids[index : index + page_size])
    pages.append([])
    return pages


def resolve_incomplete_records(record_ids):
    resolved = []
    for record in BookRecord.objects.filter(pk__in=record_ids).exclude(will_resolve_to_category=""):
        if not (record.was_incomplete or category_is_incomplete(record.category)):
            continue
        record.category = record.will_resolve_to_category
        record.was_incomplete = True
        record.resolved_from_incomplete = True
        record.book_creation_state = BookCreationRequestState.CREATED
        record.save()
        latest_request = latest_request_for_record(record)
        if latest_request:
            latest_request.state = BookCreationRequestState.CREATED
            latest_request.error_message = ""
            latest_request.progress = None
            latest_request.save()
        else:
            BookCreationRequest.objects.create(
                id=next_request_id(request_id_for_record(record)),
                book_record=record,
                state=BookCreationRequestState.CREATED,
                origin=SubmissionOrigin.AUTOMATION,
            )
        resolved.append(record)
    return resolved


def complete_incomplete_automation(state):
    finished_at = timezone.now()
    update_automation_run_status(
        SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
        f"Resolved {state.updated_count} {'book' if state.updated_count == 1 else 'books'}.",
        last_run_at=finished_at,
    )
    return finalize_sync(
        state,
        message=(
            f"Incomplete catalog sync complete. Resolved {state.updated_count} "
            f"{'book' if state.updated_count == 1 else 'books'}."
        ),
    )


def advance_catalog_sync_once(state, run_mode):
    page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    if not page:
        if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
            return complete_catalog_automation(state)
        return finalize_sync(state)

    result = upsert_remote_records(page)
    state.fetched_count += len(page)
    state.skipped_count += result["skipped_count"]
    state.updated_count += result["updated_count"]
    state.appended_count += result["appended_count"]
    state.page_index += 1
    next_page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    if state.status == ProcessingSyncStatus.PAUSING:
        state.status = ProcessingSyncStatus.PAUSED
        state.progress = build_sync_progress(
            run_mode,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            saved_at=timezone.now().isoformat(),
            live_fetch=sync_uses_live_fetch(state),
        )
        state.message = (
            f"Saved {state.fetched_count} "
            f"{'record' if state.fetched_count == 1 else 'records'} before pausing."
        )
        update_automation_run_status(run_mode, state.message)
    elif not next_page:
        if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
            return complete_catalog_automation(state)
        return finalize_sync(state)
    else:
        state.progress = build_sync_progress(
            run_mode,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            live_fetch=sync_uses_live_fetch(state),
        )
        state.message = sync_progress_message(run_mode, state.fetched_count)
    state.save()
    return state


def advance_incomplete_sync_once(state):
    page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    if not page:
        return complete_incomplete_automation(state)

    resolved = resolve_incomplete_records(page)
    state.fetched_count += len(page)
    state.updated_count += len(resolved)
    state.page_index += 1
    next_page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    if state.status == ProcessingSyncStatus.PAUSING:
        state.status = ProcessingSyncStatus.PAUSED
        state.progress = build_sync_progress(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            saved_at=timezone.now().isoformat(),
        )
        state.message = (
            f"Saved progress for {state.fetched_count} "
            f"{'record' if state.fetched_count == 1 else 'records'} before pausing."
        )
        update_automation_run_status(SYNC_RUN_MODE_INCOMPLETE_AUTOMATION, state.message)
    elif not next_page:
        return complete_incomplete_automation(state)
    else:
        state.progress = build_sync_progress(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
        )
        state.message = sync_progress_message(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            state.fetched_count,
        )
    state.save()
    return state


def run_processing_sync(singleton_key="default", task_id=""):
    state = ProcessingSyncState.objects.get(singleton_key=singleton_key)
    if task_id and state.task_id and state.task_id != task_id:
        return state
    if state.status not in SYNC_ACTIVE_STATUSES:
        return state

    run_mode = sync_run_mode(state)
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        return advance_incomplete_sync_once(state)
    if not sync_uses_live_fetch(state):
        return advance_catalog_sync_once(state, run_mode)

    resolver = TitleResolver(session=create_session_with_retries())
    seen_urls = set()
    page_signatures = set()

    try:
        while True:
            state.refresh_from_db()
            if task_id and state.task_id and state.task_id != task_id:
                return state
            if state.status not in SYNC_ACTIVE_STATUSES:
                return state

            page_number = state.page_index + 1
            page = fetch_live_catalog_page(resolver, page_number)
            unique_page = []
            for item in page:
                source_url = item.get("url")
                if not source_url or source_url in seen_urls:
                    continue
                seen_urls.add(source_url)
                unique_page.append(item)

            signature = tuple(item["url"] for item in unique_page[:5])
            if not unique_page or signature in page_signatures:
                if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
                    return complete_catalog_automation(state)
                return finalize_sync(state)

            page_signatures.add(signature)
            result = upsert_remote_records(unique_page)
            state.fetched_count += len(unique_page)
            state.skipped_count += result["skipped_count"]
            state.updated_count += result["updated_count"]
            state.appended_count += result["appended_count"]
            state.page_index += 1

            if state.status == ProcessingSyncStatus.PAUSING:
                state.status = ProcessingSyncStatus.PAUSED
                state.progress = build_sync_progress(
                    run_mode,
                    next_page_index=state.page_index,
                    fetched_count=state.fetched_count,
                    saved_at=timezone.now().isoformat(),
                    live_fetch=True,
                )
                state.message = (
                    f"Saved {state.fetched_count} "
                    f"{'record' if state.fetched_count == 1 else 'records'} before pausing."
                )
                state.save()
                update_automation_run_status(run_mode, state.message)
                return state

            state.progress = build_sync_progress(
                run_mode,
                next_page_index=state.page_index,
                fetched_count=state.fetched_count,
                live_fetch=True,
            )
            state.message = sync_progress_message(run_mode, state.fetched_count)
            state.save()
    except Exception as exc:
        logger.exception("Live processing sync failed.", extra={"task_id": task_id})
        return fail_sync(state, exc)


def advance_sync_once():
    state = get_sync_state()
    if state.status not in SYNC_ACTIVE_STATUSES:
        return state
    if state.task_id and not settings.CELERY_TASK_ALWAYS_EAGER:
        return state
    return run_processing_sync(singleton_key=state.singleton_key, task_id=state.task_id)


def request_id_for_record(record):
    return f"request-{record.id}"


def next_request_id(preferred_id):
    if not BookCreationRequest.objects.filter(pk=preferred_id).exists():
        return preferred_id
    index = 2
    while BookCreationRequest.objects.filter(pk=f"{preferred_id}-{index}").exists():
        index += 1
    return f"{preferred_id}-{index}"


def request_blocks_record_selection(request):
    return request and request.state not in {
        BookCreationRequestState.FAILED,
        BookCreationRequestState.DELETED,
    }


def record_is_selectable(record):
    requests = record_request_list(record)
    duplicate_request = next(
        (
            request
            for request in requests
            if request.state == BookCreationRequestState.DUPLICATE and request.duplicate_confirmed
        ),
        None,
    )
    if duplicate_request:
        original = duplicate_request.duplicate_of_request
        return original is None or original.state in {
            BookCreationRequestState.FAILED,
            BookCreationRequestState.DELETED,
        }
    if record.linked_book_id and not requests:
        return False
    return not any(request_blocks_record_selection(request) for request in requests)


def enqueue_request_processing(processing_request):
    from .tasks import kickoff_book_creation_request_task

    processing_request = _reload_processing_request(processing_request.id)
    if _request_dispatch_pending(processing_request):
        return False

    try:
        async_result = kickoff_book_creation_request_task.apply_async(
            args=[str(processing_request.id)],
            queue=PROCESSING_TASK_QUEUE,
        )
    except Exception:
        logger.warning(
            "Processing request kickoff dispatch failed for %s.",
            processing_request.id,
            exc_info=True,
        )
        return False

    processing_request = _reload_processing_request(processing_request.id)
    if processing_request.state in {
        BookCreationRequestState.INITIAL,
        BookCreationRequestState.QUEUED,
    }:
        next_progress = {
            **_request_progress(processing_request),
            PROCESSING_DISPATCH_REQUESTED_AT_KEY: timezone.now().isoformat(),
        }
        task_id = str(getattr(async_result, "id", "") or "").strip()
        if task_id:
            next_progress[PROCESSING_DISPATCH_TASK_ID_KEY] = task_id
        processing_request.progress = next_progress
        processing_request.save(update_fields=["progress"])
    return True


def processing_state_label(state):
    try:
        return BookCreationState(state).label
    except ValueError:
        return str(state or "")


def processing_display_url(url):
    return unquote(str(url or "").strip())


def processing_display_path(url):
    parsed = urlparse((url or "").strip())
    return unquote(parsed.path).strip("/") or parsed.netloc


def processing_request_details(request):
    progress = request.progress if isinstance(request.progress, dict) else {}
    checkpoint = str(progress.get("checkpoint") or "").strip()
    saved_at = str(progress.get("savedAt") or "").strip()
    if checkpoint and saved_at:
        return f"{checkpoint} ({saved_at})"
    if checkpoint:
        return checkpoint
    if request.error_message:
        return request.error_message
    if request.duplicate_confirmed:
        return "Confirmed duplicate"
    if request.is_confirmed_not_duplicate:
        return "Confirmed new"
    if request.is_resumed:
        return "Resumed from saved progress"
    return ""


def processing_linked_book(record, request=None):
    request_book = getattr(request, "linked_book", None) if request is not None else None
    if (
        request is not None
        and getattr(request, "linked_book_id", None)
        and request_book is not None
        and request_book.deleted_at is None
    ):
        return request_book

    record_book = getattr(record, "linked_book", None)
    if (
        getattr(record, "linked_book_id", None)
        and record_book is not None
        and record_book.deleted_at is None
    ):
        return record_book

    return None


def processing_row_payload(record, request=None, *, selectable=True):
    progress = request.progress if isinstance(request and request.progress, dict) else {}
    linked_book = processing_linked_book(record, request)
    return {
        "id": str(request.id if request else record.id),
        "recordId": str(record.id),
        "requestId": str(request.id) if request else None,
        "title": record.name,
        "url": record.url,
        "displayUrl": processing_display_url(record.url),
        "displayPath": processing_display_path(record.url),
        "category": record.category,
        "writer": record.writer,
        "translator": record.translator,
        "publisher": record.publisher,
        "status": request.state if request else record.book_creation_state,
        "updatedAt": (
            request.updated_at.isoformat() if request else record.updated_at.isoformat()
        ),
        "selectable": bool(selectable),
        "progressCheckpoint": str(progress.get("checkpoint") or ""),
        "progressSavedAt": str(progress.get("savedAt") or ""),
        "errorMessage": request.error_message if request else "",
        "isResumed": bool(request.is_resumed) if request else False,
        "isConfirmedNotDuplicate": bool(request.is_confirmed_not_duplicate)
        if request
        else False,
        "linkedBookId": str(linked_book.id) if linked_book else None,
        "linkedBookSlug": linked_book.slug if linked_book else None,
        "duplicateOfRequestId": str(request.duplicate_of_request_id)
        if request and request.duplicate_of_request_id
        else None,
        "duplicateOfRecordId": str(request.duplicate_of_record_id)
        if request and request.duplicate_of_record_id
        else None,
        "duplicateConfirmed": bool(request.duplicate_confirmed) if request else False,
    }


def processing_row_search_text(row):
    details = ""
    if row.get("progressCheckpoint"):
        details = row["progressCheckpoint"]
    elif row.get("errorMessage"):
        details = row["errorMessage"]
    elif row.get("duplicateConfirmed"):
        details = "Confirmed duplicate"
    elif row.get("isConfirmedNotDuplicate"):
        details = "Confirmed new"
    elif row.get("isResumed"):
        details = "Resumed from saved progress"

    values = [
        row.get("title"),
        row.get("url"),
        row.get("displayUrl"),
        row.get("displayPath"),
        row.get("writer"),
        row.get("translator"),
        row.get("publisher"),
        row.get("category"),
        processing_state_label(row.get("status")),
        details,
    ]
    return " ".join(str(value or "") for value in values).casefold()


def processing_row_record_query(query):
    if not query:
        return Q()

    return (
        Q(name__icontains=query)
        | Q(url__icontains=query)
        | Q(category__icontains=query)
        | Q(writer__icontains=query)
        | Q(translator__icontains=query)
        | Q(publisher__icontains=query)
        | Q(processing_status__icontains=query)
    )


def processing_row_request_query(query):
    if not query:
        return Q()

    return (
        Q(book_record__name__icontains=query)
        | Q(book_record__url__icontains=query)
        | Q(book_record__category__icontains=query)
        | Q(book_record__writer__icontains=query)
        | Q(book_record__translator__icontains=query)
        | Q(book_record__publisher__icontains=query)
        | Q(state__icontains=query)
        | Q(error_message__icontains=query)
    )


def distinct_nonempty_values(queryset, field_name):
    return sorted(
        {
            value
            for value in queryset.order_by().values_list(field_name, flat=True).distinct()
            if value
        }
    )


def annotate_record_processing_status(queryset):
    latest_request_state = Subquery(
        BookCreationRequest.objects.filter(book_record_id=OuterRef("pk"))
        .order_by("-updated_at", "-created_at", "id")
        .values("state")[:1],
        output_field=CharField(),
    )
    return queryset.annotate(
        latest_request_state=latest_request_state,
    ).annotate(
        processing_status=Coalesce(F("latest_request_state"), F("book_creation_state")),
    )


def processing_pagination_payload(total_count, offset, limit, returned_count):
    next_offset = offset + returned_count
    return {
        "offset": offset,
        "limit": limit,
        "totalCount": total_count,
        "returnedCount": returned_count,
        "hasMore": next_offset < total_count,
        "nextOffset": next_offset,
    }


def build_processing_record_table_payload(
    queryset,
    *,
    query="",
    category="",
    status="",
    offset=0,
    limit=PROCESSING_TABLE_DEFAULT_LIMIT,
    selectable=True,
):
    category_options = distinct_nonempty_values(queryset, "category")
    status_options = distinct_nonempty_values(queryset, "processing_status")

    filtered_queryset = queryset
    if query:
        filtered_queryset = filtered_queryset.filter(processing_row_record_query(query))
    if category:
        filtered_queryset = filtered_queryset.filter(category=category)
    if status:
        filtered_queryset = filtered_queryset.filter(processing_status=status)

    total_count = filtered_queryset.count()
    page_records = list(filtered_queryset[offset : offset + limit])
    rows = []
    for record in page_records:
        latest_request = latest_request_for_record(record)
        rows.append(
            processing_row_payload(
                record,
                latest_request,
                selectable=record_is_selectable(record) if selectable else False,
            )
        )

    return {
        "rows": rows,
        "pagination": processing_pagination_payload(
            total_count,
            offset,
            limit,
            len(rows),
        ),
        "filters": {
            "categoryOptions": category_options,
            "statusOptions": status_options,
        },
    }


def build_processing_request_table_payload(
    queryset,
    *,
    query="",
    category="",
    status="",
    offset=0,
    limit=PROCESSING_TABLE_DEFAULT_LIMIT,
):
    category_options = distinct_nonempty_values(queryset, "book_record__category")
    status_options = distinct_nonempty_values(queryset, "state")

    filtered_queryset = queryset
    if query:
        filtered_queryset = filtered_queryset.filter(processing_row_request_query(query))
    if category:
        filtered_queryset = filtered_queryset.filter(book_record__category=category)
    if status:
        filtered_queryset = filtered_queryset.filter(state=status)

    total_count = filtered_queryset.count()
    page_requests = list(filtered_queryset[offset : offset + limit])
    rows = [
        processing_row_payload(processing_request.book_record, processing_request)
        for processing_request in page_requests
    ]

    return {
        "rows": rows,
        "pagination": processing_pagination_payload(
            total_count,
            offset,
            limit,
            len(rows),
        ),
        "filters": {
            "categoryOptions": category_options,
            "statusOptions": status_options,
        },
    }


def catalog_processing_rows():
    rows = []
    queryset = (
        BookRecord.objects.select_related("linked_book")
        .prefetch_related(processing_request_prefetch())
        .order_by("name", "id")
    )
    for record in queryset:
        latest_request = latest_request_for_record(record)
        rows.append(
            processing_row_payload(
                record,
                latest_request,
                selectable=record_is_selectable(record),
            )
        )

    return sorted(
        rows,
        key=lambda row: (
            0 if row["status"] == BookCreationState.NOT_CREATED else 1,
            normalize_category_key(row["title"]),
            row["id"],
        ),
    )


def request_processing_rows(states, *, predicate=None):
    queryset = (
        BookCreationRequest.objects.filter(state__in=states)
        .select_related("book_record", "linked_book", "book_record__linked_book")
        .order_by("-updated_at", "-created_at", "id")
    )
    rows = []
    for processing_request in queryset:
        record = processing_request.book_record
        if predicate and not predicate(processing_request, record):
            continue
        rows.append(processing_row_payload(record, processing_request))
    return rows


def incomplete_record_rows():
    queryset = (
        BookRecord.objects.select_related("linked_book")
        .prefetch_related(processing_request_prefetch())
        .filter(resolved_from_incomplete=False)
        .filter(Q(was_incomplete=True) | incomplete_category_query())
        .order_by("name", "id")
    )
    rows = []
    for record in queryset:
        latest_request = latest_request_for_record(record)
        rows.append(
            processing_row_payload(
                record,
                latest_request,
                selectable=False,
            )
        )
    return rows


def incomplete_completed_rows():
    return request_processing_rows(
        {BookCreationRequestState.CREATED},
        predicate=lambda _request, record: bool(
            record.was_incomplete and record.resolved_from_incomplete
        ),
    )


PROCESSING_TABLE_BUILDERS = {
    "catalog-records": catalog_processing_rows,
    "incomplete-records": incomplete_record_rows,
    "incomplete-completed": incomplete_completed_rows,
    **{
        card_id: (lambda states: lambda: request_processing_rows(states))(states)
        for card_id, states in PROCESSING_REQUEST_CARD_STATES.items()
    },
}


def processing_table_payload(card, *, query="", category="", status="", offset=0, limit=PROCESSING_TABLE_DEFAULT_LIMIT):
    offset_value = max(0, int(offset or 0))
    limit_value = max(
        1,
        min(int(limit or PROCESSING_TABLE_DEFAULT_LIMIT), PROCESSING_TABLE_MAX_LIMIT),
    )
    query_value = str(query or "").strip()

    if card == "catalog-records":
        return build_processing_record_table_payload(
            annotate_record_processing_status(
                BookRecord.objects.select_related("linked_book")
                .prefetch_related(processing_request_prefetch())
                .order_by("name", "id")
            ),
            query=query_value,
            category=category,
            status=status,
            offset=offset_value,
            limit=limit_value,
        )

    if card == "incomplete-records":
        return build_processing_record_table_payload(
            annotate_record_processing_status(
                BookRecord.objects.select_related("linked_book")
                .prefetch_related(processing_request_prefetch())
                .filter(resolved_from_incomplete=False)
                .filter(Q(was_incomplete=True) | incomplete_category_query())
                .order_by("name", "id")
            ),
            query=query_value,
            category=category,
            status=status,
            offset=offset_value,
            limit=limit_value,
            selectable=False,
        )

    if card == "incomplete-completed":
        return build_processing_request_table_payload(
            BookCreationRequest.objects.filter(state=BookCreationRequestState.CREATED)
            .filter(
                book_record__was_incomplete=True,
                book_record__resolved_from_incomplete=True,
            )
            .select_related("book_record", "linked_book", "book_record__linked_book")
            .order_by("-updated_at", "-created_at", "id"),
            query=query_value,
            category=category,
            status=status,
            offset=offset_value,
            limit=limit_value,
        )

    if card in PROCESSING_REQUEST_CARD_STATES:
        return build_processing_request_table_payload(
            BookCreationRequest.objects.filter(state__in=PROCESSING_REQUEST_CARD_STATES[card])
            .select_related("book_record", "linked_book", "book_record__linked_book")
            .order_by("-updated_at", "-created_at", "id"),
            query=query_value,
            category=category,
            status=status,
            offset=offset_value,
            limit=limit_value,
        )

    raise KeyError(card)


def processing_summary_payload():
    request_counts = {
        state: BookCreationRequest.objects.filter(state=state).count()
        for state in BookCreationRequestState.values
    }
    latest_failed_message = (
        BookCreationRequest.objects.filter(state=BookCreationRequestState.FAILED)
        .exclude(error_message="")
        .order_by("-updated_at", "-created_at", "id")
        .values_list("error_message", flat=True)
        .first()
        or ""
    )
    active_requests = sum(
        request_counts[state]
        for state in (
            BookCreationRequestState.INITIAL,
            BookCreationRequestState.QUEUED,
            BookCreationRequestState.PROCESSING,
        )
    )
    on_hold_requests = sum(
        request_counts[state]
        for state in (
            BookCreationRequestState.PAUSED,
            BookCreationRequestState.FAILED,
            BookCreationRequestState.DUPLICATE,
            BookCreationRequestState.DELETED,
        )
    )
    incomplete_records = (
        BookRecord.objects.filter(resolved_from_incomplete=False)
        .filter(Q(was_incomplete=True) | incomplete_category_query())
        .count()
    )
    resolved_incomplete_records = BookRecord.objects.filter(
        was_incomplete=True,
        resolved_from_incomplete=True,
    ).count()

    return {
        "catalog": {
            "records": BookRecord.objects.count(),
            "notCreated": BookRecord.objects.filter(
                book_creation_state=BookCreationState.NOT_CREATED
            ).count(),
            "active": active_requests,
            "created": request_counts[BookCreationRequestState.CREATED],
            "onHold": on_hold_requests,
        },
        "create": {
            "requests": request_counts[BookCreationRequestState.INITIAL],
            "queue": request_counts[BookCreationRequestState.QUEUED],
            "processing": request_counts[BookCreationRequestState.PROCESSING],
            "created": request_counts[BookCreationRequestState.CREATED],
        },
        "onHold": {
            "paused": request_counts[BookCreationRequestState.PAUSED],
            "failed": request_counts[BookCreationRequestState.FAILED],
            "duplicate": request_counts[BookCreationRequestState.DUPLICATE],
            "deleted": request_counts[BookCreationRequestState.DELETED],
        },
        "incomplete": {
            "incomplete": incomplete_records,
            "resolved": resolved_incomplete_records,
        },
        "notifications": {
            "activeRequests": active_requests,
            "createdCount": request_counts[BookCreationRequestState.CREATED],
            "failedCount": request_counts[BookCreationRequestState.FAILED],
            "duplicateCount": request_counts[BookCreationRequestState.DUPLICATE],
            "latestFailedMessage": latest_failed_message,
        },
    }


def create_request_for_record(record, state=BookCreationRequestState.INITIAL, origin=SubmissionOrigin.CURATION):
    processing_request = BookCreationRequest.objects.create(
        id=next_request_id(request_id_for_record(record)),
        book_record=record,
        state=state,
        origin=origin,
    )
    sync_record_state(record)
    if state == BookCreationRequestState.INITIAL and should_enqueue_processing_work():
        enqueue_request_processing(processing_request)
    return processing_request


def create_requests_for_record_ids(record_ids, *, actor=None, origin=SubmissionOrigin.CURATION):
    created = []
    for record in BookRecord.objects.filter(pk__in=record_ids).order_by("name", "id"):
        if not record_is_selectable(record):
            continue
        created.append(create_request_for_record(record, origin=origin))
    return created


def update_automation_settings(kind, payload):
    automation_settings = get_automation_settings(kind)
    automation_settings.enabled = bool(payload.get("enabled", automation_settings.enabled))
    automation_settings.interval = str(payload.get("interval") or automation_settings.interval)
    raw_time = payload.get("time")
    if raw_time:
        if isinstance(raw_time, time_type):
            automation_settings.time = raw_time
        else:
            hours, minutes = str(raw_time).split(":", 1)
            automation_settings.time = time_type(int(hours), int(minutes))
    automation_settings.saved = True
    automation_settings.status_message = "Saved."
    automation_settings.save()
    return automation_settings


def run_catalog_automation():
    sync_state = get_sync_state()
    remote_pages = catalog_remote_pages(sync_state.remote_pages)
    if settings.CELERY_TASK_ALWAYS_EAGER and not remote_pages:
        remote_pages = source_catalog_remote_pages()
    return start_sync(remote_pages, run_mode=SYNC_RUN_MODE_CATALOG_AUTOMATION)


def run_incomplete_automation():
    return start_sync(
        incomplete_automation_pages(),
        run_mode=SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
    )


@transaction.atomic
def reset_processing_data():
    BookCreationRequest.objects.all().delete()
    BookRecord.objects.update(
        book_creation_state=BookCreationState.NOT_CREATED,
        linked_book=None,
        is_duplicate=False,
        duplicate_of_record=None,
    )
    ProcessingSyncState.objects.all().update(
        status=ProcessingSyncStatus.IDLE,
        progress=None,
        remote_pages=[],
        page_index=0,
        fetched_count=0,
        skipped_count=0,
        updated_count=0,
        appended_count=0,
        message="Ready to sync.",
        task_id="",
        queue_name="",
        last_error="",
    )


PROCESSING_SOURCE_METADATA_CHECKPOINT = "source-metadata"
PROCESSING_SCRAPED_CONTENT_CHECKPOINT = "scraped-content"


def _request_progress(processing_request):
    return processing_request.progress if isinstance(processing_request.progress, dict) else {}


def _request_saved_data(processing_request):
    progress = _request_progress(processing_request)
    saved_data = progress.get("savedData")
    return saved_data if isinstance(saved_data, dict) else {}


def _request_dispatch_pending(processing_request):
    if processing_request.state not in {
        BookCreationRequestState.INITIAL,
        BookCreationRequestState.QUEUED,
    }:
        return False

    progress = _request_progress(processing_request)
    return bool(progress.get(PROCESSING_DISPATCH_REQUESTED_AT_KEY))


def _request_progress_without_dispatch_marker(progress):
    if not isinstance(progress, dict):
        return progress

    next_progress = dict(progress)
    next_progress.pop(PROCESSING_DISPATCH_REQUESTED_AT_KEY, None)
    next_progress.pop(PROCESSING_DISPATCH_TASK_ID_KEY, None)
    return next_progress or None


def _reload_processing_request(request_id):
    return (
        BookCreationRequest.objects.select_related("book_record", "linked_book")
        .get(pk=request_id)
    )


def _update_record_from_source_metadata(record, metadata):
    if not isinstance(metadata, dict):
        return record

    source_entry = upsert_source_catalog_entry(metadata)
    raw_data = metadata.get("raw_data") if isinstance(metadata.get("raw_data"), dict) else {}
    desired_values = {
        "name": metadata.get("title") or record.name,
        "writer": metadata.get("author_line") or record.writer,
        "category": raw_data.get("category") or record.category,
        "translator": raw_data.get("translator") or record.translator,
        "composer": raw_data.get("composer") or record.composer,
        "publisher": raw_data.get("publisher") or record.publisher,
        "source_catalog_entry": source_entry,
    }
    update_fields = [
        field_name
        for field_name, value in desired_values.items()
        if getattr(record, field_name) != value
    ]
    if update_fields:
        for field_name in update_fields:
            setattr(record, field_name, desired_values[field_name])
        record.save(update_fields=[*update_fields, "updated_at"])
    return record


def _build_processing_progress(checkpoint, saved_data):
    return {
        "savedAt": timezone.now().isoformat(),
        "checkpoint": checkpoint,
        "savedData": saved_data if isinstance(saved_data, dict) else {},
    }


def _save_paused_processing_progress(request_id, checkpoint, saved_data):
    processing_request = _reload_processing_request(request_id)
    if processing_request.state != BookCreationRequestState.PAUSED:
        return processing_request

    processing_request.progress = _build_processing_progress(checkpoint, saved_data)
    processing_request.error_message = ""
    processing_request.save(update_fields=["progress", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    return processing_request


def _duplicate_targets(existing_book, processing_request):
    target_request = (
        BookCreationRequest.objects.filter(linked_book=existing_book)
        .exclude(pk=processing_request.pk)
        .order_by("-updated_at", "-created_at")
        .first()
    )
    if target_request:
        return target_request, target_request.book_record

    target_record = (
        BookRecord.objects.filter(linked_book=existing_book)
        .exclude(pk=processing_request.book_record_id)
        .order_by("-updated_at", "-created_at")
        .first()
    )
    return None, target_record


def _mark_request_duplicate(processing_request, existing_book):
    processing_request = _reload_processing_request(processing_request.id)
    target_request, target_record = _duplicate_targets(existing_book, processing_request)
    processing_request.state = BookCreationRequestState.DUPLICATE
    processing_request.linked_book = existing_book
    processing_request.duplicate_of_request = target_request
    processing_request.duplicate_of_record = target_record
    processing_request.error_message = ""
    processing_request.save(
        update_fields=[
            "state",
            "linked_book",
            "duplicate_of_request",
            "duplicate_of_record",
            "error_message",
            "updated_at",
        ]
    )

    record = processing_request.book_record
    record.linked_book = existing_book
    record.is_duplicate = True
    record.duplicate_of_record = target_record
    record.save(update_fields=["linked_book", "is_duplicate", "duplicate_of_record", "updated_at"])
    sync_record_state(record)
    return processing_request


def _persist_processing_book(processing_request, normalized_url, scraped_data):
    submission_stub = SimpleNamespace(resolved_url=normalized_url)
    target_book = (
        processing_request.linked_book
        if processing_request.linked_book_id and processing_request.linked_book and processing_request.linked_book.deleted_at is None
        else None
    )
    book = persist_scraped_book(submission_stub, None, scraped_data, target_book=target_book)
    export_payload = export_payload_from_book(book, scraped_data)
    generate_exports(export_payload)
    sync_assets(book, None, export_payload)
    return book


def _finalize_processing_request(processing_request, book, scraped_data):
    processing_request = _reload_processing_request(processing_request.id)
    if processing_request.state == BookCreationRequestState.DELETED:
        if book.deleted_at is None:
            book.soft_delete()
        sync_record_state(processing_request.book_record)
        return processing_request
    if processing_request.state == BookCreationRequestState.PAUSED:
        _save_paused_processing_progress(
            processing_request.id,
            PROCESSING_SCRAPED_CONTENT_CHECKPOINT,
            {
                "scrapedData": scraped_data if isinstance(scraped_data, dict) else {},
                "linkedBookId": str(book.id),
            },
        )
        return _reload_processing_request(processing_request.id)

    processing_request.state = BookCreationRequestState.CREATED
    processing_request.linked_book = book
    processing_request.error_message = ""
    processing_request.progress = None
    processing_request.save(
        update_fields=["state", "linked_book", "error_message", "progress", "updated_at"]
    )
    record = processing_request.book_record
    record_update_fields = []
    if record.linked_book_id != book.id:
        record.linked_book = book
        record_update_fields.append("linked_book")
    if record.is_duplicate:
        record.is_duplicate = False
        record_update_fields.append("is_duplicate")
    if record.duplicate_of_record_id:
        record.duplicate_of_record = None
        record_update_fields.append("duplicate_of_record")
    if record_update_fields:
        record.save(update_fields=[*record_update_fields, "updated_at"])
    sync_record_state(record)
    return processing_request


def _normalize_scraped_payload(scraped_data):
    promoted_book_info, cleaned_main_content = promote_leading_front_matter(
        scraped_data.get("book_info", ""),
        scraped_data.get("main_content", ""),
    )
    return {
        **scraped_data,
        "book_info": promoted_book_info,
        "main_content": cleaned_main_content,
    }


def _processing_request_duplicate_check(processing_request, scraped_data):
    if processing_request.is_confirmed_not_duplicate:
        return None

    exact_title_duplicate = find_exact_existing_book(scraped_data)
    if exact_title_duplicate:
        return exact_title_duplicate

    if should_skip_processing_metadata_duplicate_check():
        return None

    metadata_duplicate = detect_metadata_duplicate(scraped_data)
    if metadata_duplicate:
        return metadata_duplicate

    return None


def _saved_scraped_data_for_resume(processing_request):
    saved_data = _request_saved_data(processing_request)
    checkpoint = _request_progress(processing_request).get("checkpoint") or ""
    scraped_data = saved_data.get("scrapedData")
    if not processing_request.is_resumed:
        return None
    if checkpoint != PROCESSING_SCRAPED_CONTENT_CHECKPOINT:
        return None
    if isinstance(scraped_data, dict):
        return scraped_data

    logger.warning(
        "Saved processing progress for request %s is corrupted. Falling back to a full restart.",
        processing_request.id,
    )
    return None


def _process_request_once(processing_request):
    processing_request = _reload_processing_request(processing_request.id)
    if processing_request.state in TERMINAL_STATES or processing_request.state == BookCreationRequestState.PAUSED:
        sync_record_state(processing_request.book_record)
        return processing_request

    normalized_url = normalize_source_url(processing_request.book_record.url)
    source_metadata = capture_source_page_metadata(normalized_url)
    if source_metadata:
        _update_record_from_source_metadata(processing_request.book_record, source_metadata)

    processing_request = _reload_processing_request(processing_request.id)
    if processing_request.state == BookCreationRequestState.DELETED:
        sync_record_state(processing_request.book_record)
        return processing_request
    if processing_request.state == BookCreationRequestState.PAUSED:
        return _save_paused_processing_progress(
            processing_request.id,
            PROCESSING_SOURCE_METADATA_CHECKPOINT,
            {"sourceMetadata": source_metadata or {}},
        )

    if not processing_request.is_confirmed_not_duplicate:
        source_duplicate = find_existing_book_by_source_url(normalized_url)
        if source_duplicate:
            return _mark_request_duplicate(processing_request, source_duplicate)

    scraped_data = _saved_scraped_data_for_resume(processing_request)
    if scraped_data is None:
        scraped_data = scrape_book(normalized_url)
        if not isinstance(scraped_data, dict):
            raise ValueError(
                f"Source scraping returned no content for {normalized_url}. "
                "Verify the source URL is valid and publicly reachable."
            )
    scraped_data = _normalize_scraped_payload(scraped_data)

    processing_request = _reload_processing_request(processing_request.id)
    if processing_request.state == BookCreationRequestState.DELETED:
        sync_record_state(processing_request.book_record)
        return processing_request
    if processing_request.state == BookCreationRequestState.PAUSED:
        return _save_paused_processing_progress(
            processing_request.id,
            PROCESSING_SCRAPED_CONTENT_CHECKPOINT,
            {"scrapedData": scraped_data},
        )

    duplicate_book = _processing_request_duplicate_check(
        processing_request,
        scraped_data,
    )
    if duplicate_book:
        return _mark_request_duplicate(processing_request, duplicate_book)

    book = _persist_processing_book(processing_request, normalized_url, scraped_data)
    return _finalize_processing_request(processing_request, book, scraped_data)


def _fail_processing_request(processing_request, error):
    processing_request = _reload_processing_request(processing_request.id)
    if processing_request.state in {
        BookCreationRequestState.DELETED,
        BookCreationRequestState.PAUSED,
    }:
        sync_record_state(processing_request.book_record)
        return processing_request

    processing_request.state = BookCreationRequestState.FAILED
    processing_request.error_message = str(error)
    processing_request.save(update_fields=["state", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    return processing_request


def _run_processing_request(processing_request):
    last_error = None
    for _attempt in range(MAX_PROCESSING_REQUEST_ATTEMPTS):
        try:
            return _process_request_once(processing_request)
        except Exception as exc:
            last_error = exc
            logger.exception(
                "Processing request %s failed.",
                processing_request.id,
            )
            reloaded = _reload_processing_request(processing_request.id)
            if reloaded.state in {
                BookCreationRequestState.DELETED,
                BookCreationRequestState.PAUSED,
            }:
                return reloaded
    return _fail_processing_request(processing_request, last_error or PROCESSING_STALE_MESSAGE)


def _transition_request_state(request_id, from_state, to_state):
    with transaction.atomic():
        processing_request = (
            BookCreationRequest.objects.select_for_update().get(pk=request_id)
        )
        if processing_request.state != from_state:
            return processing_request
        processing_request.state = to_state
        update_fields = ["state", "error_message", "updated_at"]
        if to_state == BookCreationRequestState.PROCESSING:
            processing_request.error_message = ""
            next_progress = _request_progress_without_dispatch_marker(
                processing_request.progress
            )
            if next_progress != processing_request.progress:
                processing_request.progress = next_progress
                update_fields.append("progress")
        processing_request.save(update_fields=update_fields)
        sync_record_state(processing_request.book_record)
        return processing_request


def kickoff_request_processing(request_id, actor=None):
    processing_request = _reload_processing_request(request_id)
    if processing_request.state == BookCreationRequestState.INITIAL:
        processing_request = _transition_request_state(
            request_id,
            BookCreationRequestState.INITIAL,
            BookCreationRequestState.QUEUED,
        )
    if processing_request.state == BookCreationRequestState.QUEUED:
        processing_request = _transition_request_state(
            request_id,
            BookCreationRequestState.QUEUED,
            BookCreationRequestState.PROCESSING,
        )
    if processing_request.state == BookCreationRequestState.PROCESSING:
        return _run_processing_request(processing_request)
    sync_record_state(processing_request.book_record)
    return processing_request


def refresh_processing_state():
    for record in BookRecord.objects.order_by("name", "id"):
        sync_record_state(record)


def mark_stale_processing_requests():
    cutoff = timezone.now() - PROCESSING_STALE_AFTER
    stale_requests = list(
        BookCreationRequest.objects.filter(
            state=BookCreationRequestState.PROCESSING,
            updated_at__lt=cutoff,
        ).select_related("book_record")
    )
    recovered = []
    for processing_request in stale_requests:
        processing_request.state = BookCreationRequestState.QUEUED
        processing_request.error_message = ""
        processing_request.save(update_fields=["state", "error_message", "updated_at"])
        sync_record_state(processing_request.book_record)
        recovered.append(processing_request)
        if should_enqueue_processing_work():
            enqueue_request_processing(processing_request)
    return recovered


def apply_delete_action(processing_request, *, delete_book=False):
    processing_request = _reload_processing_request(processing_request.id)
    if delete_book and processing_request.linked_book and processing_request.linked_book.deleted_at is None:
        processing_request.linked_book.soft_delete()

    processing_request.state = BookCreationRequestState.DELETED
    processing_request.progress = None
    processing_request.error_message = ""
    processing_request.save(update_fields=["state", "progress", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    return processing_request


def apply_pause_action(processing_request):
    processing_request = _reload_processing_request(processing_request.id)
    saved_data = _request_saved_data(processing_request)
    processing_request.state = BookCreationRequestState.PAUSED
    processing_request.progress = _build_processing_progress(
        _request_progress(processing_request).get("checkpoint") or "Pause requested",
        saved_data,
    )
    processing_request.error_message = ""
    processing_request.save(update_fields=["state", "progress", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    return processing_request


def apply_resume_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    processing_request.state = BookCreationRequestState.INITIAL
    processing_request.is_resumed = True
    processing_request.error_message = ""
    processing_request.save(update_fields=["state", "is_resumed", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    if should_enqueue_processing_work():
        enqueue_request_processing(processing_request)
    return processing_request


def apply_retry_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    processing_request.state = BookCreationRequestState.INITIAL
    processing_request.error_message = ""
    processing_request.progress = None
    processing_request.duplicate_confirmed = False
    processing_request.save(
        update_fields=[
            "state",
            "error_message",
            "progress",
            "duplicate_confirmed",
            "updated_at",
        ]
    )
    record = processing_request.book_record
    if record.is_duplicate or record.duplicate_of_record_id:
        record.is_duplicate = False
        record.duplicate_of_record = None
        record.save(update_fields=["is_duplicate", "duplicate_of_record", "updated_at"])
    sync_record_state(record)
    if should_enqueue_processing_work():
        enqueue_request_processing(processing_request)
    return processing_request


def apply_new_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    processing_request.state = BookCreationRequestState.INITIAL
    processing_request.is_confirmed_not_duplicate = True
    processing_request.duplicate_confirmed = False
    processing_request.duplicate_of_request = None
    processing_request.duplicate_of_record = None
    processing_request.linked_book = None
    processing_request.error_message = ""
    processing_request.progress = None
    processing_request.save(
        update_fields=[
            "state",
            "is_confirmed_not_duplicate",
            "duplicate_confirmed",
            "duplicate_of_request",
            "duplicate_of_record",
            "linked_book",
            "error_message",
            "progress",
            "updated_at",
        ]
    )
    record = processing_request.book_record
    record.linked_book = None
    record.is_duplicate = False
    record.duplicate_of_record = None
    record.save(
        update_fields=["linked_book", "is_duplicate", "duplicate_of_record", "updated_at"]
    )
    sync_record_state(record)
    if should_enqueue_processing_work():
        enqueue_request_processing(processing_request)
    return processing_request


def apply_confirm_duplicate_action(processing_request):
    processing_request = _reload_processing_request(processing_request.id)
    target_request = processing_request.duplicate_of_request
    if processing_request.duplicate_of_record_id and not target_request:
        target_request = (
            BookCreationRequest.objects.filter(book_record_id=processing_request.duplicate_of_record_id)
            .exclude(pk=processing_request.pk)
            .order_by("-updated_at", "-created_at")
            .first()
        )
    processing_request.state = BookCreationRequestState.DUPLICATE
    processing_request.duplicate_confirmed = True
    if target_request:
        processing_request.duplicate_of_request = target_request
        processing_request.duplicate_of_record = target_request.book_record
    processing_request.save(
        update_fields=[
            "state",
            "duplicate_confirmed",
            "duplicate_of_request",
            "duplicate_of_record",
            "updated_at",
        ]
    )

    if processing_request.duplicate_of_record_id:
        processing_request.book_record.is_duplicate = True
        processing_request.book_record.duplicate_of_record = processing_request.duplicate_of_record
        processing_request.book_record.save(
            update_fields=["is_duplicate", "duplicate_of_record", "updated_at"]
        )
    sync_record_state(processing_request.book_record)
    return processing_request


def apply_recreate_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    processing_request.state = BookCreationRequestState.INITIAL
    processing_request.progress = None
    processing_request.error_message = ""
    processing_request.duplicate_confirmed = False
    processing_request.save(
        update_fields=[
            "state",
            "progress",
            "error_message",
            "duplicate_confirmed",
            "updated_at",
        ]
    )
    record = processing_request.book_record
    if record.is_duplicate or record.duplicate_of_record_id:
        record.is_duplicate = False
        record.duplicate_of_record = None
        record.save(update_fields=["is_duplicate", "duplicate_of_record", "updated_at"])
    sync_record_state(record)
    if should_enqueue_processing_work():
        enqueue_request_processing(processing_request)
    return processing_request


def advance_pipeline_once():
    advanced = 0
    advanced += len(mark_stale_processing_requests())

    queued_request = (
        BookCreationRequest.objects.filter(state=BookCreationRequestState.QUEUED)
        .order_by("created_at", "id")
        .first()
    )
    if queued_request:
        if should_run_processing_jobs_inline():
            _transition_request_state(
                queued_request.id,
                BookCreationRequestState.QUEUED,
                BookCreationRequestState.PROCESSING,
            )
            advanced += 1
        elif not _request_dispatch_pending(queued_request):
            enqueue_request_processing(queued_request)
            advanced += 1

    processing_request = (
        BookCreationRequest.objects.filter(state=BookCreationRequestState.PROCESSING)
        .order_by("created_at", "id")
        .first()
    )
    if processing_request and should_run_processing_jobs_inline():
        _run_processing_request(processing_request)
        advanced += 1

    initial_request = (
        BookCreationRequest.objects.filter(state=BookCreationRequestState.INITIAL)
        .order_by("created_at", "id")
        .first()
    )
    if initial_request:
        _transition_request_state(
            initial_request.id,
            BookCreationRequestState.INITIAL,
            BookCreationRequestState.QUEUED,
        )
        advanced += 1

    if advanced == 0:
        refresh_processing_state()
    return advanced


def apply_request_action(request_ids, action, *, delete_book=False, actor=None):
    requests = list(
        BookCreationRequest.objects.filter(pk__in=request_ids)
        .select_related("book_record", "linked_book")
        .order_by("created_at", "id")
    )
    changed = []
    for processing_request in requests:
        if action == "delete":
            apply_delete_action(processing_request, delete_book=delete_book)
        elif action == "pause":
            apply_pause_action(processing_request)
        elif action == "resume":
            apply_resume_action(processing_request, actor=actor)
        elif action == "retry":
            apply_retry_action(processing_request, actor=actor)
        elif action == "new":
            apply_new_action(processing_request, actor=actor)
        elif action == "confirm_duplicate":
            apply_confirm_duplicate_action(processing_request)
        elif action in {"create_again", "recreate"}:
            apply_recreate_action(processing_request, actor=actor)
        else:
            continue
        changed.append(processing_request)
    sync_records_for_requests(changed)
    return changed
