import logging

from django.utils import timezone

from apps.ingestion.models import (
    CatalogAutomationSettings,
    CatalogCurationMode,
    CatalogCurationRun,
    CatalogCurationTrigger,
    JobStatus,
    SourceCatalogEntry,
    SourceCatalogRefreshStatus,
)
from apps.ingestion.services.curation_support.catalog_entries import (
    build_catalog_curation_run_summary,
    inspect_source_catalog_entry as support_inspect_source_catalog_entry,
    serialize_source_catalog_entry_inspection as support_serialize_source_catalog_entry_inspection,
    should_create_missing_book,
    should_retry_failed_entry,
    should_update_existing_book,
    source_catalog_book_source_map,
    source_catalog_entry_snapshots as support_source_catalog_entry_snapshots,
    source_catalog_submission_map,
    submission_origin_for_run,
    summarize_source_catalog_snapshots as support_summarize_source_catalog_snapshots,
)
from apps.ingestion.services.curation_support.schedule import (
    next_catalog_automation_due_at as support_next_catalog_automation_due_at,
    normalize_refresh_max_pages as support_normalize_refresh_max_pages,
)
from apps.ingestion.services.curation_support.run_lifecycle import (
    dispatch_catalog_curation_run as support_dispatch_catalog_curation_run,
    finalize_cancelled_catalog_curation_run as support_finalize_cancelled_catalog_curation_run,
    revoke_curation_task as support_revoke_curation_task,
)
from apps.ingestion.services.curation_support.source_refresh import (
    finalize_source_catalog_refresh_stop as support_finalize_source_catalog_refresh_stop,
    get_source_catalog_refresh_state as support_get_source_catalog_refresh_state,
    process_source_catalog_refresh as support_process_source_catalog_refresh,
    revoke_source_catalog_refresh_task as support_revoke_source_catalog_refresh_task,
)
from apps.ingestion.services.resolution import ARCHIVE_MAX_PAGES, TitleResolver
from apps.ingestion.services.submissions import create_submission_records, queue_reprocess_book

logger = logging.getLogger(__name__)

ACTIVE_RUN_STATUSES = (JobStatus.QUEUED, JobStatus.PROCESSING)
ACTIVE_SOURCE_CATALOG_REFRESH_STATUSES = (SourceCatalogRefreshStatus.QUEUED, SourceCatalogRefreshStatus.PROCESSING)
RUN_CANCEL_MESSAGE = "Stopped by user."
SOURCE_REFRESH_STOP_MESSAGE = "Stopped by user."


def normalize_refresh_max_pages(value): return support_normalize_refresh_max_pages(value)


def get_catalog_automation_settings():
    settings_obj, _ = CatalogAutomationSettings.objects.get_or_create(singleton_key="default")
    return settings_obj


def get_source_catalog_refresh_state(): return support_get_source_catalog_refresh_state()


def latest_catalog_automation_run(): return CatalogCurationRun.objects.filter(trigger=CatalogCurationTrigger.SCHEDULED).order_by("-created_at").first()


def dispatch_source_catalog_refresh(state, force=False):
    from apps.ingestion.tasks import refresh_source_catalog_task

    state.refresh_from_db(fields=["status", "task_id", "queue_name", "updated_at"])
    if not force and state.status == SourceCatalogRefreshStatus.QUEUED and state.task_id:
        return state

    try:
        async_result = refresh_source_catalog_task.delay()
        state.task_id = getattr(async_result, "id", "")
        state.queue_name = "celery"
        state.save(update_fields=["task_id", "queue_name", "updated_at"])
    except Exception as exc:
        logger.warning("Source catalog refresh dispatch failed, falling back to inline processing", exc_info=True)
        state.queue_name = "inline-fallback"
        state.last_error = f"Celery dispatch failed: {exc}"
        state.save(update_fields=["queue_name", "last_error", "updated_at"])
        process_source_catalog_refresh(retry_count=state.retry_count, task_id="")

    return state


def revoke_source_catalog_refresh_task(task_id, terminate=False): return support_revoke_source_catalog_refresh_task(task_id, terminate=terminate)


def finalize_source_catalog_refresh_stop(state, message=SOURCE_REFRESH_STOP_MESSAGE): return support_finalize_source_catalog_refresh_stop(state, message)


