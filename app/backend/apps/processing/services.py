import json
import logging
import os
import sys
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import timedelta, time as time_type
from time import monotonic
from types import SimpleNamespace
from urllib.parse import unquote, urljoin, urlparse
from uuid import uuid4

from bs4 import BeautifulSoup
from config.celery import app as celery_app
from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import (
    Case,
    CharField,
    F,
    IntegerField,
    Max,
    OuterRef,
    Prefetch,
    Q,
    Subquery,
    Value,
    When,
)
from django.db.models.functions import Coalesce
from django.utils.dateparse import parse_datetime
from django.utils import timezone
from kombu import Queue
from redis import Redis
from redis.exceptions import RedisError

from apps.catalog.services import find_existing_book_by_source_url
from apps.ingestion.models import SourceCatalogEntry, SubmissionOrigin
from apps.ingestion.pipeline.scraper_support.network import create_session_with_retries
from apps.ingestion.services.normalization import promote_leading_front_matter
from apps.ingestion.services.resolution import CATALOG_URL, TitleResolver, get_with_host_fallback
from apps.ingestion.services.resolution_support import (
    fetch_source_page_metadata,
    metadata_entry_defaults,
    split_display_title,
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
    ProcessingUiDomainVersion,
    ProcessingUiProjection,
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
SYNC_TRIGGER_SOURCE_BUTTON = "button"
SYNC_TRIGGER_SOURCE_SCHEDULER = "scheduler"
PROCESSING_SYNC_KEY_CATALOG = "catalog"
PROCESSING_SYNC_KEY_INCOMPLETE = "incomplete"
CATALOG_SYNC_PHASE = "sync"
CATALOG_REQUEST_CREATION_PHASE = "request_creation"
CATALOG_PHASE_STATUS_NOT_STARTED = "not_started"
CATALOG_PHASE_STATUS_RUNNING = "running"
CATALOG_PHASE_STATUS_PAUSING = "pausing"
CATALOG_PHASE_STATUS_PAUSED = "paused"
CATALOG_PHASE_STATUS_COMPLETED = "completed"
CATALOG_PHASE_STATUSES = {
    CATALOG_PHASE_STATUS_NOT_STARTED,
    CATALOG_PHASE_STATUS_RUNNING,
    CATALOG_PHASE_STATUS_PAUSING,
    CATALOG_PHASE_STATUS_PAUSED,
    CATALOG_PHASE_STATUS_COMPLETED,
}
CATALOG_REQUEST_CREATION_BATCH_SIZE = 50
INCOMPLETE_CATEGORY_KEYWORDS = (
    "incomplete",
    "unfinished",
    "অসম্পূর্ণ",
    "অসম্পূর্ণ বই",
)
INCOMPLETE_CATALOG_URL = (
    "https://www.ebanglalibrary.com/genres/"
    "%E0%A6%85%E0%A6%B8%E0%A6%AE%E0%A7%8D%E0%A6%AA%E0%A7%82%E0%A6%B0%E0%A7%8D%E0%A6%A3-"
    "%E0%A6%AC%E0%A6%87/"
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
PROCESSING_DISPATCH_STALE_AFTER = timedelta(minutes=2)
MAX_PROCESSING_REQUEST_ATTEMPTS = 3
DEFAULT_AUTOMATION_INTERVAL = "weekly"
DEFAULT_AUTOMATION_TIME = time_type(3, 0)
LEGACY_AUTOMATION_STATUS_MESSAGE = "Not configured."
PROCESSING_TASK_QUEUE = "processing"
PROCESSING_WORKER_CACHE_SECONDS = 2
PROCESSING_DISPATCH_REQUESTED_AT_KEY = "_dispatchRequestedAt"
PROCESSING_DISPATCH_TASK_ID_KEY = "_dispatchTaskId"
PROCESSING_SYNC_CHECKPOINT_KEY_PREFIX = "processing:sync-checkpoint"
PROCESSING_TABLE_DEFAULT_LIMIT = 60
PROCESSING_TABLE_MAX_LIMIT = 600
PROCESSING_CARD_CATALOG_OVERVIEW = "catalog-overview"
PROCESSING_CARD_CATALOG_SYNC = "catalog-sync"
PROCESSING_CARD_CATALOG_AUTOMATION = "catalog-automation"
PROCESSING_CARD_CREATE_OVERVIEW = "create-overview"
PROCESSING_CARD_ON_HOLD_OVERVIEW = "on-hold-overview"
PROCESSING_CARD_INCOMPLETE_OVERVIEW = "incomplete-overview"
PROCESSING_CARD_INCOMPLETE_AUTOMATION = "incomplete-automation"
PROCESSING_CARD_CATALOG_RECORDS = "catalog-records"
PROCESSING_CARD_INCOMPLETE_RECORDS = "incomplete-records"
PROCESSING_CARD_INCOMPLETE_COMPLETED = "incomplete-completed"

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

PROCESSING_SHARED_CARD_KEYS = {
    PROCESSING_CARD_CATALOG_OVERVIEW,
    PROCESSING_CARD_CATALOG_SYNC,
    PROCESSING_CARD_CATALOG_AUTOMATION,
    PROCESSING_CARD_CREATE_OVERVIEW,
    PROCESSING_CARD_ON_HOLD_OVERVIEW,
    PROCESSING_CARD_INCOMPLETE_OVERVIEW,
    PROCESSING_CARD_INCOMPLETE_AUTOMATION,
}
PROCESSING_SHARED_PROJECTION_DEPENDENCIES = {
    PROCESSING_CARD_CATALOG_OVERVIEW: {PROCESSING_CARD_CATALOG_OVERVIEW},
    PROCESSING_CARD_CATALOG_SYNC: {
        PROCESSING_CARD_CATALOG_SYNC,
        PROCESSING_CARD_CATALOG_AUTOMATION,
    },
    PROCESSING_CARD_CATALOG_AUTOMATION: {PROCESSING_CARD_CATALOG_AUTOMATION},
    PROCESSING_CARD_CREATE_OVERVIEW: {PROCESSING_CARD_CREATE_OVERVIEW},
    PROCESSING_CARD_ON_HOLD_OVERVIEW: {PROCESSING_CARD_ON_HOLD_OVERVIEW},
    PROCESSING_CARD_INCOMPLETE_OVERVIEW: {PROCESSING_CARD_INCOMPLETE_OVERVIEW},
    PROCESSING_CARD_INCOMPLETE_AUTOMATION: {PROCESSING_CARD_INCOMPLETE_AUTOMATION},
}
PROCESSING_TABLE_CARD_KEYS = {
    PROCESSING_CARD_CATALOG_RECORDS,
    PROCESSING_CARD_INCOMPLETE_RECORDS,
    PROCESSING_CARD_INCOMPLETE_COMPLETED,
    *PROCESSING_REQUEST_CARD_STATES.keys(),
}
PROCESSING_CARD_KEYS = [
    PROCESSING_CARD_CATALOG_OVERVIEW,
    PROCESSING_CARD_CATALOG_SYNC,
    PROCESSING_CARD_CATALOG_AUTOMATION,
    PROCESSING_CARD_CATALOG_RECORDS,
    PROCESSING_CARD_CREATE_OVERVIEW,
    "create-requests",
    "create-queue",
    "create-processing",
    "create-created",
    PROCESSING_CARD_ON_HOLD_OVERVIEW,
    "on-hold-paused",
    "on-hold-failed",
    "on-hold-duplicate",
    "on-hold-deleted",
    PROCESSING_CARD_INCOMPLETE_OVERVIEW,
    PROCESSING_CARD_INCOMPLETE_AUTOMATION,
    PROCESSING_CARD_INCOMPLETE_RECORDS,
    PROCESSING_CARD_INCOMPLETE_COMPLETED,
]
PROCESSING_PAGE_DOMAINS = {
    PROCESSING_SYNC_KEY_CATALOG: {
        PROCESSING_CARD_CATALOG_OVERVIEW,
        PROCESSING_CARD_CATALOG_SYNC,
        PROCESSING_CARD_CATALOG_AUTOMATION,
        PROCESSING_CARD_CATALOG_RECORDS,
    },
    "create": {
        PROCESSING_CARD_CREATE_OVERVIEW,
        "create-requests",
        "create-queue",
        "create-processing",
        "create-created",
    },
    "on-hold": {
        PROCESSING_CARD_ON_HOLD_OVERVIEW,
        "on-hold-paused",
        "on-hold-failed",
        "on-hold-duplicate",
        "on-hold-deleted",
    },
    PROCESSING_SYNC_KEY_INCOMPLETE: {
        PROCESSING_CARD_INCOMPLETE_OVERVIEW,
        PROCESSING_CARD_INCOMPLETE_AUTOMATION,
        PROCESSING_CARD_INCOMPLETE_RECORDS,
        PROCESSING_CARD_INCOMPLETE_COMPLETED,
    },
}
PROCESSING_STATE_REQUEST_GROUP = {
    BookCreationRequestState.INITIAL,
    BookCreationRequestState.QUEUED,
    BookCreationRequestState.PROCESSING,
    BookCreationRequestState.CREATED,
}
PROCESSING_STATE_ON_HOLD_GROUP = {
    BookCreationRequestState.PAUSED,
    BookCreationRequestState.FAILED,
    BookCreationRequestState.DUPLICATE,
    BookCreationRequestState.DELETED,
}

PROCESSING_WORKER_AVAILABILITY = {
    "checked_at": 0.0,
    "available": None,
}
PROCESSING_UI_VERSION_COLLECTOR = ContextVar(
    "processing_ui_version_collector",
    default=None,
)
PROCESSING_CHECKPOINT_REDIS = {
    "url": "",
    "client": None,
    "disabled": False,
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


def catalog_phase_statuses(
    *,
    sync_status=CATALOG_PHASE_STATUS_NOT_STARTED,
    request_creation_status=CATALOG_PHASE_STATUS_NOT_STARTED,
):
    sync_status = catalog_phase_summary_status(sync_status)
    request_creation_status = catalog_phase_summary_status(request_creation_status)
    return {
        CATALOG_SYNC_PHASE: sync_status,
        CATALOG_REQUEST_CREATION_PHASE: request_creation_status,
    }


def _phase_saved_data(value):
    return value if isinstance(value, dict) else {}


def _phase_request_creation(value):
    return value if isinstance(value, dict) else None


def catalog_phase_is_active_status(status):
    return status in {
        CATALOG_PHASE_STATUS_RUNNING,
        CATALOG_PHASE_STATUS_PAUSING,
    }


def catalog_phase_summary_status(status):
    normalized_status = (
        status if status in CATALOG_PHASE_STATUSES else CATALOG_PHASE_STATUS_NOT_STARTED
    )
    if normalized_status == CATALOG_PHASE_STATUS_PAUSING:
        return CATALOG_PHASE_STATUS_RUNNING
    return normalized_status


def _runtime_catalog_phase_status(runtime_status, phase, progress_phase):
    if phase != progress_phase:
        return ""
    if runtime_status == ProcessingSyncStatus.PAUSING:
        return CATALOG_PHASE_STATUS_PAUSING
    if runtime_status == ProcessingSyncStatus.PAUSED:
        return CATALOG_PHASE_STATUS_PAUSED
    if runtime_status == ProcessingSyncStatus.SYNCING:
        return CATALOG_PHASE_STATUS_RUNNING
    return ""


def _catalog_phase_status_from_runtime(status, runtime_status, phase, progress_phase):
    runtime_phase_status = _runtime_catalog_phase_status(
        runtime_status,
        phase,
        progress_phase,
    )
    if runtime_phase_status:
        return runtime_phase_status
    return status


def _catalog_request_creation_checkpoint_available(
    request_creation,
    request_creation_base_token,
    request_creation_checkpoint="",
):
    return bool(
        _phase_request_creation(request_creation)
        or str(request_creation_base_token or "").strip()
        or str(request_creation_checkpoint or "").strip()
    )


def _normalize_catalog_phase_status_pair(
    sync_status,
    request_creation_status,
    *,
    progress_phase,
    request_creation,
    request_creation_base_token="",
    request_creation_checkpoint="",
):
    if (
        request_creation_status != CATALOG_PHASE_STATUS_NOT_STARTED
        and sync_status == CATALOG_PHASE_STATUS_NOT_STARTED
    ):
        sync_status = CATALOG_PHASE_STATUS_COMPLETED

    if not (
        catalog_phase_is_active_status(sync_status)
        and catalog_phase_is_active_status(request_creation_status)
    ):
        return sync_status, request_creation_status

    active_phase = (
        progress_phase
        if progress_phase in {CATALOG_SYNC_PHASE, CATALOG_REQUEST_CREATION_PHASE}
        else CATALOG_SYNC_PHASE
    )
    if active_phase == CATALOG_REQUEST_CREATION_PHASE:
        return CATALOG_PHASE_STATUS_COMPLETED, request_creation_status
    return (
        sync_status,
        (
            CATALOG_PHASE_STATUS_PAUSED
            if _catalog_request_creation_checkpoint_available(
                request_creation,
                request_creation_base_token,
                request_creation_checkpoint,
            )
            else CATALOG_PHASE_STATUS_NOT_STARTED
        ),
    )


def _catalog_phase_checkpoint_from_saved_data(saved_data):
    session_id = str(saved_data.get("sessionId") or "").strip()
    if not session_id:
        return ""
    return str(saved_data.get("checkpointToken") or "").strip() or catalog_sync_checkpoint_token(
        session_id,
        next_page_index=saved_data.get("nextPageIndex") or 0,
        fetched_count=saved_data.get("fetchedCount") or 0,
        live_fetch=bool(saved_data.get("liveFetch")),
    )


def _catalog_phase_state(
    phase,
    *,
    status=CATALOG_PHASE_STATUS_NOT_STARTED,
    owner="",
    trigger_source=SYNC_TRIGGER_SOURCE_BUTTON,
    checkpoint="",
    saved_at="",
    saved_data=None,
    request_creation=None,
    base_sync_checkpoint_token="",
):
    payload = {
        "status": status if status in CATALOG_PHASE_STATUSES else CATALOG_PHASE_STATUS_NOT_STARTED,
        "owner": str(owner or "").strip(),
        "triggerSource": str(trigger_source or SYNC_TRIGGER_SOURCE_BUTTON),
    }
    checkpoint = str(checkpoint or "").strip()
    if checkpoint:
        payload["checkpoint"] = checkpoint
    saved_at = str(saved_at or "").strip()
    if saved_at:
        payload["savedAt"] = saved_at
    if phase == CATALOG_SYNC_PHASE:
        saved_data = _phase_saved_data(saved_data)
        if saved_data:
            payload["savedData"] = saved_data
    else:
        base_sync_checkpoint_token = str(base_sync_checkpoint_token or "").strip()
        if base_sync_checkpoint_token:
            payload["baseSyncCheckpointToken"] = base_sync_checkpoint_token
        request_creation = _phase_request_creation(request_creation)
        if request_creation:
            payload["requestCreation"] = request_creation
    return payload


def _explicit_catalog_phase_status_from_progress(progress, phase):
    phase_statuses = progress.get("phaseStatuses")
    if not isinstance(phase_statuses, dict):
        return ""
    status = str(phase_statuses.get(phase) or "").strip()
    if status in CATALOG_PHASE_STATUSES:
        return status
    return ""


def _legacy_catalog_phase_states(progress, runtime_status):
    saved_data = _phase_saved_data(progress.get("savedData"))
    request_creation = _phase_request_creation(progress.get("requestCreation"))
    run_mode = (
        str(progress.get("runMode") or "").strip()
        or str(saved_data.get("runMode") or "").strip()
        or SYNC_RUN_MODE_MANUAL
    )
    trigger_source = (
        str(progress.get("triggerSource") or "").strip()
        or str(saved_data.get("triggerSource") or "").strip()
        or SYNC_TRIGGER_SOURCE_BUTTON
    )
    progress_phase = str(progress.get("phase") or CATALOG_SYNC_PHASE).strip() or CATALOG_SYNC_PHASE
    sync_status = _explicit_catalog_phase_status_from_progress(progress, CATALOG_SYNC_PHASE)
    if not sync_status:
        if progress_phase == CATALOG_REQUEST_CREATION_PHASE:
            sync_status = CATALOG_PHASE_STATUS_COMPLETED
        elif runtime_status == ProcessingSyncStatus.PAUSED:
            sync_status = CATALOG_PHASE_STATUS_PAUSED
        elif runtime_status in SYNC_ACTIVE_STATUSES:
            sync_status = CATALOG_PHASE_STATUS_RUNNING
        elif saved_data:
            sync_status = CATALOG_PHASE_STATUS_COMPLETED
        else:
            sync_status = CATALOG_PHASE_STATUS_NOT_STARTED
    sync_status = _catalog_phase_status_from_runtime(
        sync_status,
        runtime_status,
        CATALOG_SYNC_PHASE,
        progress_phase,
    )
    request_creation_status = _explicit_catalog_phase_status_from_progress(
        progress,
        CATALOG_REQUEST_CREATION_PHASE,
    )
    if not request_creation_status:
        if progress_phase == CATALOG_REQUEST_CREATION_PHASE:
            if runtime_status == ProcessingSyncStatus.PAUSED:
                request_creation_status = CATALOG_PHASE_STATUS_PAUSED
            elif runtime_status in SYNC_ACTIVE_STATUSES:
                request_creation_status = CATALOG_PHASE_STATUS_RUNNING
            else:
                request_creation_status = CATALOG_PHASE_STATUS_COMPLETED
        else:
            request_creation_status = CATALOG_PHASE_STATUS_NOT_STARTED
    request_creation_status = _catalog_phase_status_from_runtime(
        request_creation_status,
        runtime_status,
        CATALOG_REQUEST_CREATION_PHASE,
        progress_phase,
    )
    sync_checkpoint = ""
    if progress_phase == CATALOG_SYNC_PHASE:
        sync_checkpoint = str(progress.get("checkpoint") or "").strip()
    if not sync_checkpoint:
        sync_checkpoint = _catalog_phase_checkpoint_from_saved_data(saved_data)
    sync_saved_at = (
        str(progress.get("savedAt") or "").strip()
        if progress_phase == CATALOG_SYNC_PHASE
        else ""
    )
    request_creation_checkpoint = ""
    request_creation_saved_at = ""
    if progress_phase == CATALOG_REQUEST_CREATION_PHASE:
        request_creation_checkpoint = str(progress.get("checkpoint") or "").strip()
        request_creation_saved_at = str(progress.get("savedAt") or "").strip()
    if not request_creation_checkpoint and request_creation:
        request_creation_checkpoint = (
            f"request-{request_creation.get('lastRecordId') or request_creation.get('processedCount', 0)}"
        )
    request_creation_base_token = (
        str(progress.get("baseSyncCheckpointToken") or "").strip()
        or request_creation_base_checkpoint_token(request_creation)
        or _catalog_phase_checkpoint_from_saved_data(saved_data)
    )
    sync_status, request_creation_status = _normalize_catalog_phase_status_pair(
        sync_status,
        request_creation_status,
        progress_phase=progress_phase,
        request_creation=request_creation,
        request_creation_base_token=request_creation_base_token,
        request_creation_checkpoint=request_creation_checkpoint,
    )
    return {
        CATALOG_SYNC_PHASE: _catalog_phase_state(
            CATALOG_SYNC_PHASE,
            status=sync_status,
            owner=run_mode if sync_status != CATALOG_PHASE_STATUS_NOT_STARTED else "",
            trigger_source=trigger_source,
            checkpoint=sync_checkpoint,
            saved_at=sync_saved_at,
            saved_data={
                **saved_data,
                **({"runMode": run_mode} if run_mode else {}),
                **({"triggerSource": trigger_source} if trigger_source else {}),
            }
            if saved_data
            else {},
        ),
        CATALOG_REQUEST_CREATION_PHASE: _catalog_phase_state(
            CATALOG_REQUEST_CREATION_PHASE,
            status=request_creation_status,
            owner=(
                run_mode
                if request_creation_status != CATALOG_PHASE_STATUS_NOT_STARTED
                else ""
            ),
            trigger_source=trigger_source,
            checkpoint=request_creation_checkpoint,
            saved_at=request_creation_saved_at,
            request_creation=request_creation,
            base_sync_checkpoint_token=request_creation_base_token,
        ),
    }


def _normalized_catalog_phase_states(progress, runtime_status):
    phase_states = progress.get("phaseStates")
    if not isinstance(phase_states, dict):
        return _legacy_catalog_phase_states(progress, runtime_status)
    sync_phase_state = phase_states.get(CATALOG_SYNC_PHASE)
    request_creation_phase_state = phase_states.get(CATALOG_REQUEST_CREATION_PHASE)
    normalized_sync_saved_data = _phase_saved_data(
        sync_phase_state.get("savedData") if isinstance(sync_phase_state, dict) else None
    )
    if normalized_sync_saved_data:
        normalized_sync_saved_data = {
            **normalized_sync_saved_data,
            **(
                {"runMode": str(sync_phase_state.get("owner") or "").strip()}
                if str(sync_phase_state.get("owner") or "").strip()
                else {}
            ),
            **(
                {"triggerSource": str(sync_phase_state.get("triggerSource") or "").strip()}
                if str(sync_phase_state.get("triggerSource") or "").strip()
                else {}
            ),
        }
    normalized_request_creation = _phase_request_creation(
        request_creation_phase_state.get("requestCreation")
        if isinstance(request_creation_phase_state, dict)
        else None
    )
    request_creation_base_token = (
        str(
            request_creation_phase_state.get("baseSyncCheckpointToken") or ""
        ).strip()
        if isinstance(request_creation_phase_state, dict)
        else ""
    ) or request_creation_base_checkpoint_token(normalized_request_creation)
    progress_phase = (
        str(progress.get("phase") or CATALOG_SYNC_PHASE).strip() or CATALOG_SYNC_PHASE
    )
    sync_status = _catalog_phase_status_from_runtime(
        (
            sync_phase_state.get("status")
            if isinstance(sync_phase_state, dict)
            else CATALOG_PHASE_STATUS_NOT_STARTED
        ),
        runtime_status,
        CATALOG_SYNC_PHASE,
        progress_phase,
    )
    request_creation_status = _catalog_phase_status_from_runtime(
        (
            request_creation_phase_state.get("status")
            if isinstance(request_creation_phase_state, dict)
            else CATALOG_PHASE_STATUS_NOT_STARTED
        ),
        runtime_status,
        CATALOG_REQUEST_CREATION_PHASE,
        progress_phase,
    )
    request_creation_checkpoint = (
        request_creation_phase_state.get("checkpoint")
        if isinstance(request_creation_phase_state, dict)
        else ""
    )
    sync_status, request_creation_status = _normalize_catalog_phase_status_pair(
        sync_status,
        request_creation_status,
        progress_phase=progress_phase,
        request_creation=normalized_request_creation,
        request_creation_base_token=request_creation_base_token,
        request_creation_checkpoint=request_creation_checkpoint,
    )
    return {
        CATALOG_SYNC_PHASE: _catalog_phase_state(
            CATALOG_SYNC_PHASE,
            status=sync_status,
            owner=sync_phase_state.get("owner") if isinstance(sync_phase_state, dict) else "",
            trigger_source=(
                sync_phase_state.get("triggerSource")
                if isinstance(sync_phase_state, dict)
                else SYNC_TRIGGER_SOURCE_BUTTON
            ),
            checkpoint=sync_phase_state.get("checkpoint") if isinstance(sync_phase_state, dict) else "",
            saved_at=sync_phase_state.get("savedAt") if isinstance(sync_phase_state, dict) else "",
            saved_data=normalized_sync_saved_data,
        ),
        CATALOG_REQUEST_CREATION_PHASE: _catalog_phase_state(
            CATALOG_REQUEST_CREATION_PHASE,
            status=request_creation_status,
            owner=(
                request_creation_phase_state.get("owner")
                if isinstance(request_creation_phase_state, dict)
                else ""
            ),
            trigger_source=(
                request_creation_phase_state.get("triggerSource")
                if isinstance(request_creation_phase_state, dict)
                else SYNC_TRIGGER_SOURCE_BUTTON
            ),
            checkpoint=(
                request_creation_phase_state.get("checkpoint")
                if isinstance(request_creation_phase_state, dict)
                else ""
            ),
            saved_at=(
                request_creation_phase_state.get("savedAt")
                if isinstance(request_creation_phase_state, dict)
                else ""
            ),
            request_creation=normalized_request_creation,
            base_sync_checkpoint_token=request_creation_base_token,
        ),
    }


def catalog_phase_states(state):
    progress = state.progress if isinstance(state.progress, dict) else {}
    if state.singleton_key != PROCESSING_SYNC_KEY_CATALOG or not progress:
        return {
            CATALOG_SYNC_PHASE: _catalog_phase_state(CATALOG_SYNC_PHASE),
            CATALOG_REQUEST_CREATION_PHASE: _catalog_phase_state(
                CATALOG_REQUEST_CREATION_PHASE
            ),
        }
    return _normalized_catalog_phase_states(progress, state.status)


def catalog_summary_phase(phase_states):
    request_creation_status = phase_states[CATALOG_REQUEST_CREATION_PHASE]["status"]
    sync_status = phase_states[CATALOG_SYNC_PHASE]["status"]
    if catalog_phase_is_active_status(request_creation_status):
        return CATALOG_REQUEST_CREATION_PHASE
    if catalog_phase_is_active_status(sync_status) or sync_status == CATALOG_PHASE_STATUS_PAUSED:
        return CATALOG_SYNC_PHASE
    if request_creation_status == CATALOG_PHASE_STATUS_PAUSED:
        return CATALOG_REQUEST_CREATION_PHASE
    return CATALOG_SYNC_PHASE


def build_catalog_progress_payload(phase_states):
    phase_states = _normalized_catalog_phase_states(
        {"phaseStates": phase_states},
        ProcessingSyncStatus.IDLE,
    )
    summary_phase = catalog_summary_phase(phase_states)
    summary_phase_state = phase_states[summary_phase]
    sync_phase_state = phase_states[CATALOG_SYNC_PHASE]
    request_creation_phase_state = phase_states[CATALOG_REQUEST_CREATION_PHASE]
    payload = {
        "runMode": summary_phase_state.get("owner") or SYNC_RUN_MODE_MANUAL,
        "triggerSource": (
            summary_phase_state.get("triggerSource") or SYNC_TRIGGER_SOURCE_BUTTON
        ),
        "phase": summary_phase,
        "phaseStatuses": catalog_phase_statuses(
            sync_status=sync_phase_state["status"],
            request_creation_status=request_creation_phase_state["status"],
        ),
        "phaseStates": phase_states,
    }
    checkpoint = str(summary_phase_state.get("checkpoint") or "").strip()
    if checkpoint:
        payload["checkpoint"] = checkpoint
    saved_at = str(summary_phase_state.get("savedAt") or "").strip()
    if saved_at:
        payload["savedAt"] = saved_at
    sync_saved_data = _phase_saved_data(sync_phase_state.get("savedData"))
    if sync_saved_data:
        payload["savedData"] = sync_saved_data
    request_creation = _phase_request_creation(
        request_creation_phase_state.get("requestCreation")
    )
    if request_creation:
        payload["requestCreation"] = request_creation
    return payload


def catalog_phase_state(state, phase):
    return catalog_phase_states(state).get(phase, _catalog_phase_state(phase))


def replace_catalog_phase_state(phase, phase_state, **overrides):
    phase_state = phase_state if isinstance(phase_state, dict) else {}
    if phase == CATALOG_SYNC_PHASE:
        return _catalog_phase_state(
            CATALOG_SYNC_PHASE,
            status=overrides.get("status", phase_state.get("status")),
            owner=overrides.get("owner", phase_state.get("owner")),
            trigger_source=overrides.get(
                "trigger_source",
                phase_state.get("triggerSource"),
            ),
            checkpoint=overrides.get("checkpoint", phase_state.get("checkpoint")),
            saved_at=overrides.get("saved_at", phase_state.get("savedAt")),
            saved_data=overrides.get("saved_data", phase_state.get("savedData")),
        )
    return _catalog_phase_state(
        CATALOG_REQUEST_CREATION_PHASE,
        status=overrides.get("status", phase_state.get("status")),
        owner=overrides.get("owner", phase_state.get("owner")),
        trigger_source=overrides.get(
            "trigger_source",
            phase_state.get("triggerSource"),
        ),
        checkpoint=overrides.get("checkpoint", phase_state.get("checkpoint")),
        saved_at=overrides.get("saved_at", phase_state.get("savedAt")),
        request_creation=overrides.get(
            "request_creation",
            phase_state.get("requestCreation"),
        ),
        base_sync_checkpoint_token=overrides.get(
            "base_sync_checkpoint_token",
            phase_state.get("baseSyncCheckpointToken"),
        ),
    )


def catalog_runtime_status(phase_states):
    statuses = {
        phase_states[CATALOG_SYNC_PHASE]["status"],
        phase_states[CATALOG_REQUEST_CREATION_PHASE]["status"],
    }
    if CATALOG_PHASE_STATUS_PAUSING in statuses:
        return ProcessingSyncStatus.PAUSING
    if CATALOG_PHASE_STATUS_RUNNING in statuses:
        return ProcessingSyncStatus.SYNCING
    if CATALOG_PHASE_STATUS_PAUSED in statuses:
        return ProcessingSyncStatus.PAUSED
    return ProcessingSyncStatus.IDLE


def persist_catalog_phase_states(
    state,
    phase_states,
    *,
    message=None,
    update_fields=None,
):
    state.status = catalog_runtime_status(phase_states)
    state.progress = build_catalog_progress_payload(phase_states)
    state.task_id = ""
    state.queue_name = ""
    if message is not None:
        state.message = message
    save_sync_state(
        state,
        update_fields=update_fields
        or [
            "status",
            "progress",
            "task_id",
            "queue_name",
            "message",
            "updated_at",
        ],
    )
    return state


def sync_run_mode(state):
    progress = sync_progress_payload(state)
    saved_data = _phase_saved_data(progress.get("savedData"))
    return progress.get("runMode") or saved_data.get("runMode") or SYNC_RUN_MODE_MANUAL


def sync_trigger_source(state):
    progress = sync_progress_payload(state)
    saved_data = _phase_saved_data(progress.get("savedData"))
    return (
        progress.get("triggerSource")
        or saved_data.get("triggerSource")
        or SYNC_TRIGGER_SOURCE_BUTTON
    )


def sync_progress_payload(state):
    progress = state.progress if isinstance(state.progress, dict) else {}
    if state.singleton_key == PROCESSING_SYNC_KEY_CATALOG and progress:
        return build_catalog_progress_payload(catalog_phase_states(state))
    return progress


def sync_saved_data(state):
    saved_data = sync_progress_payload(state).get("savedData")
    return saved_data if isinstance(saved_data, dict) else {}


def sync_phase(state):
    return str(sync_progress_payload(state).get("phase") or CATALOG_SYNC_PHASE)


def _explicit_catalog_phase_status(state, phase):
    phase_statuses = sync_progress_payload(state).get("phaseStatuses")
    if not isinstance(phase_statuses, dict):
        return ""
    status = str(phase_statuses.get(phase) or "").strip()
    if status in CATALOG_PHASE_STATUSES:
        return status
    return ""


def catalog_sync_phase_status(state):
    if state.singleton_key != PROCESSING_SYNC_KEY_CATALOG:
        return CATALOG_PHASE_STATUS_NOT_STARTED
    return catalog_phase_states(state)[CATALOG_SYNC_PHASE]["status"]


def catalog_request_creation_phase_status(state):
    if state.singleton_key != PROCESSING_SYNC_KEY_CATALOG:
        return CATALOG_PHASE_STATUS_NOT_STARTED
    return catalog_phase_states(state)[CATALOG_REQUEST_CREATION_PHASE]["status"]


def catalog_request_creation_progress(state):
    request_creation = catalog_phase_states(state)[CATALOG_REQUEST_CREATION_PHASE].get(
        "requestCreation"
    )
    return request_creation if isinstance(request_creation, dict) else None


def catalog_sync_checkpoint_token(
    session_id,
    *,
    next_page_index=0,
    fetched_count=0,
    live_fetch=False,
):
    return (
        f"{session_id}:{1 if live_fetch else 0}:"
        f"{int(next_page_index)}:{int(fetched_count)}"
    )


def current_catalog_sync_checkpoint_token(state):
    return _catalog_phase_checkpoint_from_saved_data(sync_saved_data(state))


def catalog_shared_runtime(run_mode):
    return run_mode in {
        SYNC_RUN_MODE_MANUAL,
        SYNC_RUN_MODE_CATALOG_AUTOMATION,
    }


def request_creation_base_checkpoint_token(request_creation):
    if not isinstance(request_creation, dict):
        return ""
    return str(request_creation.get("baseCheckpointToken") or "").strip()


def request_creation_matches_checkpoint(request_creation, checkpoint_token):
    return bool(checkpoint_token) and request_creation_base_checkpoint_token(
        request_creation
    ) == str(checkpoint_token).strip()


def preserve_catalog_request_creation_progress(request_creation, checkpoint_token):
    if request_creation_matches_checkpoint(request_creation, checkpoint_token):
        return request_creation
    return None


def initial_catalog_request_creation_progress(state):
    return {
        "baseCheckpointToken": current_catalog_sync_checkpoint_token(state),
        "lastRecordId": "",
        "processedCount": 0,
        "createdCount": 0,
        "unsupportedCount": 0,
    }


def catalog_request_creation_can_resume(state):
    if catalog_request_creation_phase_status(state) != CATALOG_PHASE_STATUS_PAUSED:
        return False
    request_creation_phase_state = catalog_phase_states(state)[CATALOG_REQUEST_CREATION_PHASE]
    request_creation = _phase_request_creation(request_creation_phase_state.get("requestCreation"))
    checkpoint_token = str(
        request_creation_phase_state.get("baseSyncCheckpointToken") or ""
    ).strip() or request_creation_base_checkpoint_token(request_creation)
    return request_creation_matches_checkpoint(request_creation, checkpoint_token)


def catalog_saved_checkpoint_available(state):
    saved_data = sync_saved_data(state)
    return state.singleton_key == PROCESSING_SYNC_KEY_CATALOG and bool(saved_data)


def sync_key_for_run_mode(run_mode):
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        return PROCESSING_SYNC_KEY_INCOMPLETE
    return PROCESSING_SYNC_KEY_CATALOG


def sync_state_task_payload(state):
    progress = (
        sync_progress_payload(state)
        if isinstance(state.progress, dict)
        else None
    )
    return {
        "singleton_key": state.singleton_key,
        "status": state.status,
        "progress": progress,
        "remote_pages": state.remote_pages,
        "page_index": state.page_index,
        "fetched_count": state.fetched_count,
        "skipped_count": state.skipped_count,
        "updated_count": state.updated_count,
        "appended_count": state.appended_count,
        "message": state.message,
        "run_mode": sync_run_mode(state),
    }

def processing_sync_checkpoint_key(sync_key):
    return f"{PROCESSING_SYNC_CHECKPOINT_KEY_PREFIX}:{sync_key}"


def processing_checkpoint_redis_url():
    return str(
        getattr(settings, "PROCESSING_CHECKPOINT_REDIS_URL", "")
        or settings.CELERY_BROKER_URL
        or ""
    ).strip()


def processing_checkpoint_client():
    redis_url = processing_checkpoint_redis_url()
    if not redis_url:
        return None

    if (
        PROCESSING_CHECKPOINT_REDIS["client"] is not None
        and PROCESSING_CHECKPOINT_REDIS["url"] == redis_url
        and not PROCESSING_CHECKPOINT_REDIS["disabled"]
    ):
        return PROCESSING_CHECKPOINT_REDIS["client"]

    if (
        PROCESSING_CHECKPOINT_REDIS["disabled"]
        and PROCESSING_CHECKPOINT_REDIS["url"] == redis_url
    ):
        return None

    try:
        client = Redis.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=0.5,
            socket_timeout=0.5,
        )
        PROCESSING_CHECKPOINT_REDIS.update(
            {
                "url": redis_url,
                "client": client,
                "disabled": False,
            }
        )
        return client
    except Exception:
        logger.debug(
            "Processing checkpoint Redis client initialization failed.",
            exc_info=True,
        )
        PROCESSING_CHECKPOINT_REDIS.update(
            {
                "url": redis_url,
                "client": None,
                "disabled": True,
            }
        )
        return None


def processing_checkpoint_payload(state):
    progress = (
        sync_progress_payload(state)
        if isinstance(state.progress, dict)
        else None
    )
    if not progress:
        return None

    return {
        "scope": state.singleton_key,
        "status": state.status,
        "runMode": sync_run_mode(state),
        "triggerSource": sync_trigger_source(state),
        "pageIndex": state.page_index,
        "fetchedCount": state.fetched_count,
        "skippedCount": state.skipped_count,
        "updatedCount": state.updated_count,
        "appendedCount": state.appended_count,
        "message": state.message,
        "progress": progress,
        "updatedAt": state.updated_at.isoformat() if state.updated_at else "",
    }


def clear_processing_checkpoint_mirror(sync_key):
    client = processing_checkpoint_client()
    if client is None:
        return False

    try:
        client.delete(processing_sync_checkpoint_key(sync_key))
        return True
    except RedisError:
        logger.debug(
            "Processing checkpoint Redis delete failed for %s.",
            sync_key,
            exc_info=True,
        )
        return False


def mirror_processing_checkpoint(state):
    client = processing_checkpoint_client()
    if client is None:
        return False

    payload = processing_checkpoint_payload(state)
    checkpoint_key = processing_sync_checkpoint_key(state.singleton_key)
    try:
        if payload is None:
            client.delete(checkpoint_key)
        else:
            client.set(checkpoint_key, json.dumps(payload))
        return True
    except RedisError:
        logger.debug(
            "Processing checkpoint Redis write failed for %s.",
            state.singleton_key,
            exc_info=True,
        )
        return False


def sync_checkpoint_progress(state):
    progress = (
        sync_progress_payload(state)
        if isinstance(state.progress, dict)
        else None
    )
    if progress:
        mirror_processing_checkpoint(state)
    else:
        clear_processing_checkpoint_mirror(state.singleton_key)
    return progress


def save_sync_state(state, *, update_fields=None):
    if state.pk is None or update_fields is None:
        state.save()
    else:
        unique_fields = list(dict.fromkeys(update_fields))
        state.save(update_fields=unique_fields)
    sync_checkpoint_progress(state)
    publish_processing_ui_domains(processing_domains_for_sync_state(state))
    return state


def should_run_processing_jobs_inline():
    return bool(
        settings.CELERY_TASK_ALWAYS_EAGER
        or getattr(settings, "PROCESSING_INLINE_PIPELINE_ADVANCE", False)
    )


def processing_workers_available(queue_name=PROCESSING_TASK_QUEUE):
    if should_run_processing_jobs_inline():
        return False
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False

    checked_at = PROCESSING_WORKER_AVAILABILITY["checked_at"]
    available = PROCESSING_WORKER_AVAILABILITY["available"]
    now = monotonic()
    if available is not None and (now - checked_at) < PROCESSING_WORKER_CACHE_SECONDS:
        return available

    detected = False
    try:
        inspector = celery_app.control.inspect(timeout=0.5)
        active_queues = inspector.active_queues() or {}
        detected = any(
            any((queue or {}).get("name") == queue_name for queue in (queues or []))
            for queues in active_queues.values()
        )
    except Exception:
        logger.debug(
            "Processing worker availability check failed; assuming manual progression.",
            exc_info=True,
        )

    PROCESSING_WORKER_AVAILABILITY["checked_at"] = now
    PROCESSING_WORKER_AVAILABILITY["available"] = detected
    return detected


def should_enqueue_processing_work():
    if should_run_processing_jobs_inline():
        return False
    if not os.environ.get("PYTEST_CURRENT_TEST"):
        return True
    return processing_workers_available()


def should_manually_advance_processing_work():
    return not should_run_processing_jobs_inline() and not processing_workers_available()


def should_skip_processing_metadata_duplicate_check():
    return bool(
        getattr(settings, "PROCESSING_SKIP_METADATA_DUPLICATE_CHECK", True)
    )


def allow_processing_remote_page_payloads():
    return bool(
        getattr(settings, "PROCESSING_ALLOW_REMOTE_PAGE_PAYLOADS", False)
        or "pytest" in sys.modules
        or os.environ.get("PYTEST_CURRENT_TEST")
    )


def can_process_record_url(url):
    return allow_processing_remote_page_payloads() or uses_supported_source_url(url)


def sync_uses_live_fetch(state):
    saved_data = sync_saved_data(state)
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


def catalog_record_total_message():
    total_records = BookRecord.objects.count()
    label = "book record" if total_records == 1 else "book records"
    return f"Catalog now has {total_records} {label}."


def sync_progress_message(run_mode, processed_count):
    label = "record" if processed_count == 1 else "records"
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        return f"Processed {processed_count} incomplete {label} so far."
    return catalog_record_total_message()


def sync_pause_message(run_mode):
    if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
        return "Pausing automated catalog sync after the current page finishes."
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        return "Pausing incomplete catalog sync after the current batch finishes."
    return "Pausing after the current page finishes."


def build_sync_progress(
    run_mode,
    *,
    next_page_index=0,
    fetched_count=0,
    saved_at=None,
    live_fetch=False,
    trigger_source=SYNC_TRIGGER_SOURCE_BUTTON,
    session_id="",
    request_creation=None,
    sync_phase_status=CATALOG_PHASE_STATUS_RUNNING,
    request_creation_phase_status=CATALOG_PHASE_STATUS_NOT_STARTED,
):
    session_id = str(session_id or "").strip()
    payload = {
        "runMode": run_mode,
        "triggerSource": trigger_source,
        "phase": CATALOG_SYNC_PHASE,
        "checkpoint": f"page-{next_page_index}",
        "savedData": {
            "runMode": run_mode,
            "triggerSource": trigger_source,
            "fetchedCount": fetched_count,
            "nextPageIndex": next_page_index,
        },
    }
    if session_id:
        payload["savedData"]["sessionId"] = session_id
        payload["savedData"]["checkpointToken"] = catalog_sync_checkpoint_token(
            session_id,
            next_page_index=next_page_index,
            fetched_count=fetched_count,
            live_fetch=live_fetch,
        )
    if live_fetch:
        payload["savedData"]["liveFetch"] = True
    if saved_at:
        payload["savedAt"] = saved_at
    return payload


def build_catalog_sync_progress(
    state,
    run_mode,
    *,
    next_page_index=0,
    fetched_count=0,
    saved_at=None,
    live_fetch=False,
    trigger_source=SYNC_TRIGGER_SOURCE_BUTTON,
    session_id="",
    sync_phase_status=CATALOG_PHASE_STATUS_RUNNING,
    request_creation_phase_state=None,
):
    session_id = str(session_id or "").strip()
    saved_data = {
        "runMode": run_mode,
        "triggerSource": trigger_source,
        "fetchedCount": fetched_count,
        "nextPageIndex": next_page_index,
    }
    if session_id:
        saved_data["sessionId"] = session_id
        saved_data["checkpointToken"] = catalog_sync_checkpoint_token(
            session_id,
            next_page_index=next_page_index,
            fetched_count=fetched_count,
            live_fetch=live_fetch,
        )
    if live_fetch:
        saved_data["liveFetch"] = True
    sync_phase_state = _catalog_phase_state(
        CATALOG_SYNC_PHASE,
        status=sync_phase_status,
        owner=run_mode,
        trigger_source=trigger_source,
        checkpoint=f"page-{next_page_index}",
        saved_at=saved_at,
        saved_data=saved_data,
    )
    current_request_creation_phase_state = (
        request_creation_phase_state
        if isinstance(request_creation_phase_state, dict)
        else catalog_phase_state(state, CATALOG_REQUEST_CREATION_PHASE)
    )
    request_creation_status = current_request_creation_phase_state.get("status")
    if request_creation_status == CATALOG_PHASE_STATUS_PAUSED:
        next_request_creation_phase_state = replace_catalog_phase_state(
            CATALOG_REQUEST_CREATION_PHASE,
            current_request_creation_phase_state,
        )
    else:
        next_request_creation_phase_state = _catalog_phase_state(
            CATALOG_REQUEST_CREATION_PHASE,
            status=CATALOG_PHASE_STATUS_NOT_STARTED,
        )
    return build_catalog_progress_payload(
        {
            CATALOG_SYNC_PHASE: sync_phase_state,
            CATALOG_REQUEST_CREATION_PHASE: next_request_creation_phase_state,
        }
    )


def build_catalog_request_creation_progress(
    state,
    *,
    request_creation,
    run_mode=SYNC_RUN_MODE_CATALOG_AUTOMATION,
    trigger_source=SYNC_TRIGGER_SOURCE_BUTTON,
    saved_at=None,
    request_creation_phase_status=CATALOG_PHASE_STATUS_RUNNING,
    sync_phase_state=None,
):
    current_sync_phase_state = (
        sync_phase_state
        if isinstance(sync_phase_state, dict)
        else replace_catalog_phase_state(
            CATALOG_SYNC_PHASE,
            catalog_phase_state(state, CATALOG_SYNC_PHASE),
            status=CATALOG_PHASE_STATUS_COMPLETED,
            owner=(
                catalog_phase_state(state, CATALOG_SYNC_PHASE).get("owner")
                or run_mode
            ),
            trigger_source=(
                catalog_phase_state(state, CATALOG_SYNC_PHASE).get("triggerSource")
                or trigger_source
            ),
            checkpoint=(
                catalog_phase_state(state, CATALOG_SYNC_PHASE).get("checkpoint")
                or f"page-{sync_saved_data(state).get('nextPageIndex') or state.page_index or 0}"
            ),
            saved_data=(
                _phase_saved_data(catalog_phase_state(state, CATALOG_SYNC_PHASE).get("savedData"))
                or {
                    **sync_saved_data(state),
                    "runMode": (
                        catalog_phase_state(state, CATALOG_SYNC_PHASE).get("owner")
                        or run_mode
                    ),
                    "triggerSource": (
                        catalog_phase_state(state, CATALOG_SYNC_PHASE).get("triggerSource")
                        or trigger_source
                    ),
                }
            ),
        )
    )
    request_creation_checkpoint = (
        f"request-{request_creation.get('lastRecordId') or request_creation.get('processedCount', 0)}"
    )
    base_sync_checkpoint_token = (
        _catalog_phase_checkpoint_from_saved_data(
            _phase_saved_data(current_sync_phase_state.get("savedData"))
        )
        or request_creation_base_checkpoint_token(request_creation)
    )
    next_request_creation_phase_state = _catalog_phase_state(
        CATALOG_REQUEST_CREATION_PHASE,
        status=request_creation_phase_status,
        owner=run_mode,
        trigger_source=trigger_source,
        checkpoint=request_creation_checkpoint,
        saved_at=saved_at,
        request_creation=request_creation,
        base_sync_checkpoint_token=base_sync_checkpoint_token,
    )
    return build_catalog_progress_payload(
        {
            CATALOG_SYNC_PHASE: current_sync_phase_state,
            CATALOG_REQUEST_CREATION_PHASE: next_request_creation_phase_state,
        }
    )


def catalog_sync_resume_message(run_mode):
    if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
        return "Continuing automated catalog sync from the saved endpoint."
    return "Continuing catalog sync from the saved endpoint."


def catalog_request_creation_start_message():
    return "Creating book requests from the synced catalog records."


def catalog_request_creation_resume_message():
    return "Resuming automated request creation from saved progress."


def catalog_request_creation_pause_request_message():
    return "Pausing automated request creation after the current batch finishes."


def catalog_request_creation_pause_message(request_creation):
    processed_count = int(request_creation.get("processedCount") or 0)
    label = "record" if processed_count == 1 else "records"
    return (
        f"Saved request creation progress after scanning {processed_count} {label}."
    )


def catalog_request_creation_progress_message(request_creation):
    processed_count = int(request_creation.get("processedCount") or 0)
    created_count = int(request_creation.get("createdCount") or 0)
    return (
        f"Scanned {processed_count} catalog "
        f"{'record' if processed_count == 1 else 'records'}; "
        f"created {created_count} "
        f"{'request' if created_count == 1 else 'requests'} so far."
    )


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
    if automation_settings.pk is None:
        automation_settings.save()
    else:
        automation_settings.save(update_fields=update_fields)
    publish_processing_ui_domains(processing_domains_for_automation(automation_settings.kind))
    return automation_settings


def get_sync_state(sync_key=PROCESSING_SYNC_KEY_CATALOG):
    state = ProcessingSyncState.objects.filter(singleton_key=sync_key).first()
    if state is None:
        state = ProcessingSyncState(
            singleton_key=sync_key,
            message="Ready to sync.",
        )
    return state


def active_sync_scope(default=PROCESSING_SYNC_KEY_CATALOG):
    incomplete_state = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    if incomplete_state.status in {
        ProcessingSyncStatus.SYNCING,
        ProcessingSyncStatus.PAUSING,
        ProcessingSyncStatus.PAUSED,
    }:
        return PROCESSING_SYNC_KEY_INCOMPLETE

    catalog_state = get_sync_state(PROCESSING_SYNC_KEY_CATALOG)
    if catalog_state.status in {
        ProcessingSyncStatus.SYNCING,
        ProcessingSyncStatus.PAUSING,
        ProcessingSyncStatus.PAUSED,
    }:
        return PROCESSING_SYNC_KEY_CATALOG

    return default


def sync_is_active_or_paused(state):
    return state.status in {
        ProcessingSyncStatus.SYNCING,
        ProcessingSyncStatus.PAUSING,
        ProcessingSyncStatus.PAUSED,
    }


def sync_owner_conflicts(state, run_mode):
    if state.status in SYNC_ACTIVE_STATUSES:
        return sync_run_mode(state) != run_mode
    if state.status != ProcessingSyncStatus.PAUSED:
        return False
    if (
        state.singleton_key == PROCESSING_SYNC_KEY_CATALOG
        and catalog_shared_runtime(sync_run_mode(state))
        and catalog_shared_runtime(run_mode)
    ):
        return False
    return sync_run_mode(state) != run_mode


def serialize_sync_state(state, *, include_remote_pages=True):
    progress = (
        sync_progress_payload(state)
        if isinstance(state.progress, dict)
        else None
    )
    payload = {
        "status": state.status,
        "progress": progress,
        "phase": sync_phase(state),
        "fetchedCount": state.fetched_count,
        "skippedCount": state.skipped_count,
        "updatedCount": state.updated_count,
        "appendedCount": state.appended_count,
        "message": state.message,
        "pageIndex": state.page_index,
        "runMode": sync_run_mode(state),
        "triggerSource": sync_trigger_source(state),
        "scope": state.singleton_key,
        "workerManaged": bool(state.task_id),
    }
    if include_remote_pages:
        payload["remotePages"] = state.remote_pages
    return payload


def serialize_automation_settings(automation_settings):
    return {
        "kind": automation_settings.kind,
        "enabled": automation_settings.enabled,
        "interval": automation_settings.interval,
        "time": automation_settings.time.strftime("%H:%M"),
        "saved": automation_settings.saved,
        "lastRunAt": (
            automation_settings.last_run_at.isoformat()
            if automation_settings.last_run_at
            else None
        ),
        "statusMessage": automation_settings.status_message,
    }


def persisted_sync_status(state):
    latest_status = (
        ProcessingSyncState.objects.filter(pk=state.pk)
        .values_list("status", flat=True)
        .first()
    )
    return latest_status or state.status

def normalize_automation_settings(automation_settings, *, persist=False):
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

    if update_fields and persist and automation_settings.pk:
        automation_settings.save(update_fields=[*update_fields, "updated_at"])

    return automation_settings


def get_automation_settings(kind):
    automation_settings = ProcessingAutomationSettings.objects.filter(kind=kind).first()
    if automation_settings is None:
        automation_settings = ProcessingAutomationSettings(
            kind=kind,
            enabled=False,
            interval=DEFAULT_AUTOMATION_INTERVAL,
            time=DEFAULT_AUTOMATION_TIME,
            saved=False,
            status_message="",
        )
    return normalize_automation_settings(automation_settings)


def processing_request_card_for_state(state):
    for card_id, states in PROCESSING_REQUEST_CARD_STATES.items():
        if state in states:
            return card_id
    return None


def processing_overview_card_for_state(state):
    if state in PROCESSING_STATE_REQUEST_GROUP:
        return PROCESSING_CARD_CREATE_OVERVIEW
    if state in PROCESSING_STATE_ON_HOLD_GROUP:
        return PROCESSING_CARD_ON_HOLD_OVERVIEW
    return None


def processing_record_is_incomplete(record_or_snapshot):
    if record_or_snapshot is None:
        return False
    if isinstance(record_or_snapshot, dict):
        category = record_or_snapshot.get("category")
        was_incomplete = bool(record_or_snapshot.get("was_incomplete"))
    else:
        category = getattr(record_or_snapshot, "category", "")
        was_incomplete = bool(getattr(record_or_snapshot, "was_incomplete", False))
    return was_incomplete or category_is_incomplete(category)


def processing_record_snapshot(record):
    if record is None:
        return None
    return {
        "id": str(record.id),
        "category": record.category,
        "was_incomplete": bool(record.was_incomplete),
        "resolved_from_incomplete": bool(record.resolved_from_incomplete),
        "book_creation_state": record.book_creation_state,
        "linked_book_id": str(record.linked_book_id) if record.linked_book_id else "",
        "is_duplicate": bool(record.is_duplicate),
        "duplicate_of_record_id": (
            str(record.duplicate_of_record_id) if record.duplicate_of_record_id else ""
        ),
    }


def processing_request_snapshot(processing_request):
    if processing_request is None:
        return None
    return {
        "id": str(processing_request.id),
        "state": processing_request.state,
        "book_record_id": str(processing_request.book_record_id),
        "linked_book_id": (
            str(processing_request.linked_book_id)
            if processing_request.linked_book_id
            else ""
        ),
        "duplicate_of_request_id": (
            str(processing_request.duplicate_of_request_id)
            if processing_request.duplicate_of_request_id
            else ""
        ),
        "duplicate_of_record_id": (
            str(processing_request.duplicate_of_record_id)
            if processing_request.duplicate_of_record_id
            else ""
        ),
        "duplicate_confirmed": bool(processing_request.duplicate_confirmed),
        "is_resumed": bool(processing_request.is_resumed),
        "is_confirmed_not_duplicate": bool(processing_request.is_confirmed_not_duplicate),
    }


def default_sync_state_payload(scope):
    return {
        "status": ProcessingSyncStatus.IDLE,
        "progress": None,
        "phase": CATALOG_SYNC_PHASE,
        "fetchedCount": 0,
        "skippedCount": 0,
        "updatedCount": 0,
        "appendedCount": 0,
        "message": "Ready to sync.",
        "pageIndex": 0,
        "runMode": SYNC_RUN_MODE_MANUAL,
        "triggerSource": SYNC_TRIGGER_SOURCE_BUTTON,
        "scope": scope,
        "workerManaged": False,
        "remotePages": [],
    }


def default_automation_payload(kind):
    return {
        "kind": kind,
        "enabled": False,
        "interval": DEFAULT_AUTOMATION_INTERVAL,
        "time": DEFAULT_AUTOMATION_TIME.strftime("%H:%M"),
        "saved": False,
        "lastRunAt": None,
        "statusMessage": "",
    }


def default_processing_summary_payload():
    return {
        "catalog": {
            "records": 0,
            "notCreated": 0,
            "active": 0,
            "created": 0,
            "onHold": 0,
        },
        "create": {
            "requests": 0,
            "queue": 0,
            "processing": 0,
            "created": 0,
        },
        "onHold": {
            "paused": 0,
            "failed": 0,
            "duplicate": 0,
            "deleted": 0,
        },
        "incomplete": {
            "incomplete": 0,
            "resolved": 0,
        },
        "notifications": {
            "activeRequests": 0,
            "createdCount": 0,
            "failedCount": 0,
            "duplicateCount": 0,
            "latestFailedMessage": "",
        },
    }


def default_processing_shared_projection_payload(key):
    summary = default_processing_summary_payload()
    shared_payloads = {
        PROCESSING_CARD_CATALOG_OVERVIEW: {
            "card": PROCESSING_CARD_CATALOG_OVERVIEW,
            "summary": summary["catalog"],
            "notifications": summary["notifications"],
        },
        PROCESSING_CARD_CATALOG_SYNC: {
            "card": PROCESSING_CARD_CATALOG_SYNC,
            "sync": default_sync_state_payload(PROCESSING_SYNC_KEY_CATALOG),
        },
        PROCESSING_CARD_CATALOG_AUTOMATION: {
            "card": PROCESSING_CARD_CATALOG_AUTOMATION,
            "sync": default_sync_state_payload(PROCESSING_SYNC_KEY_CATALOG),
            "automation": default_automation_payload(ProcessingAutomationKind.CATALOG),
        },
        PROCESSING_CARD_CREATE_OVERVIEW: {
            "card": PROCESSING_CARD_CREATE_OVERVIEW,
            "summary": summary["create"],
        },
        PROCESSING_CARD_ON_HOLD_OVERVIEW: {
            "card": PROCESSING_CARD_ON_HOLD_OVERVIEW,
            "summary": summary["onHold"],
        },
        PROCESSING_CARD_INCOMPLETE_OVERVIEW: {
            "card": PROCESSING_CARD_INCOMPLETE_OVERVIEW,
            "summary": summary["incomplete"],
        },
        PROCESSING_CARD_INCOMPLETE_AUTOMATION: {
            "card": PROCESSING_CARD_INCOMPLETE_AUTOMATION,
            "sync": default_sync_state_payload(PROCESSING_SYNC_KEY_INCOMPLETE),
            "automation": default_automation_payload(ProcessingAutomationKind.INCOMPLETE),
        },
    }
    return shared_payloads.get(key, {})


def processing_sync_payload_has_activity(payload, *, scope):
    if not isinstance(payload, dict):
        return False

    default_payload = default_sync_state_payload(scope)
    if payload.get("status") != default_payload["status"]:
        return True
    if payload.get("message") != default_payload["message"]:
        return True
    if payload.get("runMode") != default_payload["runMode"]:
        return True
    if payload.get("triggerSource") != default_payload["triggerSource"]:
        return True
    if payload.get("progress") is not None:
        return True
    for field_name in (
        "fetchedCount",
        "skippedCount",
        "updatedCount",
        "appendedCount",
        "pageIndex",
    ):
        if int(payload.get(field_name) or 0):
            return True
    return bool(payload.get("workerManaged"))


def processing_shared_projection_payloads(*, keys=None):
    requested_keys = [
        key
        for key in (keys or PROCESSING_SHARED_CARD_KEYS)
        if key in PROCESSING_SHARED_CARD_KEYS
    ]
    if not requested_keys:
        return {}

    requested_key_set = set(requested_keys)
    payloads = {}

    if requested_key_set & {
        PROCESSING_CARD_CATALOG_OVERVIEW,
        PROCESSING_CARD_CREATE_OVERVIEW,
        PROCESSING_CARD_ON_HOLD_OVERVIEW,
        PROCESSING_CARD_INCOMPLETE_OVERVIEW,
    }:
        summary = processing_summary_payload()
        if PROCESSING_CARD_CATALOG_OVERVIEW in requested_key_set:
            payloads[PROCESSING_CARD_CATALOG_OVERVIEW] = {
                "card": PROCESSING_CARD_CATALOG_OVERVIEW,
                "summary": summary["catalog"],
                "notifications": summary["notifications"],
            }
        if PROCESSING_CARD_CREATE_OVERVIEW in requested_key_set:
            payloads[PROCESSING_CARD_CREATE_OVERVIEW] = {
                "card": PROCESSING_CARD_CREATE_OVERVIEW,
                "summary": summary["create"],
            }
        if PROCESSING_CARD_ON_HOLD_OVERVIEW in requested_key_set:
            payloads[PROCESSING_CARD_ON_HOLD_OVERVIEW] = {
                "card": PROCESSING_CARD_ON_HOLD_OVERVIEW,
                "summary": summary["onHold"],
            }
        if PROCESSING_CARD_INCOMPLETE_OVERVIEW in requested_key_set:
            payloads[PROCESSING_CARD_INCOMPLETE_OVERVIEW] = {
                "card": PROCESSING_CARD_INCOMPLETE_OVERVIEW,
                "summary": summary["incomplete"],
            }

    if requested_key_set & {
        PROCESSING_CARD_CATALOG_SYNC,
        PROCESSING_CARD_CATALOG_AUTOMATION,
    }:
        catalog_sync = get_sync_state(PROCESSING_SYNC_KEY_CATALOG)
        catalog_sync_payload = (
            serialize_sync_state(catalog_sync, include_remote_pages=False)
            if catalog_sync.pk
            else default_sync_state_payload(PROCESSING_SYNC_KEY_CATALOG)
        )
        if PROCESSING_CARD_CATALOG_SYNC in requested_key_set:
            payloads[PROCESSING_CARD_CATALOG_SYNC] = {
                "card": PROCESSING_CARD_CATALOG_SYNC,
                "sync": catalog_sync_payload,
            }
        if PROCESSING_CARD_CATALOG_AUTOMATION in requested_key_set:
            catalog_automation = get_automation_settings(ProcessingAutomationKind.CATALOG)
            catalog_automation_payload = (
                serialize_automation_settings(catalog_automation)
                if catalog_automation.pk
                else default_automation_payload(ProcessingAutomationKind.CATALOG)
            )
            payloads[PROCESSING_CARD_CATALOG_AUTOMATION] = {
                "card": PROCESSING_CARD_CATALOG_AUTOMATION,
                "sync": catalog_sync_payload,
                "automation": catalog_automation_payload,
            }

    if PROCESSING_CARD_INCOMPLETE_AUTOMATION in requested_key_set:
        incomplete_sync = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
        incomplete_automation = get_automation_settings(ProcessingAutomationKind.INCOMPLETE)
        incomplete_sync_payload = (
            serialize_sync_state(incomplete_sync, include_remote_pages=False)
            if incomplete_sync.pk
            else default_sync_state_payload(PROCESSING_SYNC_KEY_INCOMPLETE)
        )
        incomplete_automation_payload = (
            serialize_automation_settings(incomplete_automation)
            if incomplete_automation.pk
            else default_automation_payload(ProcessingAutomationKind.INCOMPLETE)
        )
        payloads[PROCESSING_CARD_INCOMPLETE_AUTOMATION] = {
            "card": PROCESSING_CARD_INCOMPLETE_AUTOMATION,
            "sync": incomplete_sync_payload,
            "automation": incomplete_automation_payload,
        }

    return payloads


def ensure_processing_ui_rows():
    for domain in PROCESSING_CARD_KEYS:
        ProcessingUiDomainVersion.objects.get_or_create(
            domain=domain,
            defaults={"version": 0},
        )
    shared_payloads = processing_shared_projection_payloads(
        keys=PROCESSING_SHARED_CARD_KEYS
    )
    for key in PROCESSING_SHARED_CARD_KEYS:
        ProcessingUiProjection.objects.get_or_create(
            key=key,
            defaults={"payload": shared_payloads[key]},
        )


def rebuild_processing_ui_state(*, keys=None):
    ensure_processing_ui_rows()
    target_keys = keys or PROCESSING_SHARED_CARD_KEYS
    shared_payloads = processing_shared_projection_payloads(keys=target_keys)
    for key in target_keys:
        if key not in PROCESSING_SHARED_CARD_KEYS:
            continue
        ProcessingUiProjection.objects.update_or_create(
            key=key,
            defaults={"payload": shared_payloads[key]},
        )


def processing_ui_versions_map(domains=None):
    target_domains = PROCESSING_CARD_KEYS if domains is None else list(domains)
    versions = {domain: 0 for domain in target_domains}
    for row in ProcessingUiDomainVersion.objects.filter(domain__in=target_domains):
        versions[row.domain] = int(row.version)
    return versions


def processing_ui_versions_diff(previous_versions, *, domains=None):
    current_versions = processing_ui_versions_map(domains=domains)
    changed_versions = {
        domain: version
        for domain, version in current_versions.items()
        if int(version) > int(previous_versions.get(domain, 0))
    }
    return changed_versions, current_versions


def processing_ui_shared_projection_rows(*, keys=None):
    requested_keys = [
        key
        for key in (keys or PROCESSING_SHARED_CARD_KEYS)
        if key in PROCESSING_SHARED_CARD_KEYS
    ]
    projection_rows = {
        row.key: row
        for row in ProcessingUiProjection.objects.filter(key__in=requested_keys)
    }
    return {key: projection_rows.get(key) for key in requested_keys}


def processing_ui_shared_projection_payload(key):
    projection = processing_ui_shared_projection_rows(keys=[key]).get(key)
    if projection is not None:
        return projection.payload or {}
    return default_processing_shared_projection_payload(key)


@contextmanager
def collect_processing_ui_version_updates():
    collector = PROCESSING_UI_VERSION_COLLECTOR.get()
    if collector is not None:
        yield collector
        return

    collector = {}
    token = PROCESSING_UI_VERSION_COLLECTOR.set(collector)
    try:
        yield collector
    finally:
        PROCESSING_UI_VERSION_COLLECTOR.reset(token)


def _merge_processing_ui_versions(collector, versions):
    if collector is None:
        return collector
    for domain, version in (versions or {}).items():
        normalized_version = int(version or 0)
        if normalized_version <= int(collector.get(domain, 0)):
            continue
        collector[domain] = normalized_version
    return collector


def _plan_processing_ui_versions(collector, domains):
    if collector is None or not domains:
        return collector

    current_versions = processing_ui_versions_map(domains=domains)
    for domain in domains:
        collector[domain] = max(
            int(current_versions.get(domain, 0)),
            int(collector.get(domain, 0)),
        ) + 1
    return collector


def _bump_processing_ui_domains(domains):
    next_versions = {}
    for domain in domains:
        version_row, _ = ProcessingUiDomainVersion.objects.select_for_update().get_or_create(
            domain=domain,
            defaults={"version": 0},
        )
        version_row.version = int(version_row.version) + 1
        version_row.save(update_fields=["version", "updated_at"])
        next_versions[domain] = int(version_row.version)
    return next_versions


def processing_shared_projection_keys_for_domains(domains):
    projection_keys = set()
    for domain in domains or []:
        projection_keys.update(
            PROCESSING_SHARED_PROJECTION_DEPENDENCIES.get(domain, set())
        )
    return sorted(projection_keys)


def publish_processing_ui_domains(domains):
    normalized_domains = [
        domain for domain in dict.fromkeys(domains or []) if domain in PROCESSING_CARD_KEYS
    ]
    if not normalized_domains:
        return

    projection_keys = processing_shared_projection_keys_for_domains(normalized_domains)
    collector = PROCESSING_UI_VERSION_COLLECTOR.get()
    _plan_processing_ui_versions(collector, normalized_domains)

    def commit():
        if projection_keys:
            rebuild_processing_ui_state(keys=projection_keys)
        with transaction.atomic():
            next_versions = _bump_processing_ui_domains(normalized_domains)
        _merge_processing_ui_versions(collector, next_versions)

    transaction.on_commit(commit)


def processing_domains_for_request_change(
    before_state,
    after_state,
    *,
    record=None,
):
    domains = {
        PROCESSING_CARD_CATALOG_OVERVIEW,
        PROCESSING_CARD_CATALOG_RECORDS,
    }

    before_card = processing_request_card_for_state(before_state)
    after_card = processing_request_card_for_state(after_state)
    if before_card:
        domains.add(before_card)
    if after_card:
        domains.add(after_card)

    before_overview = processing_overview_card_for_state(before_state)
    after_overview = processing_overview_card_for_state(after_state)
    if before_overview:
        domains.add(before_overview)
    if after_overview:
        domains.add(after_overview)

    if record is not None:
        if processing_record_is_incomplete(record):
            domains.update(
                {
                    PROCESSING_CARD_INCOMPLETE_OVERVIEW,
                    PROCESSING_CARD_INCOMPLETE_RECORDS,
                }
            )
        if record.was_incomplete and record.resolved_from_incomplete:
            domains.update(
                {
                    PROCESSING_CARD_INCOMPLETE_OVERVIEW,
                    PROCESSING_CARD_INCOMPLETE_COMPLETED,
                }
            )

    return domains


def processing_domains_for_record_change(
    before_snapshot,
    after_snapshot,
    *,
    current_request_state=None,
):
    domains = {
        PROCESSING_CARD_CATALOG_OVERVIEW,
        PROCESSING_CARD_CATALOG_RECORDS,
    }
    if current_request_state:
        current_card = processing_request_card_for_state(current_request_state)
        if current_card:
            domains.add(current_card)

    if processing_record_is_incomplete(before_snapshot) or processing_record_is_incomplete(
        after_snapshot
    ):
        domains.update(
            {
                PROCESSING_CARD_INCOMPLETE_OVERVIEW,
                PROCESSING_CARD_INCOMPLETE_RECORDS,
            }
        )

    after_resolved = bool(after_snapshot and after_snapshot.get("resolved_from_incomplete"))
    before_resolved = bool(
        before_snapshot and before_snapshot.get("resolved_from_incomplete")
    )
    if after_resolved or before_resolved:
        domains.update(
            {
                PROCESSING_CARD_INCOMPLETE_OVERVIEW,
                PROCESSING_CARD_INCOMPLETE_COMPLETED,
            }
        )

    return domains


def processing_domains_for_sync_state(state):
    sync_key = (
        state.singleton_key
        if isinstance(state, ProcessingSyncState)
        else str(state or "").strip().lower()
    )
    if sync_key == PROCESSING_SYNC_KEY_INCOMPLETE:
        return {PROCESSING_CARD_INCOMPLETE_AUTOMATION}
    return {PROCESSING_CARD_CATALOG_SYNC}


def processing_domains_for_automation(kind):
    if kind == ProcessingAutomationKind.INCOMPLETE:
        return {PROCESSING_CARD_INCOMPLETE_AUTOMATION}
    return {PROCESSING_CARD_CATALOG_AUTOMATION}


def processing_state_payload(*, include_lists=True):
    projection_rows = processing_ui_shared_projection_rows(keys=PROCESSING_SHARED_CARD_KEYS)
    versions = processing_ui_versions_map()
    shared_cards = {
        key: (
            (projection_rows.get(key).payload or {})
            if projection_rows.get(key) is not None
            else default_processing_shared_projection_payload(key)
        )
        for key in PROCESSING_SHARED_CARD_KEYS
    }
    summary = {
        "catalog": shared_cards[PROCESSING_CARD_CATALOG_OVERVIEW].get("summary", {}),
        "notifications": shared_cards[PROCESSING_CARD_CATALOG_OVERVIEW].get(
            "notifications",
            {},
        ),
        "create": shared_cards[PROCESSING_CARD_CREATE_OVERVIEW].get("summary", {}),
        "onHold": shared_cards[PROCESSING_CARD_ON_HOLD_OVERVIEW].get("summary", {}),
        "incomplete": shared_cards[PROCESSING_CARD_INCOMPLETE_OVERVIEW].get(
            "summary",
            {},
        ),
    }
    automation = {
        "catalog": shared_cards[PROCESSING_CARD_CATALOG_AUTOMATION].get(
            "automation",
            default_automation_payload(ProcessingAutomationKind.CATALOG),
        ),
        "incomplete": shared_cards[PROCESSING_CARD_INCOMPLETE_AUTOMATION].get(
            "automation",
            default_automation_payload(ProcessingAutomationKind.INCOMPLETE),
        ),
    }
    sync_states = {
        "catalog": shared_cards[PROCESSING_CARD_CATALOG_SYNC].get(
            "sync",
            default_sync_state_payload(PROCESSING_SYNC_KEY_CATALOG),
        ),
        "incomplete": shared_cards[PROCESSING_CARD_INCOMPLETE_AUTOMATION].get(
            "sync",
            default_sync_state_payload(PROCESSING_SYNC_KEY_INCOMPLETE),
        ),
    }

    catalog_sync_updated_at = getattr(
        projection_rows.get(PROCESSING_CARD_CATALOG_SYNC),
        "updated_at",
        None,
    )
    incomplete_sync_updated_at = getattr(
        projection_rows.get(PROCESSING_CARD_INCOMPLETE_AUTOMATION),
        "updated_at",
        None,
    )
    catalog_sync_version = int(versions.get(PROCESSING_CARD_CATALOG_SYNC, 0))
    incomplete_sync_version = int(
        versions.get(PROCESSING_CARD_INCOMPLETE_AUTOMATION, 0)
    )
    catalog_sync_has_activity = processing_sync_payload_has_activity(
        sync_states["catalog"],
        scope=PROCESSING_SYNC_KEY_CATALOG,
    )
    incomplete_sync_has_activity = processing_sync_payload_has_activity(
        sync_states["incomplete"],
        scope=PROCESSING_SYNC_KEY_INCOMPLETE,
    )
    if sync_is_active_or_paused(SimpleNamespace(**sync_states["incomplete"])):
        primary_sync_payload = sync_states["incomplete"]
    elif sync_is_active_or_paused(SimpleNamespace(**sync_states["catalog"])):
        primary_sync_payload = sync_states["catalog"]
    elif incomplete_sync_has_activity and not catalog_sync_has_activity:
        primary_sync_payload = sync_states["incomplete"]
    elif catalog_sync_has_activity and not incomplete_sync_has_activity:
        primary_sync_payload = sync_states["catalog"]
    elif incomplete_sync_version > catalog_sync_version:
        primary_sync_payload = sync_states["incomplete"]
    elif catalog_sync_version > incomplete_sync_version:
        primary_sync_payload = sync_states["catalog"]
    else:
        if incomplete_sync_updated_at and (
            not catalog_sync_updated_at
            or incomplete_sync_updated_at >= catalog_sync_updated_at
        ):
            primary_sync_payload = sync_states["incomplete"]
        else:
            primary_sync_payload = sync_states["catalog"]
    payload = {
        "summary": summary,
        "sync": primary_sync_payload,
        "syncStates": sync_states,
        "orchestration": {
            "manualPipelineAdvance": False,
        },
        "automation": automation,
        "cards": shared_cards,
        "versions": versions,
    }
    if include_lists:
        payload["records"] = serialized_processing_records()
        payload["requests"] = serialized_processing_requests()
    return payload


def serialized_processing_records():
    from .serializers import BookRecordSerializer

    return BookRecordSerializer(
        BookRecord.objects.select_related("linked_book")
        .prefetch_related("creation_requests")
        .order_by("name", "id"),
        many=True,
    ).data


def serialized_processing_requests():
    from .serializers import BookCreationRequestSerializer

    return BookCreationRequestSerializer(
        BookCreationRequest.objects.select_related(
            "book_record",
            "linked_book",
            "book_record__linked_book",
        ).order_by(
            "-updated_at",
            "-created_at",
        ),
        many=True,
    ).data

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
    published_domains = set()

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
        before_snapshot = processing_record_snapshot(record)
        if record is None:
            preferred_id = data["id"] or None
            create_kwargs = dict(defaults)
            if preferred_id and not BookRecord.objects.filter(pk=preferred_id).exists():
                create_kwargs["id"] = preferred_id
            try:
                record = BookRecord.objects.create(**create_kwargs)
                sync_record_state(record)
                published_domains.update(
                    processing_domains_for_record_change(
                        None,
                        processing_record_snapshot(record),
                    )
                )
                appended_count += 1
                continue
            except IntegrityError:
                record = (
                    BookRecord.objects.select_related("linked_book")
                    .filter(Q(pk=data["id"]) | Q(url=data["url"]))
                    .order_by("id")
                    .first()
                )
                if record is None:
                    raise

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
        after_snapshot = processing_record_snapshot(record)
        if before_snapshot != after_snapshot:
            published_domains.update(
                processing_domains_for_record_change(
                    before_snapshot,
                    after_snapshot,
                )
            )

    if published_domains:
        publish_processing_ui_domains(published_domains)
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


def should_use_live_catalog_fetch(remote_pages, run_mode):
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
    save_sync_state(
        sync_state,
        update_fields=["task_id", "queue_name", "last_error", "updated_at"],
    )

    try:
        async_result = run_processing_sync_task.apply_async(
            args=[sync_state.singleton_key],
            task_id=assigned_task_id,
            queue=PROCESSING_TASK_QUEUE,
        )
        dispatched_task_id = getattr(async_result, "id", assigned_task_id) or assigned_task_id
        if dispatched_task_id != assigned_task_id:
            sync_state.task_id = dispatched_task_id
            save_sync_state(sync_state, update_fields=["task_id", "updated_at"])
    except Exception as exc:
        logger.warning("Processing sync task dispatch failed.", exc_info=True)
        sync_state.task_id = ""
        sync_state.queue_name = "inline-fallback"
        sync_state.last_error = str(exc)
        save_sync_state(
            sync_state,
            update_fields=["task_id", "queue_name", "last_error", "updated_at"],
        )
        run_processing_sync_until_blocked(
            singleton_key=sync_state.singleton_key,
            task_id="",
        )
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


def incomplete_catalog_page_url(page_number):
    if page_number <= 1:
        return INCOMPLETE_CATALOG_URL
    return urljoin(INCOMPLETE_CATALOG_URL, f"page/{page_number}/")


def parse_incomplete_catalog_page(soup):
    entries = []
    seen_urls = set()
    anchors = soup.select(".entry-title a[href], article h2 a[href], article h3 a[href]")

    for anchor in anchors:
        href = urljoin(INCOMPLETE_CATALOG_URL, anchor.get("href", ""))
        try:
            normalized_url = normalize_source_url(href)
        except ValueError:
            continue
        if normalized_url in seen_urls:
            continue

        display_title = anchor.get_text(" ", strip=True)
        if not display_title:
            continue

        seen_urls.add(normalized_url)
        title, author_line = split_display_title(display_title)
        entries.append(
            metadata_entry_defaults(
                source_url=normalized_url,
                title=title or display_title,
                author_line=author_line,
                raw_data={
                    "title": title or display_title,
                    "display_title": display_title,
                    "author_line": author_line,
                    "incompleteCategoryUrl": INCOMPLETE_CATALOG_URL,
                    "metadata_source": "incomplete_archive_page",
                },
            )
        )

    return entries


def incomplete_resolution_category(raw_data, fallback=""):
    raw_data = raw_data if isinstance(raw_data, dict) else {}
    for key in (
        "willResolveToCategory",
        "will_resolve_to_category",
        "resolvedCategory",
        "resolved_category",
        "metadataSourceCategory",
        "category",
        "book_type",
    ):
        value = str(raw_data.get(key) or "").strip()
        if value and not category_is_incomplete(value):
            return value
    return str(fallback or "").strip()


def incomplete_remote_payload(stored_entry):
    raw_data = stored_entry.raw_data if isinstance(stored_entry.raw_data, dict) else {}
    return {
        "id": str(stored_entry.id),
        "name": stored_entry.title,
        "url": stored_entry.source_url,
        "category": "অসম্পূর্ণ বই",
        "writer": stored_entry.author_line,
        "translator": raw_data.get("translator") or "",
        "composer": raw_data.get("composer") or "",
        "publisher": raw_data.get("publisher") or "",
        "updatedAt": stored_entry.updated_at.isoformat(),
        "wasIncomplete": True,
        "resolvedFromIncomplete": False,
        "willResolveToCategory": incomplete_resolution_category(raw_data),
    }


def fetch_live_incomplete_page(resolver, page_number):
    response = get_with_host_fallback(
        resolver.session,
        incomplete_catalog_page_url(page_number),
        timeout=30,
    )
    try:
        response.raise_for_status()
    except Exception as exc:
        if (
            page_number > 1
            and getattr(getattr(exc, "response", None), "status_code", None) == 404
        ):
            logger.info(
                "Incomplete catalog page %s returned 404; treating it as the end of the archive.",
                incomplete_catalog_page_url(page_number),
            )
            return []
        raise
    entries = parse_incomplete_catalog_page(BeautifulSoup(response.text, "html.parser"))

    normalized_entries = []
    seen_urls = set()
    for entry in entries:
        source_url = entry.get("source_url")
        if not source_url:
            continue

        enriched_entry = dict(entry)
        try:
            metadata = fetch_source_page_metadata(source_url, session=resolver.session)
            resolution_category = incomplete_resolution_category(metadata.get("raw_data"))
            enriched_entry = {
                **metadata,
                "raw_data": {
                    **(metadata.get("raw_data") or {}),
                    "category": "অসম্পূর্ণ বই",
                    "willResolveToCategory": resolution_category,
                    "metadataSourceCategory": resolution_category,
                    "incompleteCategoryUrl": INCOMPLETE_CATALOG_URL,
                    "metadata_source": "incomplete_archive_page",
                },
            }
        except Exception:
            logger.warning(
                "Incomplete metadata enrichment failed for %s; using archive listing metadata.",
                source_url,
                exc_info=True,
            )
            enriched_entry = {
                **entry,
                "raw_data": {
                    **(entry.get("raw_data") or {}),
                    "category": "অসম্পূর্ণ বই",
                    "willResolveToCategory": "",
                    "incompleteCategoryUrl": INCOMPLETE_CATALOG_URL,
                    "metadata_source": "incomplete_archive_page",
                },
            }

        stored_entry = upsert_source_catalog_entry(enriched_entry)
        payload = incomplete_remote_payload(stored_entry)
        if payload["url"] in seen_urls:
            continue
        seen_urls.add(payload["url"])
        normalized_entries.append(payload)

    return normalized_entries


def fetch_live_incomplete_remote_pages(page_size=100, max_pages=250):
    resolver = TitleResolver(session=create_session_with_retries())
    pages = []
    current_page = []
    seen_urls = set()
    page_signatures = set()

    for page_number in range(1, max_pages + 1):
        page_items = fetch_live_incomplete_page(resolver, page_number)
        if not page_items:
            break

        signature = tuple(item["url"] for item in page_items[:5])
        if signature in page_signatures:
            break
        page_signatures.add(signature)

        deduped_page_items = []
        for item in page_items:
            source_url = item.get("url")
            if not source_url or source_url in seen_urls:
                continue
            seen_urls.add(source_url)
            deduped_page_items.append(item)

        for item in deduped_page_items:
            current_page.append(item)
            if len(current_page) >= page_size:
                pages.append(current_page)
                current_page = []

    if current_page:
        pages.append(current_page)
    pages.append([])
    return pages


def start_sync(
    remote_pages=None,
    *,
    run_mode=SYNC_RUN_MODE_MANUAL,
    sync_key=None,
    trigger_source=SYNC_TRIGGER_SOURCE_BUTTON,
):
    sync_key = sync_key or sync_key_for_run_mode(run_mode)
    live_fetch = False
    session_id = ""
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        live_fetch = remote_pages is None and should_use_live_incomplete_fetch()
        if remote_pages is None:
            remote_pages = [] if live_fetch else incomplete_sync_remote_pages()
        elif not isinstance(remote_pages, list):
            remote_pages = [] if live_fetch else incomplete_sync_remote_pages()
    else:
        remote_pages = catalog_remote_pages(remote_pages)
        live_fetch = should_use_live_catalog_fetch(remote_pages, run_mode)
        if not live_fetch and not remote_pages and SourceCatalogEntry.objects.exists():
            remote_pages = source_catalog_remote_pages()
        session_id = str(uuid4())

    state = get_sync_state(sync_key)
    preserved_request_creation_phase_state = None
    if sync_key == PROCESSING_SYNC_KEY_CATALOG:
        current_request_creation_phase_state = catalog_phase_state(
            state,
            CATALOG_REQUEST_CREATION_PHASE,
        )
        if (
            current_request_creation_phase_state.get("status")
            == CATALOG_PHASE_STATUS_PAUSED
        ):
            preserved_request_creation_phase_state = current_request_creation_phase_state
    state.remote_pages = remote_pages
    state.status = ProcessingSyncStatus.SYNCING
    if sync_key == PROCESSING_SYNC_KEY_CATALOG:
        state.progress = build_catalog_sync_progress(
            state,
            run_mode,
            live_fetch=live_fetch,
            trigger_source=trigger_source,
            session_id=session_id,
            request_creation_phase_state=preserved_request_creation_phase_state,
        )
    else:
        state.progress = build_sync_progress(
            run_mode,
            live_fetch=live_fetch,
            trigger_source=trigger_source,
            session_id=session_id,
        )
    state.page_index = 0
    state.fetched_count = 0
    state.skipped_count = 0
    state.updated_count = 0
    state.appended_count = 0
    state.message = sync_start_message(run_mode)
    state.task_id = ""
    state.queue_name = ""
    state.last_error = ""
    save_sync_state(state)
    update_automation_run_status(run_mode, state.message)
    if should_enqueue_processing_work():
        dispatch_sync_task(state, force=True)
    elif should_run_processing_jobs_inline():
        run_processing_sync_until_blocked(singleton_key=state.singleton_key, task_id="")
    return state


def pause_sync(sync_key=None):
    sync_key = sync_key or active_sync_scope()
    state = get_sync_state(sync_key)
    if state.status == ProcessingSyncStatus.SYNCING:
        run_mode = sync_run_mode(state)
        state.status = ProcessingSyncStatus.PAUSING
        if (
            state.singleton_key == PROCESSING_SYNC_KEY_CATALOG
            and sync_phase(state) == CATALOG_REQUEST_CREATION_PHASE
        ):
            state.progress = build_catalog_request_creation_progress(
                state,
                request_creation=(
                    catalog_request_creation_progress(state)
                    or initial_catalog_request_creation_progress(state)
                ),
                run_mode=run_mode,
                trigger_source=sync_trigger_source(state),
                request_creation_phase_status=CATALOG_PHASE_STATUS_PAUSING,
                sync_phase_state=catalog_phase_state(state, CATALOG_SYNC_PHASE),
            )
            state.message = catalog_request_creation_pause_request_message()
        else:
            state.progress = build_catalog_sync_progress(
                state,
                run_mode,
                next_page_index=state.page_index,
                fetched_count=state.fetched_count,
                live_fetch=sync_uses_live_fetch(state),
                trigger_source=sync_trigger_source(state),
                session_id=sync_saved_data(state).get("sessionId") or "",
                sync_phase_status=CATALOG_PHASE_STATUS_PAUSING,
                request_creation_phase_state=catalog_phase_state(
                    state,
                    CATALOG_REQUEST_CREATION_PHASE,
                ),
            )
            state.message = sync_pause_message(run_mode)
        save_sync_state(
            state,
            update_fields=["status", "progress", "message", "updated_at"],
        )
        update_automation_run_status(run_mode, state.message)
    return state


def resume_sync(sync_key=PROCESSING_SYNC_KEY_CATALOG, *, run_mode=None):
    state = get_sync_state(sync_key)
    run_mode = run_mode or sync_run_mode(state)
    live_fetch = sync_uses_live_fetch(state)
    trigger_source = sync_trigger_source(state)
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        state.remote_pages = [] if live_fetch else incomplete_sync_remote_pages()
        next_page_index = 0
        fetched_count = int(state.fetched_count or 0)
        resume_message = "Restarting incomplete catalog sync from the beginning."
    elif sync_key == PROCESSING_SYNC_KEY_CATALOG:
        sync_phase_state = catalog_phase_state(state, CATALOG_SYNC_PHASE)
        request_creation_phase_state = catalog_phase_state(
            state,
            CATALOG_REQUEST_CREATION_PHASE,
        )
        saved_data = _phase_saved_data(sync_phase_state.get("savedData"))
        request_creation = _phase_request_creation(
            request_creation_phase_state.get("requestCreation")
        )
        sync_can_resume = (
            state.status == ProcessingSyncStatus.PAUSED
            and catalog_sync_phase_status(state) == CATALOG_PHASE_STATUS_PAUSED
        )
        next_page_index = int(
            saved_data.get("nextPageIndex", state.page_index or 0) or 0
        )
        fetched_count = int(saved_data.get("fetchedCount", state.fetched_count or 0) or 0)
        if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION and catalog_request_creation_can_resume(
            state
        ):
            state.status = ProcessingSyncStatus.SYNCING
            state.page_index = next_page_index
            state.fetched_count = fetched_count
            state.progress = build_catalog_request_creation_progress(
                state,
                request_creation=request_creation,
                run_mode=run_mode,
                trigger_source=trigger_source,
                request_creation_phase_status=CATALOG_PHASE_STATUS_RUNNING,
                sync_phase_state=sync_phase_state,
            )
            state.task_id = ""
            state.queue_name = ""
            state.message = catalog_request_creation_resume_message()
            save_sync_state(
                state,
                update_fields=[
                    "status",
                    "progress",
                    "page_index",
                    "fetched_count",
                    "task_id",
                    "queue_name",
                    "message",
                    "updated_at",
                ],
            )
            update_automation_run_status(run_mode, state.message)
            if should_enqueue_processing_work():
                dispatch_sync_task(state, force=True)
            elif should_run_processing_jobs_inline():
                run_processing_sync_until_blocked(
                    singleton_key=state.singleton_key,
                    task_id="",
                )
            return state
        if sync_can_resume:
            resume_message = catalog_sync_resume_message(run_mode)
        else:
            next_page_index = 0
            fetched_count = 0
            resume_message = (
                "Restarting automated catalog sync from the beginning."
                if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION
                else "Restarting catalog sync from the beginning."
            )
            saved_data = {}
            request_creation_phase_state = (
                request_creation_phase_state
                if request_creation_phase_state.get("status") == CATALOG_PHASE_STATUS_PAUSED
                else None
            )
    else:
        next_page_index = 0
        fetched_count = int(state.fetched_count or 0)
        resume_message = (
            "Restarting automated catalog sync from the beginning."
            if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION
            else "Reconciling saved records from the beginning."
        )
    state.status = ProcessingSyncStatus.SYNCING
    if sync_key == PROCESSING_SYNC_KEY_CATALOG:
        state.progress = build_catalog_sync_progress(
            state,
            run_mode,
            next_page_index=next_page_index,
            fetched_count=fetched_count,
            live_fetch=live_fetch,
            trigger_source=trigger_source,
            session_id=saved_data.get("sessionId") or str(uuid4()),
            sync_phase_status=CATALOG_PHASE_STATUS_RUNNING,
            request_creation_phase_state=request_creation_phase_state,
        )
    else:
        state.progress = build_sync_progress(
            run_mode,
            next_page_index=next_page_index,
            fetched_count=fetched_count,
            live_fetch=live_fetch,
            trigger_source=trigger_source,
            session_id="",
        )
    state.page_index = next_page_index
    state.fetched_count = fetched_count
    if next_page_index == 0 and fetched_count == 0 and sync_key == PROCESSING_SYNC_KEY_CATALOG:
        state.skipped_count = 0
        state.updated_count = 0
        state.appended_count = 0
    state.task_id = ""
    state.queue_name = ""
    state.message = resume_message
    save_sync_state(
        state,
        update_fields=[
            "remote_pages",
            "status",
            "progress",
            "page_index",
            "fetched_count",
            "skipped_count",
            "updated_count",
            "appended_count",
            "task_id",
            "queue_name",
            "message",
            "updated_at",
        ]
    )
    update_automation_run_status(run_mode, state.message)
    if should_enqueue_processing_work():
        dispatch_sync_task(state, force=True)
    elif should_run_processing_jobs_inline():
        run_processing_sync_until_blocked(singleton_key=state.singleton_key, task_id="")
    return state


def stop_sync(sync_key=None):
    sync_key = sync_key or active_sync_scope()
    state = get_sync_state(sync_key)
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
    save_sync_state(
        state,
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


def finalize_sync(state, *, message=None, progress=None):
    state.status = ProcessingSyncStatus.IDLE
    state.progress = progress
    state.task_id = ""
    state.queue_name = ""
    state.message = message or (
        f"Sync complete. Updated {state.updated_count}, "
        f"Skipped {state.skipped_count}, Added {state.appended_count}."
    )
    save_sync_state(
        state,
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
    save_sync_state(
        state,
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


def catalog_progress_after_completion(
    state,
    *,
    run_mode,
    request_creation_phase_status=CATALOG_PHASE_STATUS_NOT_STARTED,
):
    current_sync_phase_state = catalog_phase_state(state, CATALOG_SYNC_PHASE)
    current_request_creation_phase_state = catalog_phase_state(
        state,
        CATALOG_REQUEST_CREATION_PHASE,
    )
    sync_saved_data = {
        **_phase_saved_data(current_sync_phase_state.get("savedData")),
        "runMode": run_mode,
        "triggerSource": sync_trigger_source(state),
    }
    sync_phase_state = replace_catalog_phase_state(
        CATALOG_SYNC_PHASE,
        current_sync_phase_state,
        status=CATALOG_PHASE_STATUS_COMPLETED,
        owner=run_mode,
        trigger_source=sync_trigger_source(state),
        checkpoint=(
            current_sync_phase_state.get("checkpoint")
            or f"page-{sync_saved_data.get('nextPageIndex') or state.page_index or 0}"
        ),
        saved_data=sync_saved_data,
        saved_at="",
    )
    if request_creation_phase_status == CATALOG_PHASE_STATUS_COMPLETED:
        request_creation_phase_state = _catalog_phase_state(
            CATALOG_REQUEST_CREATION_PHASE,
            status=CATALOG_PHASE_STATUS_COMPLETED,
            owner=SYNC_RUN_MODE_CATALOG_AUTOMATION,
            trigger_source=(
                current_request_creation_phase_state.get("triggerSource")
                or sync_trigger_source(state)
            ),
            base_sync_checkpoint_token=(
                current_request_creation_phase_state.get("baseSyncCheckpointToken")
                or _catalog_phase_checkpoint_from_saved_data(sync_saved_data)
            ),
        )
    elif current_request_creation_phase_state.get("status") == CATALOG_PHASE_STATUS_PAUSED:
        request_creation_phase_state = replace_catalog_phase_state(
            CATALOG_REQUEST_CREATION_PHASE,
            current_request_creation_phase_state,
        )
    else:
        request_creation_phase_state = _catalog_phase_state(
            CATALOG_REQUEST_CREATION_PHASE,
            status=CATALOG_PHASE_STATUS_NOT_STARTED,
        )
    return build_catalog_progress_payload(
        {
            CATALOG_SYNC_PHASE: sync_phase_state,
            CATALOG_REQUEST_CREATION_PHASE: request_creation_phase_state,
        }
    )


def finalize_catalog_sync(state, *, run_mode):
    progress = catalog_progress_after_completion(
        state,
        run_mode=run_mode,
    )
    phase_states = _normalized_catalog_phase_states(progress, ProcessingSyncStatus.IDLE)
    return persist_catalog_phase_states(
        state,
        phase_states,
        message=(
            f"Sync complete. Updated {state.updated_count}, "
            f"Skipped {state.skipped_count}, Added {state.appended_count}."
        ),
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
        ],
    )


def catalog_request_creation_queryset(*, after_record_id=""):
    queryset = BookRecord.objects.order_by("id")
    if after_record_id:
        queryset = queryset.filter(id__gt=after_record_id)
    return queryset


def begin_catalog_request_creation(state):
    current_sync_phase_state = catalog_phase_state(state, CATALOG_SYNC_PHASE)
    sync_owner = (
        current_sync_phase_state.get("owner")
        or sync_run_mode(state)
        or SYNC_RUN_MODE_CATALOG_AUTOMATION
    )
    sync_phase_trigger_source = (
        current_sync_phase_state.get("triggerSource")
        or sync_trigger_source(state)
    )
    current_sync_saved_data = (
        _phase_saved_data(current_sync_phase_state.get("savedData"))
        or sync_saved_data(state)
    )
    session_id = current_sync_saved_data.get("sessionId") or str(uuid4())
    sync_saved_data_payload = {
        **current_sync_saved_data,
        "runMode": sync_owner,
        "triggerSource": sync_phase_trigger_source,
        "fetchedCount": state.fetched_count,
        "nextPageIndex": state.page_index,
        "sessionId": session_id,
        "checkpointToken": catalog_sync_checkpoint_token(
            session_id,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            live_fetch=sync_uses_live_fetch(state),
        ),
    }
    if sync_uses_live_fetch(state):
        sync_saved_data_payload["liveFetch"] = True
    else:
        sync_saved_data_payload.pop("liveFetch", None)
    sync_phase_state = replace_catalog_phase_state(
        CATALOG_SYNC_PHASE,
        current_sync_phase_state,
        status=CATALOG_PHASE_STATUS_COMPLETED,
        owner=sync_owner,
        trigger_source=sync_phase_trigger_source,
        checkpoint=(
            current_sync_phase_state.get("checkpoint")
            or f"page-{state.page_index}"
        ),
        saved_at="",
        saved_data=sync_saved_data_payload,
    )
    request_creation = {
        "baseCheckpointToken": _catalog_phase_checkpoint_from_saved_data(
            _phase_saved_data(sync_phase_state.get("savedData"))
        ),
        "lastRecordId": "",
        "processedCount": 0,
        "createdCount": 0,
        "unsupportedCount": 0,
    }
    state.status = ProcessingSyncStatus.SYNCING
    state.progress = build_catalog_request_creation_progress(
        state,
        request_creation=request_creation,
        trigger_source=sync_trigger_source(state),
        request_creation_phase_status=CATALOG_PHASE_STATUS_RUNNING,
        sync_phase_state=sync_phase_state,
    )
    state.message = catalog_request_creation_start_message()
    save_sync_state(state)
    update_automation_run_status(SYNC_RUN_MODE_CATALOG_AUTOMATION, state.message)
    return state


def complete_catalog_automation(state, *, request_creation):
    created_count = int(request_creation.get("createdCount") or 0)
    unsupported_count = int(request_creation.get("unsupportedCount") or 0)
    finished_at = timezone.now()
    status_message = (
        f"Created {created_count} {'request' if created_count == 1 else 'requests'}."
    )
    if unsupported_count:
        status_message = (
            f"{status_message} Skipped {unsupported_count} unsupported "
            f"{'record' if unsupported_count == 1 else 'records'}."
        )
    update_automation_run_status(
        SYNC_RUN_MODE_CATALOG_AUTOMATION,
        status_message,
        last_run_at=finished_at,
    )
    current_sync_phase_state = catalog_phase_state(state, CATALOG_SYNC_PHASE)
    current_request_creation_phase_state = catalog_phase_state(
        state,
        CATALOG_REQUEST_CREATION_PHASE,
    )
    if current_sync_phase_state.get("status") == CATALOG_PHASE_STATUS_PAUSED:
        sync_phase_state = replace_catalog_phase_state(
            CATALOG_SYNC_PHASE,
            current_sync_phase_state,
        )
    else:
        sync_phase_state = replace_catalog_phase_state(
            CATALOG_SYNC_PHASE,
            current_sync_phase_state,
            status=CATALOG_PHASE_STATUS_COMPLETED,
            owner=(
                current_sync_phase_state.get("owner")
                or SYNC_RUN_MODE_CATALOG_AUTOMATION
            ),
            trigger_source=(
                current_sync_phase_state.get("triggerSource")
                or sync_trigger_source(state)
            ),
            saved_data={
                **_phase_saved_data(current_sync_phase_state.get("savedData")),
                "runMode": (
                    current_sync_phase_state.get("owner")
                    or SYNC_RUN_MODE_CATALOG_AUTOMATION
                ),
                "triggerSource": (
                    current_sync_phase_state.get("triggerSource")
                    or sync_trigger_source(state)
                ),
            },
            saved_at="",
        )
    request_creation_phase_state = _catalog_phase_state(
        CATALOG_REQUEST_CREATION_PHASE,
        status=CATALOG_PHASE_STATUS_COMPLETED,
        owner=SYNC_RUN_MODE_CATALOG_AUTOMATION,
        trigger_source=(
            current_request_creation_phase_state.get("triggerSource")
            or sync_trigger_source(state)
        ),
        base_sync_checkpoint_token=(
            current_request_creation_phase_state.get("baseSyncCheckpointToken")
            or request_creation_base_checkpoint_token(request_creation)
        ),
    )
    phase_states = {
        CATALOG_SYNC_PHASE: sync_phase_state,
        CATALOG_REQUEST_CREATION_PHASE: request_creation_phase_state,
    }
    return persist_catalog_phase_states(
        state,
        phase_states,
        message=(
            f"Automated catalog sync complete. Updated {state.updated_count}, "
            f"Skipped {state.skipped_count}, Added {state.appended_count}."
        ),
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
        ],
    )


def advance_catalog_request_creation_once(state):
    request_creation_phase_state = catalog_phase_state(
        state,
        CATALOG_REQUEST_CREATION_PHASE,
    )
    request_creation = catalog_request_creation_progress(state)
    request_creation_base_token = (
        str(request_creation_phase_state.get("baseSyncCheckpointToken") or "").strip()
        or request_creation_base_checkpoint_token(request_creation)
        or current_catalog_sync_checkpoint_token(state)
    )
    if not request_creation_matches_checkpoint(request_creation, request_creation_base_token):
        request_creation = {
            "baseCheckpointToken": request_creation_base_token,
            "lastRecordId": "",
            "processedCount": 0,
            "createdCount": 0,
            "unsupportedCount": 0,
        }
    batch = list(
        catalog_request_creation_queryset(
            after_record_id=str(request_creation.get("lastRecordId") or "").strip()
        )[:CATALOG_REQUEST_CREATION_BATCH_SIZE]
    )
    if not batch:
        return complete_catalog_automation(state, request_creation=request_creation)

    created_count = int(request_creation.get("createdCount") or 0)
    processed_count = int(request_creation.get("processedCount") or 0)
    unsupported_count = int(request_creation.get("unsupportedCount") or 0)
    last_record_id = str(request_creation.get("lastRecordId") or "").strip()
    for record in batch:
        last_record_id = str(record.id)
        processed_count += 1
        if not can_process_record_url(record.url):
            unsupported_count += 1
            logger.warning(
                "Skipping automation request creation for record %s because its URL is unsupported: %s",
                record.id,
                record.url,
            )
            continue
        latest_request = latest_request_for_record(record)
        if latest_request is None and record.book_creation_state == BookCreationState.NOT_CREATED:
            processing_request = create_request_for_record(
                record,
                origin=SubmissionOrigin.AUTOMATION,
            )
            if processing_request is not None:
                created_count += 1

    next_request_creation = {
        "baseCheckpointToken": request_creation_base_token,
        "lastRecordId": last_record_id,
        "processedCount": processed_count,
        "createdCount": created_count,
        "unsupportedCount": unsupported_count,
    }
    has_more_records = catalog_request_creation_queryset(
        after_record_id=last_record_id
    ).exists()
    latest_status = persisted_sync_status(state)
    if latest_status == ProcessingSyncStatus.PAUSING:
        if not has_more_records:
            return complete_catalog_automation(state, request_creation=next_request_creation)
        state.status = ProcessingSyncStatus.PAUSED
        state.progress = build_catalog_request_creation_progress(
            state,
            request_creation=next_request_creation,
            saved_at=timezone.now().isoformat(),
            trigger_source=sync_trigger_source(state),
            request_creation_phase_status=CATALOG_PHASE_STATUS_PAUSED,
            sync_phase_state=catalog_phase_state(state, CATALOG_SYNC_PHASE),
        )
        state.message = catalog_request_creation_pause_message(next_request_creation)
        update_automation_run_status(SYNC_RUN_MODE_CATALOG_AUTOMATION, state.message)
    elif latest_status != ProcessingSyncStatus.SYNCING:
        return ProcessingSyncState.objects.get(pk=state.pk)
    else:
        if not has_more_records:
            return complete_catalog_automation(state, request_creation=next_request_creation)
        state.progress = build_catalog_request_creation_progress(
            state,
            request_creation=next_request_creation,
            trigger_source=sync_trigger_source(state),
            request_creation_phase_status=CATALOG_PHASE_STATUS_RUNNING,
            sync_phase_state=catalog_phase_state(state, CATALOG_SYNC_PHASE),
        )
        state.message = catalog_request_creation_progress_message(next_request_creation)
    save_sync_state(state)
    return state


def incomplete_automation_pages(page_size=100):
    record_ids = [
        str(record.id)
        for record in unresolved_incomplete_records_queryset()
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


def unresolved_incomplete_records_queryset():
    return BookRecord.objects.filter(resolved_from_incomplete=False).filter(
        Q(was_incomplete=True) | incomplete_category_query()
    )


def uses_supported_source_url(url):
    try:
        normalize_source_url(url)
    except ValueError:
        return False
    return True


def should_use_live_incomplete_fetch():
    if not getattr(settings, "PROCESSING_USE_LIVE_SYNC", False):
        return False
    if settings.CELERY_TASK_ALWAYS_EAGER or "pytest" in sys.modules:
        return False
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False

    unresolved_urls = list(
        unresolved_incomplete_records_queryset().values_list("url", flat=True)
    )
    return not unresolved_urls or all(
        uses_supported_source_url(url) for url in unresolved_urls
    )


def incomplete_sync_remote_pages():
    if should_use_live_incomplete_fetch():
        try:
            return fetch_live_incomplete_remote_pages()
        except Exception:
            logger.warning(
                "Live incomplete catalog fetch failed; falling back to local incomplete snapshot.",
                exc_info=True,
            )
    return incomplete_automation_pages()


def preferred_incomplete_resolution_category(record):
    for candidate in (
        record.will_resolve_to_category,
        incomplete_resolution_category(
            getattr(record.source_catalog_entry, "raw_data", None),
        ),
        "" if category_is_incomplete(record.category) else record.category,
    ):
        value = str(candidate or "").strip()
        if value and not category_is_incomplete(value):
            return value
    return "Uncategorized"


def resolve_incomplete_records(record_ids):
    resolved = []
    published_domains = set()
    for record in BookRecord.objects.filter(pk__in=record_ids):
        if not (record.was_incomplete or category_is_incomplete(record.category)):
            continue
        before_snapshot = processing_record_snapshot(record)
        record.category = preferred_incomplete_resolution_category(record)
        record.was_incomplete = True
        record.resolved_from_incomplete = True
        record.book_creation_state = BookCreationRequestState.CREATED
        record.save()
        latest_request = latest_request_for_record(record)
        if latest_request:
            previous_state = latest_request.state
            latest_request.state = BookCreationRequestState.CREATED
            latest_request.error_message = ""
            latest_request.progress = None
            latest_request.save()
            published_domains.update(
                processing_domains_for_request_change(
                    previous_state,
                    BookCreationRequestState.CREATED,
                    record=record,
                )
            )
        else:
            BookCreationRequest.objects.create(
                id=next_request_id(request_id_for_record(record)),
                book_record=record,
                state=BookCreationRequestState.CREATED,
                origin=SubmissionOrigin.AUTOMATION,
            )
            published_domains.update(
                processing_domains_for_request_change(
                    None,
                    BookCreationRequestState.CREATED,
                    record=record,
                )
            )
        published_domains.update(
            processing_domains_for_record_change(
                before_snapshot,
                processing_record_snapshot(record),
                current_request_state=BookCreationRequestState.CREATED,
            )
        )
        resolved.append(record)
    if published_domains:
        publish_processing_ui_domains(published_domains)
    return resolved


def complete_incomplete_automation(state, *, resolved_count=0):
    finished_at = timezone.now()
    update_automation_run_status(
        SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
        f"Updated {resolved_count} {'book' if resolved_count == 1 else 'books'}.",
        last_run_at=finished_at,
    )
    return finalize_sync(
        state,
        message=(
            f"Incomplete catalog sync complete. Updated {resolved_count} "
            f"{'book' if resolved_count == 1 else 'books'}."
        ),
    )


def incomplete_remote_urls(remote_pages):
    urls = set()
    for page in catalog_remote_pages(remote_pages):
        for item in page:
            url = str(item.get("url") or "").strip()
            if not url:
                continue
            try:
                urls.add(normalize_source_url(url))
            except ValueError:
                urls.add(url)
    return urls


def stale_incomplete_record_ids(remote_pages):
    current_urls = incomplete_remote_urls(remote_pages)
    stale_ids = []
    for record_id, url in unresolved_incomplete_records_queryset().values_list("id", "url"):
        normalized_url = str(url or "").strip()
        try:
            normalized_url = normalize_source_url(normalized_url)
        except ValueError:
            pass
        if normalized_url not in current_urls:
            stale_ids.append(record_id)
    return stale_ids


def complete_live_incomplete_sync(state):
    resolved = resolve_incomplete_records(stale_incomplete_record_ids(state.remote_pages))
    state.updated_count = len(resolved)
    save_sync_state(state, update_fields=["updated_count", "updated_at"])
    return complete_incomplete_automation(state, resolved_count=len(resolved))


def advance_live_incomplete_sync_once(state):
    resolver = TitleResolver(session=create_session_with_retries())
    seen_urls = incomplete_remote_urls(state.remote_pages)
    page_signatures = {
        tuple(item.get("url") for item in page[:5] if item.get("url"))
        for page in catalog_remote_pages(state.remote_pages)
        if page
    }

    page_number = state.page_index + 1
    page = fetch_live_incomplete_page(resolver, page_number)
    unique_page = []
    for item in page:
        source_url = item.get("url")
        if not source_url or source_url in seen_urls:
            continue
        seen_urls.add(source_url)
        unique_page.append(item)

    signature = tuple(item["url"] for item in unique_page[:5])
    if not unique_page or (signature and signature in page_signatures):
        return complete_live_incomplete_sync(state)

    state.remote_pages = [*catalog_remote_pages(state.remote_pages), unique_page]
    result = upsert_remote_records(unique_page)
    state.fetched_count += len(unique_page)
    state.skipped_count += result["skipped_count"]
    state.appended_count += result["appended_count"]
    state.page_index += 1

    latest_status = persisted_sync_status(state)
    if latest_status == ProcessingSyncStatus.PAUSING:
        state.status = ProcessingSyncStatus.PAUSED
        state.progress = build_sync_progress(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            saved_at=timezone.now().isoformat(),
            live_fetch=True,
            trigger_source=sync_trigger_source(state),
        )
        state.message = (
            f"Saved progress for {state.fetched_count} "
            f"{'record' if state.fetched_count == 1 else 'records'} before pausing."
        )
        update_automation_run_status(SYNC_RUN_MODE_INCOMPLETE_AUTOMATION, state.message)
    elif latest_status != ProcessingSyncStatus.SYNCING:
        return ProcessingSyncState.objects.get(pk=state.pk)
    else:
        state.progress = build_sync_progress(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            live_fetch=True,
            trigger_source=sync_trigger_source(state),
        )
        state.message = sync_progress_message(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            state.fetched_count,
        )
    save_sync_state(state)
    return state


def advance_catalog_sync_once(state, run_mode):
    page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    if not page:
        if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
            return begin_catalog_request_creation(state)
        return finalize_catalog_sync(state, run_mode=run_mode)

    result = upsert_remote_records(page)
    state.fetched_count += len(page)
    state.skipped_count += result["skipped_count"]
    state.updated_count += result["updated_count"]
    state.appended_count += result["appended_count"]
    state.page_index += 1
    next_page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    session_id = sync_saved_data(state).get("sessionId") or ""
    request_creation_phase_state = catalog_phase_state(
        state,
        CATALOG_REQUEST_CREATION_PHASE,
    )
    latest_status = persisted_sync_status(state)
    if latest_status == ProcessingSyncStatus.PAUSING:
        state.status = ProcessingSyncStatus.PAUSED
        state.progress = build_catalog_sync_progress(
            state,
            run_mode,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            saved_at=timezone.now().isoformat(),
            live_fetch=sync_uses_live_fetch(state),
            trigger_source=sync_trigger_source(state),
            session_id=session_id,
            sync_phase_status=CATALOG_PHASE_STATUS_PAUSED,
            request_creation_phase_state=request_creation_phase_state,
        )
        state.message = f"Sync progress saved. {catalog_record_total_message()}"
        update_automation_run_status(run_mode, state.message)
    elif latest_status != ProcessingSyncStatus.SYNCING:
        return ProcessingSyncState.objects.get(pk=state.pk)
    elif not next_page:
        if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
            return begin_catalog_request_creation(state)
        return finalize_catalog_sync(state, run_mode=run_mode)
    else:
        state.progress = build_catalog_sync_progress(
            state,
            run_mode,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            live_fetch=sync_uses_live_fetch(state),
            trigger_source=sync_trigger_source(state),
            session_id=session_id,
            sync_phase_status=CATALOG_PHASE_STATUS_RUNNING,
            request_creation_phase_state=request_creation_phase_state,
        )
        state.message = sync_progress_message(run_mode, state.fetched_count)
    save_sync_state(state)
    return state


def advance_catalog_processing_once(state, run_mode):
    if sync_phase(state) == CATALOG_REQUEST_CREATION_PHASE:
        return advance_catalog_request_creation_once(state)
    return advance_catalog_sync_once(state, run_mode)


def advance_incomplete_sync_once(state):
    if sync_uses_live_fetch(state):
        try:
            return advance_live_incomplete_sync_once(state)
        except Exception as exc:
            logger.exception("Live incomplete sync failed.")
            return fail_sync(state, exc)

    page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    if not page:
        resolved = resolve_incomplete_records(stale_incomplete_record_ids(state.remote_pages))
        state.updated_count = len(resolved)
        save_sync_state(state, update_fields=["updated_count", "updated_at"])
        return complete_incomplete_automation(state, resolved_count=len(resolved))

    if isinstance(page, list) and all(not isinstance(item, dict) for item in page):
        resolved = resolve_incomplete_records(page)
        state.fetched_count += len(page)
        state.updated_count += len(resolved)
        state.page_index += 1
        next_page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
        latest_status = persisted_sync_status(state)
        if latest_status == ProcessingSyncStatus.PAUSING:
            state.status = ProcessingSyncStatus.PAUSED
            state.progress = build_sync_progress(
                SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
                next_page_index=state.page_index,
                fetched_count=state.fetched_count,
                saved_at=timezone.now().isoformat(),
                live_fetch=sync_uses_live_fetch(state),
                trigger_source=sync_trigger_source(state),
            )
            state.message = (
                f"Saved progress for {state.fetched_count} "
                f"{'record' if state.fetched_count == 1 else 'records'} before pausing."
            )
            update_automation_run_status(SYNC_RUN_MODE_INCOMPLETE_AUTOMATION, state.message)
        elif latest_status != ProcessingSyncStatus.SYNCING:
            return ProcessingSyncState.objects.get(pk=state.pk)
        elif not next_page:
            return complete_incomplete_automation(state, resolved_count=state.updated_count)
        else:
            state.progress = build_sync_progress(
                SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
                next_page_index=state.page_index,
                fetched_count=state.fetched_count,
                live_fetch=sync_uses_live_fetch(state),
                trigger_source=sync_trigger_source(state),
            )
            state.message = sync_progress_message(
                SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
                state.fetched_count,
            )
        save_sync_state(state)
        return state

    result = upsert_remote_records(page)
    state.fetched_count += len(page)
    state.skipped_count += result["skipped_count"]
    state.appended_count += result["appended_count"]
    state.page_index += 1
    next_page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    latest_status = persisted_sync_status(state)
    if latest_status == ProcessingSyncStatus.PAUSING:
        state.status = ProcessingSyncStatus.PAUSED
        state.progress = build_sync_progress(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            saved_at=timezone.now().isoformat(),
            live_fetch=sync_uses_live_fetch(state),
            trigger_source=sync_trigger_source(state),
        )
        state.message = (
            f"Saved progress for {state.fetched_count} "
            f"{'record' if state.fetched_count == 1 else 'records'} before pausing."
        )
        update_automation_run_status(SYNC_RUN_MODE_INCOMPLETE_AUTOMATION, state.message)
    elif latest_status != ProcessingSyncStatus.SYNCING:
        return ProcessingSyncState.objects.get(pk=state.pk)
    elif not next_page:
        resolved = resolve_incomplete_records(stale_incomplete_record_ids(state.remote_pages))
        state.updated_count = len(resolved)
        save_sync_state(state, update_fields=["updated_count", "updated_at"])
        return complete_incomplete_automation(state, resolved_count=len(resolved))
    else:
        state.progress = build_sync_progress(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            live_fetch=sync_uses_live_fetch(state),
            trigger_source=sync_trigger_source(state),
        )
        state.message = sync_progress_message(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            state.fetched_count,
        )
    save_sync_state(state)
    return state


def run_processing_sync(singleton_key=PROCESSING_SYNC_KEY_CATALOG, task_id=""):
    state = ProcessingSyncState.objects.get(singleton_key=singleton_key)
    if task_id and state.task_id and state.task_id != task_id:
        return state
    if state.status not in SYNC_ACTIVE_STATUSES:
        return state

    run_mode = sync_run_mode(state)
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        return advance_incomplete_sync_once(state)
    if sync_phase(state) == CATALOG_REQUEST_CREATION_PHASE:
        return advance_catalog_request_creation_once(state)
    if not sync_uses_live_fetch(state):
        return advance_catalog_sync_once(state, run_mode)

    return run_processing_sync_until_blocked(singleton_key=singleton_key, task_id=task_id)


def run_processing_sync_until_blocked(
    singleton_key=PROCESSING_SYNC_KEY_CATALOG,
    task_id="",
):
    state = ProcessingSyncState.objects.get(singleton_key=singleton_key)
    if task_id and state.task_id and state.task_id != task_id:
        return state
    if state.status not in SYNC_ACTIVE_STATUSES:
        return state

    run_mode = sync_run_mode(state)
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        while True:
            state.refresh_from_db()
            if task_id and state.task_id and state.task_id != task_id:
                return state
            if state.status not in SYNC_ACTIVE_STATUSES:
                return state
            state = advance_incomplete_sync_once(state)
            if state.status not in SYNC_ACTIVE_STATUSES:
                return state
    if not sync_uses_live_fetch(state):
        while True:
            state.refresh_from_db()
            if task_id and state.task_id and state.task_id != task_id:
                return state
            if state.status not in SYNC_ACTIVE_STATUSES:
                return state
            state = advance_catalog_processing_once(state, run_mode)
            if state.status not in SYNC_ACTIVE_STATUSES:
                return state

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
            if sync_phase(state) == CATALOG_REQUEST_CREATION_PHASE:
                state = advance_catalog_request_creation_once(state)
                if state.status not in SYNC_ACTIVE_STATUSES:
                    return state
                continue

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
                    state = begin_catalog_request_creation(state)
                    if state.status not in SYNC_ACTIVE_STATUSES:
                        return state
                    continue
                return finalize_catalog_sync(state, run_mode=run_mode)

            page_signatures.add(signature)
            result = upsert_remote_records(unique_page)
            state.fetched_count += len(unique_page)
            state.skipped_count += result["skipped_count"]
            state.updated_count += result["updated_count"]
            state.appended_count += result["appended_count"]
            state.page_index += 1

            session_id = sync_saved_data(state).get("sessionId") or ""
            request_creation_phase_state = catalog_phase_state(
                state,
                CATALOG_REQUEST_CREATION_PHASE,
            )
            latest_status = persisted_sync_status(state)
            if latest_status == ProcessingSyncStatus.PAUSING:
                state.status = ProcessingSyncStatus.PAUSED
                state.progress = build_catalog_sync_progress(
                    state,
                    run_mode,
                    next_page_index=state.page_index,
                    fetched_count=state.fetched_count,
                    saved_at=timezone.now().isoformat(),
                    live_fetch=True,
                    trigger_source=sync_trigger_source(state),
                    session_id=session_id,
                    sync_phase_status=CATALOG_PHASE_STATUS_PAUSED,
                    request_creation_phase_state=request_creation_phase_state,
                )
                state.message = f"Sync progress saved. {catalog_record_total_message()}"
                save_sync_state(state)
                update_automation_run_status(run_mode, state.message)
                return state
            if latest_status != ProcessingSyncStatus.SYNCING:
                return ProcessingSyncState.objects.get(pk=state.pk)

            state.progress = build_catalog_sync_progress(
                state,
                run_mode,
                next_page_index=state.page_index,
                fetched_count=state.fetched_count,
                live_fetch=True,
                trigger_source=sync_trigger_source(state),
                session_id=session_id,
                sync_phase_status=CATALOG_PHASE_STATUS_RUNNING,
                request_creation_phase_state=request_creation_phase_state,
            )
            state.message = sync_progress_message(run_mode, state.fetched_count)
            save_sync_state(state)
    except Exception as exc:
        logger.exception("Live processing sync failed.", extra={"task_id": task_id})
        return fail_sync(state, exc)


def advance_sync_once(sync_key=None):
    sync_key = sync_key or active_sync_scope()
    state = get_sync_state(sync_key)
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
    if not can_process_record_url(record.url):
        return False
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
    if processing_request.state == BookCreationRequestState.INITIAL:
        processing_request = _transition_request_state(
            processing_request.id,
            BookCreationRequestState.INITIAL,
            BookCreationRequestState.QUEUED,
        )
    if processing_request.state != BookCreationRequestState.QUEUED:
        return False
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
    if processing_request.state == BookCreationRequestState.QUEUED:
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


def queue_processing_request(processing_request):
    if not can_process_record_url(processing_request.book_record.url):
        return _fail_processing_request(
            processing_request,
            ValueError("Only ebanglalibrary.com book URLs are allowed"),
        )
    if should_enqueue_processing_work():
        if enqueue_request_processing(processing_request):
            return _reload_processing_request(processing_request.id)
        return kickoff_request_processing(processing_request.id)
    if should_run_processing_jobs_inline():
        return kickoff_request_processing(processing_request.id)
    return _reload_processing_request(processing_request.id)


def collect_processing_task_ids():
    task_ids = {
        str(task_id).strip()
        for task_id in ProcessingSyncState.objects.exclude(task_id="").values_list(
            "task_id",
            flat=True,
        )
        if str(task_id).strip()
    }
    for progress in BookCreationRequest.objects.exclude(progress__isnull=True).values_list(
        "progress",
        flat=True,
    ):
        if not isinstance(progress, dict):
            continue
        task_id = str(progress.get(PROCESSING_DISPATCH_TASK_ID_KEY) or "").strip()
        if task_id:
            task_ids.add(task_id)
    return task_ids


def revoke_processing_task_ids(task_ids, *, terminate=False):
    revoked = set()
    for task_id in task_ids or []:
        normalized_task_id = str(task_id or "").strip()
        if not normalized_task_id:
            continue
        try:
            celery_app.control.revoke(normalized_task_id, terminate=terminate)
        except Exception:
            logger.warning(
                "Failed to revoke processing task %s.",
                normalized_task_id,
                exc_info=True,
            )
            continue
        revoked.add(normalized_task_id)
    return revoked


def purge_processing_task_queue():
    try:
        with celery_app.connection_or_acquire() as connection:
            queue = Queue(
                PROCESSING_TASK_QUEUE,
                routing_key=PROCESSING_TASK_QUEUE,
            ).bind(connection.default_channel)
            return int(queue.purge() or 0)
    except Exception:
        logger.warning(
            "Failed to purge processing task queue %s.",
            PROCESSING_TASK_QUEUE,
            exc_info=True,
        )
        return 0


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


def order_catalog_records_queryset(queryset):
    return queryset.annotate(
        processing_status_rank=Case(
            When(
                processing_status=BookCreationState.NOT_CREATED,
                then=Value(0),
            ),
            default=Value(1),
            output_field=IntegerField(),
        )
    ).order_by("processing_status_rank", "name", "id")


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
    include_facets=True,
):
    category_options = (
        distinct_nonempty_values(queryset, "category") if include_facets else None
    )
    status_options = (
        distinct_nonempty_values(queryset, "processing_status") if include_facets else None
    )

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

    pagination = processing_pagination_payload(
        total_count,
        offset,
        limit,
        len(rows),
    )
    return {
        "rows": rows,
        "pagination": pagination,
        "hasMore": pagination["hasMore"],
        **(
            {
                "filters": {
                    "categoryOptions": category_options,
                    "statusOptions": status_options,
                }
            }
            if include_facets
            else {}
        ),
    }


def build_processing_request_table_payload(
    queryset,
    *,
    query="",
    category="",
    status="",
    offset=0,
    limit=PROCESSING_TABLE_DEFAULT_LIMIT,
    include_facets=True,
):
    category_options = (
        distinct_nonempty_values(queryset, "book_record__category")
        if include_facets
        else None
    )
    status_options = (
        distinct_nonempty_values(queryset, "state") if include_facets else None
    )

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

    pagination = processing_pagination_payload(
        total_count,
        offset,
        limit,
        len(rows),
    )
    return {
        "rows": rows,
        "pagination": pagination,
        "hasMore": pagination["hasMore"],
        **(
            {
                "filters": {
                    "categoryOptions": category_options,
                    "statusOptions": status_options,
                }
            }
            if include_facets
            else {}
        ),
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


def processing_table_payload(
    card,
    *,
    query="",
    category="",
    status="",
    offset=0,
    limit=PROCESSING_TABLE_DEFAULT_LIMIT,
    include_facets=True,
):
    offset_value = max(0, int(offset or 0))
    limit_value = max(
        1,
        min(int(limit or PROCESSING_TABLE_DEFAULT_LIMIT), PROCESSING_TABLE_MAX_LIMIT),
    )
    query_value = str(query or "").strip()

    if card == "catalog-records":
        payload = build_processing_record_table_payload(
            order_catalog_records_queryset(
                annotate_record_processing_status(
                    BookRecord.objects.select_related("linked_book")
                    .prefetch_related(processing_request_prefetch())
                )
            ),
            query=query_value,
            category=category,
            status=status,
            offset=offset_value,
            limit=limit_value,
            include_facets=include_facets,
        )
        payload["version"] = processing_ui_versions_map(domains=[card]).get(card, 0)
        return payload

    if card == "incomplete-records":
        payload = build_processing_record_table_payload(
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
            include_facets=include_facets,
        )
        payload["version"] = processing_ui_versions_map(domains=[card]).get(card, 0)
        return payload

    if card == "incomplete-completed":
        payload = build_processing_request_table_payload(
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
            include_facets=include_facets,
        )
        payload["version"] = processing_ui_versions_map(domains=[card]).get(card, 0)
        return payload

    if card in PROCESSING_REQUEST_CARD_STATES:
        payload = build_processing_request_table_payload(
            BookCreationRequest.objects.filter(state__in=PROCESSING_REQUEST_CARD_STATES[card])
            .select_related("book_record", "linked_book", "book_record__linked_book")
            .order_by("-updated_at", "-created_at", "id"),
            query=query_value,
            category=category,
            status=status,
            offset=offset_value,
            limit=limit_value,
            include_facets=include_facets,
        )
        payload["version"] = processing_ui_versions_map(domains=[card]).get(card, 0)
        return payload

    raise KeyError(card)


def processing_request_counts():
    return {
        state: BookCreationRequest.objects.filter(state=state).count()
        for state in BookCreationRequestState.values
    }


def processing_incomplete_counts():
    incomplete_records = (
        BookRecord.objects.filter(resolved_from_incomplete=False)
        .filter(Q(was_incomplete=True) | incomplete_category_query())
        .count()
    )
    resolved_records = BookRecord.objects.filter(
        was_incomplete=True,
        resolved_from_incomplete=True,
    ).count()
    return {
        "incomplete": incomplete_records,
        "resolved": resolved_records,
    }


def processing_summary_payload():
    request_counts = processing_request_counts()
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
    incomplete_counts = processing_incomplete_counts()

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
        "incomplete": incomplete_counts,
        "notifications": {
            "activeRequests": active_requests,
            "createdCount": request_counts[BookCreationRequestState.CREATED],
            "failedCount": request_counts[BookCreationRequestState.FAILED],
            "duplicateCount": request_counts[BookCreationRequestState.DUPLICATE],
            "latestFailedMessage": latest_failed_message,
        },
    }


def processing_card_payload(card):
    if card not in PROCESSING_SHARED_CARD_KEYS:
        raise KeyError(card)
    payload = processing_ui_shared_projection_payload(card)
    return {
        **payload,
        "version": processing_ui_versions_map(domains=[card]).get(card, 0),
    }

def create_request_for_record(record, state=BookCreationRequestState.INITIAL, origin=SubmissionOrigin.CURATION):
    if (
        state == BookCreationRequestState.INITIAL
        and not can_process_record_url(record.url)
    ):
        logger.warning(
            "Skipping request creation for record %s because its URL is unsupported: %s",
            record.id,
            record.url,
        )
        return None
    processing_request = BookCreationRequest.objects.create(
        id=next_request_id(request_id_for_record(record)),
        book_record=record,
        state=state,
        origin=origin,
    )
    sync_record_state(record)
    domains = processing_domains_for_request_change(None, state, record=record)
    if origin == SubmissionOrigin.AUTOMATION:
        domains.update(
            {
                PROCESSING_CARD_CATALOG_AUTOMATION,
                PROCESSING_CARD_CREATE_OVERVIEW,
            }
        )
    publish_processing_ui_domains(domains)
    if state == BookCreationRequestState.INITIAL:
        processing_request = queue_processing_request(processing_request)
    return processing_request


def create_requests_for_record_ids(record_ids, *, actor=None, origin=SubmissionOrigin.CURATION):
    created = []
    for record in BookRecord.objects.filter(pk__in=record_ids).order_by("name", "id"):
        if not record_is_selectable(record):
            continue
        processing_request = create_request_for_record(record, origin=origin)
        if processing_request is not None:
            created.append(processing_request)
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
    publish_processing_ui_domains(processing_domains_for_automation(kind))
    return automation_settings


def _local_scheduled_datetime(now, scheduled_time):
    local_now = timezone.localtime(now)
    return local_now.replace(
        hour=scheduled_time.hour,
        minute=scheduled_time.minute,
        second=0,
        microsecond=0,
    )


def automation_is_due(automation_settings, *, now=None):
    if not automation_settings.enabled:
        return False

    now = now or timezone.now()
    scheduled_at = _local_scheduled_datetime(now, automation_settings.time)
    local_now = timezone.localtime(now)
    if local_now < scheduled_at:
        return False

    last_run_at = automation_settings.last_run_at
    if last_run_at is None:
        return True

    last_local = timezone.localtime(last_run_at)
    days_since_last_run = (scheduled_at.date() - last_local.date()).days

    if automation_settings.interval == "daily":
        return days_since_last_run >= 1
    if automation_settings.interval == "weekly":
        return days_since_last_run >= 7
    if automation_settings.interval == "biweekly":
        return days_since_last_run >= 14
    if automation_settings.interval == "monthly":
        return (
            scheduled_at.year,
            scheduled_at.month,
        ) != (
            last_local.year,
            last_local.month,
        )
    return days_since_last_run >= 7


def run_due_processing_automations(*, now=None):
    now = now or timezone.now()
    results = {}

    catalog_settings = get_automation_settings(ProcessingAutomationKind.CATALOG)
    if automation_is_due(catalog_settings, now=now):
        state = run_catalog_automation(trigger_source=SYNC_TRIGGER_SOURCE_SCHEDULER)
        results["catalog"] = {
            "ran": sync_run_mode(state) == SYNC_RUN_MODE_CATALOG_AUTOMATION,
            "status": state.status,
            "runMode": sync_run_mode(state),
        }
    else:
        results["catalog"] = {"ran": False, "status": "idle", "runMode": None}

    incomplete_settings = get_automation_settings(ProcessingAutomationKind.INCOMPLETE)
    if automation_is_due(incomplete_settings, now=now):
        state = run_incomplete_automation(trigger_source=SYNC_TRIGGER_SOURCE_SCHEDULER)
        results["incomplete"] = {
            "ran": sync_run_mode(state) == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            "status": state.status,
            "runMode": sync_run_mode(state),
        }
    else:
        results["incomplete"] = {"ran": False, "status": "idle", "runMode": None}

    return results


def run_manual_catalog_sync(
    remote_pages=None,
    *,
    trigger_source=SYNC_TRIGGER_SOURCE_BUTTON,
):
    sync_state = get_sync_state(PROCESSING_SYNC_KEY_CATALOG)
    if sync_owner_conflicts(sync_state, SYNC_RUN_MODE_MANUAL):
        return sync_state
    if (
        sync_state.status == ProcessingSyncStatus.PAUSED
        and catalog_sync_phase_status(sync_state) == CATALOG_PHASE_STATUS_PAUSED
    ):
        return resume_sync(
            PROCESSING_SYNC_KEY_CATALOG,
            run_mode=SYNC_RUN_MODE_MANUAL,
        )
    if sync_state.status in SYNC_ACTIVE_STATUSES:
        return sync_state
    return start_sync(
        remote_pages or None,
        run_mode=SYNC_RUN_MODE_MANUAL,
        sync_key=PROCESSING_SYNC_KEY_CATALOG,
        trigger_source=trigger_source,
    )


def run_catalog_automation(*, trigger_source=SYNC_TRIGGER_SOURCE_BUTTON):
    sync_state = get_sync_state(PROCESSING_SYNC_KEY_CATALOG)
    if sync_owner_conflicts(sync_state, SYNC_RUN_MODE_CATALOG_AUTOMATION):
        if trigger_source == SYNC_TRIGGER_SOURCE_SCHEDULER:
            update_automation_run_status(
                SYNC_RUN_MODE_CATALOG_AUTOMATION,
                "Waiting for the catalog runtime to become idle.",
            )
        return sync_state
    if catalog_request_creation_can_resume(sync_state) or (
        sync_state.status == ProcessingSyncStatus.PAUSED
        and catalog_sync_phase_status(sync_state) == CATALOG_PHASE_STATUS_PAUSED
    ):
        return resume_sync(
            PROCESSING_SYNC_KEY_CATALOG,
            run_mode=SYNC_RUN_MODE_CATALOG_AUTOMATION,
        )
    if sync_state.status in SYNC_ACTIVE_STATUSES:
        return sync_state
    if (
        catalog_sync_phase_status(sync_state) == CATALOG_PHASE_STATUS_COMPLETED
        and catalog_request_creation_phase_status(sync_state)
        == CATALOG_PHASE_STATUS_NOT_STARTED
    ):
        return begin_catalog_request_creation(sync_state)
    remote_pages = []
    if allow_processing_remote_page_payloads():
        remote_pages = catalog_remote_pages(sync_state.remote_pages)
    if settings.CELERY_TASK_ALWAYS_EAGER and not remote_pages:
        remote_pages = source_catalog_remote_pages()
    return start_sync(
        remote_pages or None,
        run_mode=SYNC_RUN_MODE_CATALOG_AUTOMATION,
        sync_key=PROCESSING_SYNC_KEY_CATALOG,
        trigger_source=trigger_source,
    )


def run_incomplete_automation(*, trigger_source=SYNC_TRIGGER_SOURCE_BUTTON):
    sync_state = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    if sync_state.status == ProcessingSyncStatus.PAUSED:
        return resume_sync(
            PROCESSING_SYNC_KEY_INCOMPLETE,
            run_mode=SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
        )
    if sync_state.status in SYNC_ACTIVE_STATUSES:
        return sync_state
    return start_sync(
        None,
        run_mode=SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
        sync_key=PROCESSING_SYNC_KEY_INCOMPLETE,
        trigger_source=trigger_source,
    )


def reset_processing_data(*, revoke_tasks=False, purge_queue=False):
    task_ids = collect_processing_task_ids() if revoke_tasks else set()
    if task_ids:
        revoke_processing_task_ids(task_ids)

    with transaction.atomic():
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
        publish_processing_ui_domains(PROCESSING_CARD_KEYS)

    if purge_queue:
        purge_processing_task_queue()


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
    requested_at_raw = progress.get(PROCESSING_DISPATCH_REQUESTED_AT_KEY)
    if not requested_at_raw:
        return False

    requested_at = parse_datetime(str(requested_at_raw))
    if requested_at is None:
        return False
    if timezone.is_naive(requested_at):
        requested_at = timezone.make_aware(requested_at, timezone.get_current_timezone())

    return (timezone.now() - requested_at) < PROCESSING_DISPATCH_STALE_AFTER


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

    before_snapshot = processing_record_snapshot(record)
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
        publish_processing_ui_domains(
            processing_domains_for_record_change(
                before_snapshot,
                processing_record_snapshot(record),
                current_request_state=(
                    latest_request_for_record(record).state
                    if latest_request_for_record(record)
                    else None
                ),
            )
        )
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
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            BookCreationRequestState.PAUSED,
            BookCreationRequestState.PAUSED,
            record=processing_request.book_record,
        )
    )
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
    previous_state = processing_request.state
    record_before = processing_record_snapshot(processing_request.book_record)
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
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.DUPLICATE,
            record=record,
        )
        | processing_domains_for_record_change(
            record_before,
            processing_record_snapshot(record),
            current_request_state=BookCreationRequestState.DUPLICATE,
        )
    )
    return processing_request


