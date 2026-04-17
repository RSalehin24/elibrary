from datetime import timedelta, time as time_type

from django.db import transaction
from django.utils import timezone

from apps.catalog.models import Book
from apps.common.models import LifecycleState, ReviewState

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
PROCESSING_STALE_AFTER = timedelta(minutes=20)
PROCESSING_STALE_MESSAGE = "Processing exceeded 20 minutes without completing."


def get_sync_state():
    state, _ = ProcessingSyncState.objects.get_or_create(
        singleton_key="default",
        defaults={"message": "Ready to sync."},
    )
    return state


def get_automation_settings(kind):
    default_time = time_type(2, 0) if kind == ProcessingAutomationKind.CATALOG else time_type(3, 0)
    settings, _ = ProcessingAutomationSettings.objects.get_or_create(
        kind=kind,
        defaults={
            "enabled": False,
            "interval": "daily",
            "time": default_time,
            "status_message": "Not configured.",
        },
    )
    return settings


def latest_request_for_record(record):
    return record.creation_requests.order_by("-updated_at", "-created_at").first()


def sync_record_state(record):
    latest_request = latest_request_for_record(record)
    if latest_request:
        next_state = latest_request.state
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
    return {
        "id": str(payload.get("id") or payload.get("url") or ""),
        "name": str(payload.get("name") or payload.get("title") or "Untitled book"),
        "url": str(payload.get("url") or ""),
        "category": str(payload.get("category") or "Uncategorized"),
        "writer": str(payload.get("writer") or payload.get("author") or ""),
        "translator": str(payload.get("translator") or ""),
        "composer": str(payload.get("composer") or ""),
        "publisher": str(payload.get("publisher") or ""),
        "updatedAt": timestamp,
        "bookCreationState": str(payload.get("bookCreationState") or payload.get("book_creation_state") or BookCreationState.NOT_CREATED),
        "wasIncomplete": bool(payload.get("wasIncomplete") or payload.get("was_incomplete")),
        "resolvedFromIncomplete": bool(payload.get("resolvedFromIncomplete") or payload.get("resolved_from_incomplete")),
        "willResolveToCategory": str(payload.get("willResolveToCategory") or payload.get("will_resolve_to_category") or ""),
    }


def upsert_remote_records(records):
    skipped_count = 0
    updated_count = 0
    appended_count = 0

    for raw_record in records:
        data = normalize_remote_record(raw_record)
        if not data["id"] or not data["url"]:
            continue

        defaults = {
            "name": data["name"],
            "url": data["url"],
            "category": data["category"],
            "writer": data["writer"],
            "translator": data["translator"],
            "composer": data["composer"],
            "publisher": data["publisher"],
            "was_incomplete": data["wasIncomplete"],
            "resolved_from_incomplete": data["resolvedFromIncomplete"],
            "will_resolve_to_category": data["willResolveToCategory"],
        }
        record, created = BookRecord.objects.get_or_create(
            id=data["id"],
            defaults={
                **defaults,
                "book_creation_state": data["bookCreationState"]
                if data["bookCreationState"] in BookCreationState.values
                else BookCreationState.NOT_CREATED,
            },
        )
        if created:
            appended_count += 1
            continue

        changed = any(getattr(record, field) != value for field, value in defaults.items())
        if changed:
            for field, value in defaults.items():
                setattr(record, field, value)
            record.save(update_fields=[*defaults.keys(), "updated_at"])
            updated_count += 1
        else:
            skipped_count += 1

    return {
        "skipped_count": skipped_count,
        "updated_count": updated_count,
        "appended_count": appended_count,
    }


def source_catalog_remote_pages(page_size=100):
    from apps.ingestion.models import SourceCatalogEntry

    entries = SourceCatalogEntry.objects.order_by("title", "id")
    pages = []
    current_page = []
    for entry in entries.iterator(chunk_size=page_size):
        raw_data = entry.raw_data or {}
        current_page.append(
            {
                "id": str(entry.id),
                "name": entry.title,
                "url": entry.source_url,
                "category": raw_data.get("category") or "Uncategorized",
                "writer": entry.author_line,
                "translator": raw_data.get("translator") or "",
                "composer": raw_data.get("composer") or "",
                "publisher": raw_data.get("publisher") or "",
                "updatedAt": entry.updated_at.isoformat(),
            }
        )
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


def start_sync(remote_pages=None):
    remote_pages = remote_pages if isinstance(remote_pages, list) else []
    if not remote_pages:
        remote_pages = source_catalog_remote_pages()
    state = get_sync_state()
    state.remote_pages = remote_pages
    state.status = ProcessingSyncStatus.SYNCING
    state.progress = None
    state.page_index = 0
    state.fetched_count = 0
    state.skipped_count = 0
    state.updated_count = 0
    state.appended_count = 0
    state.message = "Syncing catalog records."
    state.save()
    return state


def pause_sync():
    state = get_sync_state()
    if state.status == ProcessingSyncStatus.SYNCING:
        state.status = ProcessingSyncStatus.PAUSING
        state.message = "Pausing after the current page finishes."
        state.save(update_fields=["status", "message", "updated_at"])
    return state


