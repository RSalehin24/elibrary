import logging
from collections import Counter
from datetime import datetime, timedelta

from celery import current_app
from django.utils import timezone

from apps.catalog.models import BookSource, GeneratedAssetStatus, GeneratedAssetType
from apps.common.models import LifecycleState
from apps.ingestion.models import (
    CatalogAutomationSettings,
    CatalogCurationMode,
    CatalogCurationRun,
    CatalogCurationTrigger,
    JobStatus,
    SourceCatalogEntry,
    SubmissionOrigin,
)
from apps.ingestion.services.resolution import ARCHIVE_MAX_PAGES, TitleResolver
from apps.ingestion.services.submissions import create_submission_records, queue_reprocess_book

logger = logging.getLogger(__name__)

ACTIVE_RUN_STATUSES = (JobStatus.QUEUED, JobStatus.PROCESSING)
REQUIRED_READY_ASSETS = (GeneratedAssetType.HTML, GeneratedAssetType.EPUB)
RUN_CANCEL_MESSAGE = "Stopped by user."


def normalize_refresh_max_pages(value):
    try:
        page_count = int(value)
    except (TypeError, ValueError):
        page_count = ARCHIVE_MAX_PAGES
    return max(1, min(page_count, ARCHIVE_MAX_PAGES))


def get_catalog_automation_settings():
    settings_obj, _ = CatalogAutomationSettings.objects.get_or_create(singleton_key="default")
    return settings_obj


def next_catalog_automation_run_at(settings_obj, now=None):
    now = timezone.localtime(now or timezone.now())
    scheduled_for = timezone.make_aware(
        datetime.combine(now.date(), settings_obj.daily_run_time),
        timezone.get_current_timezone(),
    )
    if scheduled_for <= now:
        scheduled_for += timedelta(days=1)
    return scheduled_for


def source_catalog_book_source_map(source_urls):
    book_sources = (
        BookSource.objects.filter(normalized_source_url__in=source_urls)
        .select_related("book")
        .prefetch_related("book__generated_assets", "book__processing_jobs")
    )
    return {book_source.normalized_source_url: book_source for book_source in book_sources}


def book_has_required_assets(book):
    asset_statuses = {asset.asset_type: asset.status for asset in book.generated_assets.all()}
    return all(asset_statuses.get(asset_type) == GeneratedAssetStatus.READY for asset_type in REQUIRED_READY_ASSETS)


def inspect_source_catalog_entry(entry, source_map):
    book_source = source_map.get(entry.source_url)
    local_book = book_source.book if book_source and book_source.book_id else None
    latest_job = local_book.processing_jobs.first() if local_book else None

    if local_book and local_book.deleted_at:
        status = "deleted"
    elif not local_book:
        status = "new"
    elif latest_job and latest_job.status in {JobStatus.QUEUED, JobStatus.PROCESSING}:
        status = "processing"
    elif latest_job and latest_job.status == JobStatus.FAILED:
        status = "failed"
    elif local_book.state != LifecycleState.READY or not book_has_required_assets(local_book):
        status = "unfinished"
    else:
        status = "ready"

    return {
        "entry": entry,
        "book_source": book_source,
        "local_book": local_book,
        "latest_job": latest_job,
        "curation_status": status,
    }


def serialize_source_catalog_entry_inspection(inspection):
    entry = inspection["entry"]
    local_book = inspection["local_book"]
    latest_job = inspection["latest_job"]
    return {
        "id": str(entry.id),
        "title": entry.title,
        "author_line": entry.author_line,
        "source_url": entry.source_url,
        "last_seen_at": entry.last_seen_at,
        "curation_status": inspection["curation_status"],
        "local_book_slug": local_book.slug if local_book and not local_book.deleted_at else "",
        "local_book_title": local_book.title if local_book and not local_book.deleted_at else "",
        "local_book_state": local_book.state if local_book and not local_book.deleted_at else "",
        "latest_job_status": latest_job.status if latest_job else "",
        "latest_job_error": latest_job.last_error if latest_job else "",
        "updated_at": local_book.updated_at if local_book and not local_book.deleted_at else None,
    }