def duplicate_candidate_is_current_book(processing_request, candidate_book):
    if candidate_book is None:
        return False

    current_book = processing_linked_book(
        processing_request.book_record,
        processing_request,
    )
    return bool(current_book and current_book.id == candidate_book.id)


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
    previous_state = processing_request.state
    record_before = processing_record_snapshot(processing_request.book_record)
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
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.CREATED,
            record=record,
        )
        | processing_domains_for_record_change(
            record_before,
            processing_record_snapshot(record),
            current_request_state=BookCreationRequestState.CREATED,
        )
    )
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
        if source_duplicate and not duplicate_candidate_is_current_book(
            processing_request,
            source_duplicate,
        ):
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
    if duplicate_book and not duplicate_candidate_is_current_book(
        processing_request,
        duplicate_book,
    ):
        return _mark_request_duplicate(processing_request, duplicate_book)

    book = _persist_processing_book(processing_request, normalized_url, scraped_data)
    return _finalize_processing_request(processing_request, book, scraped_data)


def _fail_processing_request(processing_request, error):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
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
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.FAILED,
            record=processing_request.book_record,
        )
    )
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
            if (
                isinstance(exc, ValueError)
                and "ebanglalibrary.com" in str(exc)
            ):
                break
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
        publish_processing_ui_domains(
            processing_domains_for_request_change(
                from_state,
                to_state,
                record=processing_request.book_record,
            )
        )
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


