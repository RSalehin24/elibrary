from celery import current_app
from django.utils import timezone

from apps.ingestion.models import JobStatus


def revoke_curation_task(task_id, logger):
    if not task_id:
        return
    try:
        current_app.control.revoke(task_id)
    except Exception:
        logger.warning("Failed to revoke catalog curation task.", exc_info=True)


def finalize_cancelled_catalog_curation_run(run, message):
    run.status = JobStatus.CANCELLED
    run.cancel_requested = False
    run.last_error = message
    run.finished_at = timezone.now()
    run.save(update_fields=["status", "cancel_requested", "last_error", "finished_at", "updated_at"])
    return run


def dispatch_catalog_curation_run(run, *, fallback_processor, logger, force=False):
    from apps.ingestion.tasks import process_catalog_curation_run_task

    run.refresh_from_db(fields=["status", "task_id", "queue_name", "cancel_requested", "updated_at"])
    if run.status == JobStatus.CANCELLED or run.cancel_requested:
        return run
    if not force and run.status == JobStatus.QUEUED and run.task_id:
        return run

    try:
        async_result = process_catalog_curation_run_task.delay(str(run.id))
        run.task_id = getattr(async_result, "id", "")
        run.queue_name = "celery"
        run.save(update_fields=["task_id", "queue_name", "updated_at"])
    except Exception as exc:
        logger.warning("Catalog curation dispatch failed, falling back to inline processing", exc_info=True)
        run.queue_name = "inline-fallback"
        run.last_error = f"Celery dispatch failed: {exc}"
        run.save(update_fields=["queue_name", "last_error", "updated_at"])
        fallback_processor(str(run.id), retry_count=run.retry_count, task_id="")

    return run

