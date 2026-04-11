import logging

from celery import shared_task
from django.db import OperationalError, ProgrammingError

from apps.ingestion.models import ProcessingJob
from apps.ingestion.services.curation import process_catalog_curation_run, process_source_catalog_refresh, run_due_catalog_automation
from apps.ingestion.services.submissions import process_submission_job

logger = logging.getLogger(__name__)

CATALOG_AUTOMATION_SCHEMA_TABLES = (
    "ingestion_catalogautomationsettings",
    "ingestion_catalogcurationrun",
)


def serialize_processing_job_result(result):
    if not isinstance(result, ProcessingJob):
        return result

    return {
        "job_id": str(result.id),
        "submission_id": str(result.submission_id),
        "book_id": str(result.book_id) if result.book_id else "",
        "status": result.status,
    }


def serialize_source_catalog_refresh_result(result):
    if not result:
        return result

    return {
        "id": str(result.id),
        "status": result.status,
        "task_id": result.task_id,
        "queue_name": result.queue_name,
        "retry_count": result.retry_count,
        "refreshed_entries": result.refreshed_entries,
        "last_error": result.last_error,
        "started_at": result.started_at.isoformat() if result.started_at else None,
        "finished_at": result.finished_at.isoformat() if result.finished_at else None,
    }


def catalog_automation_schema_not_ready(exc):
    message = str(exc).lower()
    table_missing = (
        "no such table" in message
        or "undefinedtable" in message
        or ("relation" in message and "does not exist" in message)
    )
    if not table_missing:
        return False
    return any(table_name in message for table_name in CATALOG_AUTOMATION_SCHEMA_TABLES)


@shared_task(bind=True, autoretry_for=(Exception,), retry_backoff=True, retry_jitter=True, max_retries=3)
def process_submission_task(self, job_id):
    result = process_submission_job(job_id, retry_count=self.request.retries, task_id=self.request.id)
    return serialize_processing_job_result(result)


@shared_task(bind=True, autoretry_for=(Exception,), retry_backoff=True, retry_jitter=True, max_retries=3)
def process_catalog_curation_run_task(self, run_id):
    return process_catalog_curation_run(run_id, retry_count=self.request.retries, task_id=self.request.id)


@shared_task(bind=True, autoretry_for=(Exception,), retry_backoff=True, retry_jitter=True, max_retries=3)
def refresh_source_catalog_task(self):
    result = process_source_catalog_refresh(retry_count=self.request.retries, task_id=self.request.id)
    return serialize_source_catalog_refresh_result(result)


@shared_task
def run_catalog_automation_schedule_task():
    try:
        return run_due_catalog_automation()
    except (OperationalError, ProgrammingError) as exc:
        if not catalog_automation_schema_not_ready(exc):
            raise

        logger.warning(
            "Catalog automation scheduler skipped because the database schema is not ready yet: %s",
            exc,
        )
        return {"ran": False, "reason": "schema_not_ready"}