def repair_self_linked_duplicate_requests():
    repaired = []
    published_domains = set()
    queryset = (
        BookCreationRequest.objects.filter(
            state=BookCreationRequestState.DUPLICATE,
            linked_book__isnull=False,
            linked_book__deleted_at__isnull=True,
            duplicate_of_request__isnull=True,
            duplicate_of_record__isnull=True,
        )
        .select_related("book_record", "linked_book", "book_record__linked_book")
        .order_by("created_at", "id")
    )

    for processing_request in queryset:
        previous_state = processing_request.state
        record_before = processing_record_snapshot(processing_request.book_record)
        current_book = processing_linked_book(
            processing_request.book_record,
            processing_request,
        )
        if current_book is None or current_book.id != processing_request.linked_book_id:
            continue

        processing_request.state = BookCreationRequestState.CREATED
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
        record_update_fields = []
        if record.linked_book_id != current_book.id:
            record.linked_book = current_book
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
        repaired.append(processing_request)
        published_domains.update(
            processing_domains_for_request_change(
                previous_state,
                BookCreationRequestState.CREATED,
                record=record,
            )
            | processing_domains_for_record_change(
                record_before,
                processing_record_snapshot(record),
                current_request_state=BookCreationRequestState.CREATED,
            )
        )

    if published_domains:
        publish_processing_ui_domains(published_domains)
    return repaired


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
        recovered_request = _transition_request_state(
            processing_request.id,
            BookCreationRequestState.PROCESSING,
            BookCreationRequestState.QUEUED,
        )
        recovered_request.error_message = ""
        recovered_request.save(update_fields=["error_message", "updated_at"])
        recovered.append(recovered_request)
        queue_processing_request(processing_request)
    return recovered


