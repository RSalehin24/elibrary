import logging

from celery import current_app
from django.utils import timezone

from apps.ingestion.models import SourceCatalogRefreshState, SourceCatalogRefreshStatus
from apps.ingestion.services.curation_support.schedule import normalize_refresh_max_pages
from apps.ingestion.services.resolution import TitleResolver


logger = logging.getLogger(__name__)


def get_source_catalog_refresh_state():
    state, _ = SourceCatalogRefreshState.objects.get_or_create(singleton_key="default")
    return state


def revoke_source_catalog_refresh_task(task_id, terminate=False):
    if not task_id:
        return
    try:
        current_app.control.revoke(task_id, terminate=terminate)
    except Exception:
        logger.warning("Failed to revoke source catalog refresh task.", exc_info=True)


def finalize_source_catalog_refresh_stop(state, message):
    state.status = SourceCatalogRefreshStatus.IDLE
    state.task_id = ""
    state.queue_name = ""
    state.retry_count = 0
    state.last_error = message
    state.finished_at = timezone.now()
    state.save(update_fields=["status", "task_id", "queue_name", "retry_count", "last_error", "finished_at", "updated_at"])
    return state


def process_source_catalog_refresh(retry_count=0, task_id=""):
    state = SourceCatalogRefreshState.objects.select_related("requested_by").get(singleton_key="default")
    state.status = SourceCatalogRefreshStatus.PROCESSING
    state.retry_count = retry_count
    state.task_id = task_id or state.task_id
    state.started_at = timezone.now()
    state.finished_at = None
    state.last_error = ""
    state.save(update_fields=["status", "retry_count", "task_id", "started_at", "finished_at", "last_error", "updated_at"])

    try:
        refreshed = TitleResolver().refresh_catalog(max_pages=normalize_refresh_max_pages(state.max_pages))
        state.status = SourceCatalogRefreshStatus.SUCCEEDED
        state.refreshed_entries = len(refreshed)
        state.finished_at = timezone.now()
        state.save(update_fields=["status", "refreshed_entries", "finished_at", "updated_at"])
        return state
    except Exception as exc:
        logger.exception("Source catalog refresh failed")
        state.status = SourceCatalogRefreshStatus.FAILED
        state.last_error = str(exc)
        state.finished_at = timezone.now()
        state.save(update_fields=["status", "last_error", "finished_at", "updated_at"])
        raise