def cancel_source_catalog_refresh(state=None, message=SOURCE_REFRESH_STOP_MESSAGE):
    state = state or get_source_catalog_refresh_state()
    state.refresh_from_db(fields=["status", "task_id", "queue_name", "retry_count", "updated_at"])
    if state.status not in ACTIVE_SOURCE_CATALOG_REFRESH_STATUSES:
        return state

    revoke_source_catalog_refresh_task(state.task_id, terminate=state.status == SourceCatalogRefreshStatus.PROCESSING)
    return finalize_source_catalog_refresh_stop(state, message=message)


def begin_source_catalog_refresh(*, requested_by=None, max_pages=ARCHIVE_MAX_PAGES):
    state = get_source_catalog_refresh_state()
    if state.status in ACTIVE_SOURCE_CATALOG_REFRESH_STATUSES:
        return state, False

    state.status = SourceCatalogRefreshStatus.QUEUED
    state.max_pages = normalize_refresh_max_pages(max_pages)
    state.task_id = ""
    state.queue_name = ""
    state.retry_count = 0
    state.refreshed_entries = 0
    state.last_error = ""
    state.requested_by = requested_by if getattr(requested_by, "is_authenticated", False) else None
    state.started_at = None
    state.finished_at = None
    state.save(update_fields=["status", "max_pages", "task_id", "queue_name", "retry_count", "refreshed_entries", "last_error", "requested_by", "started_at", "finished_at", "updated_at"])
    dispatch_source_catalog_refresh(state)
    return state, True


def process_source_catalog_refresh(retry_count=0, task_id=""): return support_process_source_catalog_refresh(retry_count=retry_count, task_id=task_id)


def next_catalog_automation_due_at(settings_obj, now=None, latest_run=None):
    return support_next_catalog_automation_due_at(
        settings_obj,
        now=now,
        latest_run=latest_run or latest_catalog_automation_run(),
    )


def next_catalog_automation_run_at(settings_obj, now=None, latest_run=None): return next_catalog_automation_due_at(settings_obj, now=now, latest_run=latest_run)


def inspect_source_catalog_entry(entry, source_map, submission_map=None): return support_inspect_source_catalog_entry(entry, source_map, submission_map)


def serialize_source_catalog_entry_inspection(inspection): return support_serialize_source_catalog_entry_inspection(inspection)


def summarize_source_catalog_snapshots(snapshots): return support_summarize_source_catalog_snapshots(snapshots)


def source_catalog_entry_snapshots(queryset): return support_source_catalog_entry_snapshots(queryset)


def revoke_curation_task(task_id): return support_revoke_curation_task(task_id, logger)


def finalize_cancelled_catalog_curation_run(run, message=RUN_CANCEL_MESSAGE): return support_finalize_cancelled_catalog_curation_run(run, message)


def cancel_catalog_curation_run(run, message=RUN_CANCEL_MESSAGE):
    run = CatalogCurationRun.objects.get(pk=run.pk)
    if run.status in {JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED}:
        return run

    run.cancel_requested = True
    run.save(update_fields=["cancel_requested", "updated_at"])
    if run.status == JobStatus.QUEUED:
        revoke_curation_task(run.task_id)
        return finalize_cancelled_catalog_curation_run(run, message=message)
    return run


def dispatch_catalog_curation_run(run, force=False):
    return support_dispatch_catalog_curation_run(
        run,
        fallback_processor=process_catalog_curation_run,
        logger=logger,
        force=force,
    )


def create_catalog_curation_run(
    *,
    mode=CatalogCurationMode.PENDING,
    trigger=CatalogCurationTrigger.MANUAL,
    requested_by=None,
    refresh_catalog=True,
    refresh_max_pages=ARCHIVE_MAX_PAGES,
):
    run = CatalogCurationRun.objects.create(
        trigger=trigger,
        mode=mode,
        status=JobStatus.QUEUED,
        requested_by=requested_by if getattr(requested_by, "is_authenticated", False) else None,
        refresh_catalog=refresh_catalog,
        refresh_max_pages=normalize_refresh_max_pages(refresh_max_pages),
    )
    dispatch_catalog_curation_run(run)
    return run