def resume_sync():
    state = get_sync_state()
    state.status = ProcessingSyncStatus.SYNCING
    state.progress = None
    state.page_index = 0
    state.message = "Reconciling saved records from the beginning."
    state.save(update_fields=["status", "progress", "page_index", "message", "updated_at"])
    return state


def finalize_sync(state):
    state.status = ProcessingSyncStatus.IDLE
    state.progress = None
    state.message = (
        f"Sync complete. Updated {state.updated_count}, "
        f"Skipped {state.skipped_count}, Added {state.appended_count}."
    )
    state.save(
        update_fields=[
            "status",
            "progress",
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


def advance_sync_once():
    state = get_sync_state()
    if state.status not in {
        ProcessingSyncStatus.SYNCING,
        ProcessingSyncStatus.PAUSING,
    }:
        return state

    page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    if not page:
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
        state.progress = {
            "savedAt": timezone.now().isoformat(),
            "checkpoint": f"page-{state.page_index}",
            "savedData": {
                "fetchedCount": state.fetched_count,
                "nextPageIndex": state.page_index,
            },
        }
        state.message = f"Saved {state.fetched_count} {'record' if state.fetched_count == 1 else 'records'} before pausing."
    elif not next_page:
        return finalize_sync(state)
    else:
        state.message = f"Fetched {state.fetched_count} {'record' if state.fetched_count == 1 else 'records'} so far."
    state.save()
    return state


def request_id_for_record(record):
    return f"request-{record.id}"


def next_request_id(preferred_id):
    if not BookCreationRequest.objects.filter(pk=preferred_id).exists():
        return preferred_id
    index = 2
    while BookCreationRequest.objects.filter(pk=f"{preferred_id}-{index}").exists():
        index += 1
    return f"{preferred_id}-{index}"


def create_request_for_record(record, state=BookCreationRequestState.INITIAL):
    request = BookCreationRequest.objects.create(
        id=next_request_id(request_id_for_record(record)),
        book_record=record,
        state=state,
    )
    sync_record_state(record)
    return request


def request_blocks_record_selection(request):
    return request and request.state not in {
        BookCreationRequestState.FAILED,
        BookCreationRequestState.DELETED,
    }


def record_is_selectable(record):
    requests = list(record.creation_requests.order_by("-updated_at", "-created_at"))
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
    return not any(request_blocks_record_selection(request) for request in requests)


def create_requests_for_record_ids(record_ids):
    created = []
    for record in BookRecord.objects.filter(pk__in=record_ids):
        if not record_is_selectable(record):
            continue
        created.append(create_request_for_record(record))
    return created


def ensure_book_for_request(request):
    if request.linked_book_id:
        return request.linked_book

    book = Book.objects.create(
        title=request.book_record.name,
        state=LifecycleState.READY,
        review_state=ReviewState.PENDING,
        source_site="processing",
        raw_scraped_metadata={
            "processing_record_id": request.book_record_id,
            "source_url": request.book_record.url,
        },
    )
    request.linked_book = book
    request.book_record.linked_book = book
    request.save(update_fields=["linked_book", "updated_at"])
    request.book_record.save(update_fields=["linked_book", "updated_at"])
    return book


def advance_pipeline_once():
    advanced = 0
    for request in BookCreationRequest.objects.filter(state__in=ACTIVE_STATES).order_by("created_at", "id"):
        if (
            request.state == BookCreationRequestState.PROCESSING
            and request.updated_at <= timezone.now() - PROCESSING_STALE_AFTER
        ):
            request.state = BookCreationRequestState.FAILED
            request.error_message = request.error_message or PROCESSING_STALE_MESSAGE
            request.save()
            sync_record_state(request.book_record)
            advanced += 1
            continue
        if request.state == BookCreationRequestState.INITIAL:
            request.state = BookCreationRequestState.QUEUED
        elif request.state == BookCreationRequestState.QUEUED:
            request.state = BookCreationRequestState.PROCESSING
        elif request.state == BookCreationRequestState.PROCESSING:
            outcome = request.pipeline_outcome or BookCreationRequestState.CREATED
            if outcome == BookCreationRequestState.FAILED:
                request.state = BookCreationRequestState.FAILED
                request.error_message = request.error_message or "Pipeline failed after retries."
            elif outcome == BookCreationRequestState.DUPLICATE:
                request.state = BookCreationRequestState.DUPLICATE
            elif outcome == BookCreationRequestState.PAUSED:
                request.state = BookCreationRequestState.PAUSED
                request.progress = {
                    "savedAt": timezone.now().isoformat(),
                    "checkpoint": "Pipeline checkpoint",
                    "savedData": {},
                }
            else:
                request.state = BookCreationRequestState.CREATED
                ensure_book_for_request(request)
        request.save()
        sync_record_state(request.book_record)
        advanced += 1
    return advanced


def mark_stale_processing_requests():
    stale_requests = list(
        BookCreationRequest.objects.filter(state=BookCreationRequestState.PROCESSING).select_related("book_record")
    )
    marked = []
    cutoff = timezone.now() - PROCESSING_STALE_AFTER
    for request in stale_requests:
        if request.updated_at > cutoff:
            continue
        request.state = BookCreationRequestState.FAILED
        request.error_message = request.error_message or PROCESSING_STALE_MESSAGE
        request.save(update_fields=["state", "error_message", "updated_at"])
        sync_record_state(request.book_record)
        marked.append(request)
    return marked


def apply_request_action(request_ids, action, *, delete_book=False):
    requests = list(BookCreationRequest.objects.filter(pk__in=request_ids).select_related("book_record", "linked_book"))
    for request in requests:
        if action == "delete":
            request.state = BookCreationRequestState.DELETED
            request.progress = None
            request.error_message = ""
            if delete_book and request.linked_book and request.linked_book.deleted_at is None:
                request.linked_book.soft_delete()
        elif action == "pause":
            request.state = BookCreationRequestState.PAUSED
            request.progress = {
                "savedAt": timezone.now().isoformat(),
                "checkpoint": "Paused at processing",
                "savedData": {"source": "processing-card"},
            }
        elif action == "resume":
            request.state = BookCreationRequestState.INITIAL
            request.is_resumed = True
        elif action == "retry":
            request.state = BookCreationRequestState.INITIAL
            request.error_message = ""
        elif action == "new":
            request.state = BookCreationRequestState.INITIAL
            request.is_confirmed_not_duplicate = True
        elif action == "confirm_duplicate":
            request.state = BookCreationRequestState.DUPLICATE
            request.duplicate_confirmed = True
            if not request.duplicate_of_request:
                request.duplicate_of_request = (
                    BookCreationRequest.objects.exclude(pk=request.pk).order_by("-updated_at").first()
                )
            if not request.duplicate_of_record_id and request.duplicate_of_request:
                request.duplicate_of_record = request.duplicate_of_request.book_record
            request.book_record.is_duplicate = True
            request.book_record.duplicate_of_record = request.duplicate_of_record
            request.book_record.save(update_fields=["is_duplicate", "duplicate_of_record", "updated_at"])
        elif action in {"create_again", "recreate"}:
            request.state = BookCreationRequestState.INITIAL
            request.progress = None
            request.error_message = ""
        else:
            continue
        request.save()
    sync_records_for_requests(requests)
    return requests


def update_automation_settings(kind, payload):
    settings = get_automation_settings(kind)
    settings.enabled = bool(payload.get("enabled", settings.enabled))
    settings.interval = str(payload.get("interval") or settings.interval)
    raw_time = payload.get("time")
    if raw_time:
        if isinstance(raw_time, time_type):
            settings.time = raw_time
        else:
            hours, minutes = str(raw_time).split(":", 1)
            settings.time = time_type(int(hours), int(minutes))
    settings.saved = True
    settings.status_message = "Saved."
    settings.save()
    return settings


def run_catalog_automation():
    settings = get_automation_settings(ProcessingAutomationKind.CATALOG)
    sync_state = get_sync_state()
    remote_pages = sync_state.remote_pages if sync_state.remote_pages else source_catalog_remote_pages()
    reconciliation = reconcile_remote_pages(remote_pages)

    sync_state.remote_pages = remote_pages
    sync_state.status = ProcessingSyncStatus.IDLE
    sync_state.progress = None
    sync_state.page_index = reconciliation["page_index"]
    sync_state.fetched_count = reconciliation["fetched_count"]
    sync_state.skipped_count = reconciliation["skipped_count"]
    sync_state.updated_count = reconciliation["updated_count"]
    sync_state.appended_count = reconciliation["appended_count"]
    sync_state.message = (
        f"Sync complete. Updated {sync_state.updated_count}, "
        f"Skipped {sync_state.skipped_count}, Added {sync_state.appended_count}."
    )
    sync_state.save()

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
            created.append(create_request_for_record(record))
    settings.last_run_at = timezone.now()
    settings.status_message = f"Created {len(created)} {'request' if len(created) == 1 else 'requests'}."
    settings.save(update_fields=["last_run_at", "status_message", "updated_at"])
    return created


def run_incomplete_automation():
    settings = get_automation_settings(ProcessingAutomationKind.INCOMPLETE)
    resolved = []
    for record in BookRecord.objects.filter(category__iexact="Incomplete").exclude(will_resolve_to_category=""):
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
            )
        resolved.append(record)
    settings.last_run_at = timezone.now()
    settings.status_message = f"Resolved {len(resolved)} {'book' if len(resolved) == 1 else 'books'}."
    settings.save(update_fields=["last_run_at", "status_message", "updated_at"])
    return resolved


@transaction.atomic
def reset_processing_data():
    BookCreationRequest.objects.all().delete()
    BookRecord.objects.all().delete()
    ProcessingSyncState.objects.all().delete()
    ProcessingAutomationSettings.objects.all().delete()
