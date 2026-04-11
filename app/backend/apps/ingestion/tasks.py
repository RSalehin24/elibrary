from celery import shared_task

from apps.ingestion.models import ProcessingJob
from apps.ingestion.services.curation import process_catalog_curation_run, process_source_catalog_refresh, run_due_catalog_automation
from apps.ingestion.services.submissions import process_submission_job


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
    return run_due_catalog_automation()