def process_catalog_curation_run(run_id, retry_count=0, task_id=""):
    run = CatalogCurationRun.objects.select_related("requested_by").get(pk=run_id)
    if run.status == JobStatus.CANCELLED:
        return run
    if run.cancel_requested:
        return finalize_cancelled_catalog_curation_run(run)
    run.status = JobStatus.PROCESSING
    run.retry_count = retry_count
    run.task_id = task_id or run.task_id
    run.started_at = timezone.now()
    run.last_error = ""
    run.save(update_fields=["status", "retry_count", "task_id", "started_at", "last_error", "updated_at"])

    summary = build_catalog_curation_run_summary()

    try:
        run.refresh_from_db(fields=["status", "cancel_requested", "updated_at"])
        if run.status == JobStatus.CANCELLED or run.cancel_requested:
            return finalize_cancelled_catalog_curation_run(run)
        if run.refresh_catalog:
            refreshed = TitleResolver().refresh_catalog(max_pages=normalize_refresh_max_pages(run.refresh_max_pages))
            summary["refreshed_entries"] = len(refreshed)

        entries = list(SourceCatalogEntry.objects.order_by("title"))
        summary["catalog_entries"] = len(entries)
        source_map = source_catalog_book_source_map([entry.source_url for entry in entries])
        submission_map = source_catalog_submission_map([entry.source_url for entry in entries])
        submission_origin = submission_origin_for_run(run)

        for entry in entries:
            run.refresh_from_db(fields=["status", "cancel_requested", "updated_at"])
            if run.status == JobStatus.CANCELLED or run.cancel_requested:
                run.summary = summary
                run.save(update_fields=["summary", "updated_at"])
                return finalize_cancelled_catalog_curation_run(run)

            inspection = inspect_source_catalog_entry(entry, source_map, submission_map)
            status = inspection["curation_status"]
            summary["status_counts"][status] += 1

            if not should_retry_failed_entry(inspection):
                summary["skipped_processing"] += 1
                continue

            try:
                if should_create_missing_book(inspection):
                    create_submission_records(submitter=run.requested_by, parsed_entries=[{"kind": "url", "value": entry.source_url}], auto_process=True, origin=submission_origin)
                    summary["queued_creates"] += 1
                    continue
                if should_update_existing_book(inspection, run.mode):
                    _, created = queue_reprocess_book(inspection["local_book"], actor=run.requested_by, origin=submission_origin)
                    summary["queued_updates"] += 1 if created else 0
                    summary["skipped_processing"] += 0 if created else 1
                    continue
                summary["skipped_processing" if status == "processing" else "skipped_ready"] += 1
            except Exception as exc:
                if len(summary["errors"]) < 20:
                    summary["errors"].append({"source_url": entry.source_url, "error": str(exc)})

        run.summary = summary
        run.status = JobStatus.SUCCEEDED
        run.finished_at = timezone.now()
        run.save(update_fields=["summary", "status", "finished_at", "updated_at"])
        return run
    except Exception as exc:
        logger.exception("Catalog curation run failed", extra={"run_id": str(run.id)})
        run.summary = summary
        run.status = JobStatus.FAILED
        run.last_error = str(exc)
        run.finished_at = timezone.now()
        run.save(update_fields=["summary", "status", "last_error", "finished_at", "updated_at"])
        raise


def run_due_catalog_automation(now=None):
    settings_obj = get_catalog_automation_settings()
    if not settings_obj.enabled:
        return {"ran": False, "reason": "disabled"}

    now = timezone.localtime(now or timezone.now())
    latest_run = latest_catalog_automation_run()
    next_due_at = next_catalog_automation_due_at(settings_obj, now=now, latest_run=latest_run)
    settings_updated_at = timezone.localtime(settings_obj.updated_at or settings_obj.created_at)
    latest_run_at = timezone.localtime(latest_run.created_at) if latest_run else None

    if now < next_due_at:
        if latest_run_at and latest_run_at >= settings_updated_at:
            return {"ran": False, "reason": "already_ran"}
        return {"ran": False, "reason": "not_due"}

    if CatalogCurationRun.objects.filter(status__in=ACTIVE_RUN_STATUSES).exists():
        return {"ran": False, "reason": "busy"}

    run = create_catalog_curation_run(
        mode=settings_obj.mode,
        trigger=CatalogCurationTrigger.SCHEDULED,
        requested_by=None,
        refresh_catalog=True,
        refresh_max_pages=settings_obj.refresh_max_pages,
    )
    return {"ran": True, "run_id": str(run.id)}