def run_processing_maintenance():
    recovered = mark_stale_processing_requests()
    repaired = repair_self_linked_duplicate_requests()
    return {
        "recoveredCount": len(recovered),
        "repairedCount": len(repaired),
    }


def run_processing_runtime_tick():
    sync_results = {}
    for sync_key in (PROCESSING_SYNC_KEY_CATALOG, PROCESSING_SYNC_KEY_INCOMPLETE):
        state = get_sync_state(sync_key)
        if state.status in SYNC_ACTIVE_STATUSES:
            sync_results[sync_key] = sync_state_task_payload(
                advance_sync_once(sync_key)
            )
    return {
        "sync": sync_results,
        "advancedCount": advance_pipeline_once(),
    }


def apply_delete_action(processing_request, *, delete_book=False):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    if delete_book and processing_request.linked_book and processing_request.linked_book.deleted_at is None:
        processing_request.linked_book.soft_delete()

    processing_request.state = BookCreationRequestState.DELETED
    processing_request.progress = None
    processing_request.error_message = ""
    processing_request.save(update_fields=["state", "progress", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.DELETED,
            record=processing_request.book_record,
        )
    )
    return processing_request


def apply_pause_action(processing_request):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    saved_data = _request_saved_data(processing_request)
    processing_request.state = BookCreationRequestState.PAUSED
    processing_request.progress = _build_processing_progress(
        _request_progress(processing_request).get("checkpoint") or "Pause requested",
        saved_data,
    )
    processing_request.error_message = ""
    processing_request.save(update_fields=["state", "progress", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.PAUSED,
            record=processing_request.book_record,
        )
    )
    return processing_request