def source_catalog_entry_snapshots(queryset):
    entries = list(queryset)
    source_map = source_catalog_book_source_map([entry.source_url for entry in entries])
    inspections = [inspect_source_catalog_entry(entry, source_map) for entry in entries]
    snapshots = [serialize_source_catalog_entry_inspection(inspection) for inspection in inspections]
    summary = Counter(snapshot["curation_status"] for snapshot in snapshots)
    return snapshots, {
        "total": len(snapshots),
        "new": summary.get("new", 0),
        "processing": summary.get("processing", 0),
        "unfinished": summary.get("unfinished", 0),
        "failed": summary.get("failed", 0),
        "ready": summary.get("ready", 0),
        "deleted": summary.get("deleted", 0),
    }


def build_catalog_curation_run_summary():
    return {
        "catalog_entries": 0,
        "refreshed_entries": 0,
        "queued_creates": 0,
        "queued_updates": 0,
        "skipped_ready": 0,
        "skipped_processing": 0,
        "skipped_deleted": 0,
        "errors": [],
        "status_counts": {
            "new": 0,
            "processing": 0,
            "unfinished": 0,
            "failed": 0,
            "ready": 0,
            "deleted": 0,
        },
    }


def revoke_curation_task(task_id):
    if not task_id:
        return
    try:
        current_app.control.revoke(task_id)
    except Exception:
        logger.warning("Failed to revoke catalog curation task.", exc_info=True)


def finalize_cancelled_catalog_curation_run(run, message=RUN_CANCEL_MESSAGE):
    run.status = JobStatus.CANCELLED
    run.cancel_requested = False
    run.last_error = message
    run.finished_at = timezone.now()
    run.save(update_fields=["status", "cancel_requested", "last_error", "finished_at", "updated_at"])
    return run


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


def submission_origin_for_run(run):
    if run.trigger == CatalogCurationTrigger.SCHEDULED:
        return SubmissionOrigin.AUTOMATION
    return SubmissionOrigin.CURATION


def dispatch_catalog_curation_run(run, force=False):
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
        process_catalog_curation_run(str(run.id), retry_count=run.retry_count, task_id="")


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


def should_update_existing_book(inspection, mode):
    status = inspection["curation_status"]
    if status in {"processing", "deleted"}:
        return False
    if mode == CatalogCurationMode.ALL:
        return inspection["local_book"] is not None
    return status in {"unfinished", "failed"}


def should_create_missing_book(inspection):
    return inspection["curation_status"] == "new"


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
            resolver = TitleResolver()
            refreshed = resolver.refresh_catalog(max_pages=normalize_refresh_max_pages(run.refresh_max_pages))
            summary["refreshed_entries"] = len(refreshed)

        entries = list(SourceCatalogEntry.objects.order_by("title"))
        summary["catalog_entries"] = len(entries)
        source_map = source_catalog_book_source_map([entry.source_url for entry in entries])
        submission_origin = submission_origin_for_run(run)

        for entry in entries:
            run.refresh_from_db(fields=["status", "cancel_requested", "updated_at"])
            if run.status == JobStatus.CANCELLED or run.cancel_requested:
                run.summary = summary
                run.save(update_fields=["summary", "updated_at"])
                return finalize_cancelled_catalog_curation_run(run)
            inspection = inspect_source_catalog_entry(entry, source_map)
            status = inspection["curation_status"]
            summary["status_counts"][status] += 1

            if status == "deleted":
                summary["skipped_deleted"] += 1
                continue

            try:
                if should_create_missing_book(inspection):
                    create_submission_records(
                        submitter=run.requested_by,
                        parsed_entries=[{"kind": "url", "value": entry.source_url}],
                        auto_process=True,
                        origin=submission_origin,
                    )
                    summary["queued_creates"] += 1
                    continue

                if should_update_existing_book(inspection, run.mode):
                    _, created = queue_reprocess_book(
                        inspection["local_book"],
                        actor=run.requested_by,
                        origin=submission_origin,
                    )
                    if created:
                        summary["queued_updates"] += 1
                    else:
                        summary["skipped_processing"] += 1
                    continue

                if status == "processing":
                    summary["skipped_processing"] += 1
                else:
                    summary["skipped_ready"] += 1
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
    scheduled_for_today = timezone.make_aware(
        datetime.combine(now.date(), settings_obj.daily_run_time),
        timezone.get_current_timezone(),
    )

    if now < scheduled_for_today:
        return {"ran": False, "reason": "not_due"}

    if CatalogCurationRun.objects.filter(trigger=CatalogCurationTrigger.SCHEDULED, created_at__date=now.date()).exists():
        return {"ran": False, "reason": "already_ran"}

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