def apply_resume_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    processing_request.state = BookCreationRequestState.INITIAL
    processing_request.is_resumed = True
    processing_request.error_message = ""
    processing_request.save(update_fields=["state", "is_resumed", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.INITIAL,
            record=processing_request.book_record,
        )
    )
    queue_processing_request(processing_request)
    return processing_request


def apply_retry_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    record_before = processing_record_snapshot(processing_request.book_record)
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
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.INITIAL,
            record=record,
        )
        | processing_domains_for_record_change(
            record_before,
            processing_record_snapshot(record),
            current_request_state=BookCreationRequestState.INITIAL,
        )
    )
    queue_processing_request(processing_request)
    return processing_request


def apply_new_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    record_before = processing_record_snapshot(processing_request.book_record)
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
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.INITIAL,
            record=record,
        )
        | processing_domains_for_record_change(
            record_before,
            processing_record_snapshot(record),
            current_request_state=BookCreationRequestState.INITIAL,
        )
    )
    queue_processing_request(processing_request)
    return processing_request


def apply_confirm_duplicate_action(processing_request):
    processing_request = _reload_processing_request(processing_request.id)
    record_before = processing_record_snapshot(processing_request.book_record)
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
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            BookCreationRequestState.DUPLICATE,
            BookCreationRequestState.DUPLICATE,
            record=processing_request.book_record,
        )
        | processing_domains_for_record_change(
            record_before,
            processing_record_snapshot(processing_request.book_record),
            current_request_state=BookCreationRequestState.DUPLICATE,
        )
    )
    return processing_request


def apply_recreate_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    record_before = processing_record_snapshot(processing_request.book_record)
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
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.INITIAL,
            record=record,
        )
        | processing_domains_for_record_change(
            record_before,
            processing_record_snapshot(record),
            current_request_state=BookCreationRequestState.INITIAL,
        )
    )
    queue_processing_request(processing_request)
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
        elif should_enqueue_processing_work():
            if not _request_dispatch_pending(queued_request):
                if not enqueue_request_processing(queued_request):
                    kickoff_request_processing(queued_request.id)
                advanced += 1
        else:
            _transition_request_state(
                queued_request.id,
                BookCreationRequestState.QUEUED,
                BookCreationRequestState.PROCESSING,
            )
            advanced += 1

    processing_request = (
        BookCreationRequest.objects.filter(state=BookCreationRequestState.PROCESSING)
        .order_by("created_at", "id")
        .first()
    )
    if processing_request and (
        should_run_processing_jobs_inline()
        or should_manually_advance_processing_work()
    ):
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
        repair_self_linked_duplicate_requests()
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
