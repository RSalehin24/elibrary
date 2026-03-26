import logging
from calendar import monthrange
from collections import Counter
from datetime import datetime, timedelta

from celery import current_app
from django.utils import timezone

from apps.catalog.models import BookSource, GeneratedAssetStatus, GeneratedAssetType
from apps.common.models import LifecycleState
from apps.ingestion.models import (
    BookSubmission,
    CatalogAutomationSettings,
    CatalogAutomationFrequency,
    CatalogCurationMode,
    CatalogCurationRun,
    CatalogCurationTrigger,
    JobStatus,
    SourceCatalogEntry,
    SourceCatalogRefreshState,
    SourceCatalogRefreshStatus,
    SubmissionOrigin,
)
from apps.ingestion.services.resolution import ARCHIVE_MAX_PAGES, TitleResolver
from apps.ingestion.services.submissions import create_submission_records, queue_reprocess_book

logger = logging.getLogger(__name__)

ACTIVE_RUN_STATUSES = (JobStatus.QUEUED, JobStatus.PROCESSING)
ACTIVE_SOURCE_CATALOG_REFRESH_STATUSES = (
    SourceCatalogRefreshStatus.QUEUED,
    SourceCatalogRefreshStatus.PROCESSING,
)
REQUIRED_READY_ASSETS = (GeneratedAssetType.HTML, GeneratedAssetType.EPUB)
RUN_CANCEL_MESSAGE = "Stopped by user."
SOURCE_REFRESH_STOP_MESSAGE = "Stopped by user."
FAILED_AUTOMATION_RETRY_COOLDOWN = timedelta(hours=6)


def normalize_refresh_max_pages(value):
    try:
        page_count = int(value)
    except (TypeError, ValueError):
        page_count = ARCHIVE_MAX_PAGES
    return max(1, min(page_count, ARCHIVE_MAX_PAGES))


def get_catalog_automation_settings():
    settings_obj, _ = CatalogAutomationSettings.objects.get_or_create(singleton_key="default")
    return settings_obj


def get_source_catalog_refresh_state():
    state, _ = SourceCatalogRefreshState.objects.get_or_create(singleton_key="default")
    return state


def latest_catalog_automation_run():
    return CatalogCurationRun.objects.filter(trigger=CatalogCurationTrigger.SCHEDULED).order_by("-created_at").first()


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


def revoke_source_catalog_refresh_task(task_id, terminate=False):
    if not task_id:
        return
    try:
        current_app.control.revoke(task_id, terminate=terminate)
    except Exception:
        logger.warning("Failed to revoke source catalog refresh task.", exc_info=True)


def finalize_source_catalog_refresh_stop(state, message=SOURCE_REFRESH_STOP_MESSAGE):
    state.status = SourceCatalogRefreshStatus.IDLE
    state.task_id = ""
    state.queue_name = ""
    state.retry_count = 0
    state.last_error = message
    state.finished_at = timezone.now()
    state.save(
        update_fields=[
            "status",
            "task_id",
            "queue_name",
            "retry_count",
            "last_error",
            "finished_at",
            "updated_at",
        ]
    )
    return state


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
    state.save(
        update_fields=[
            "status",
            "max_pages",
            "task_id",
            "queue_name",
            "retry_count",
            "refreshed_entries",
            "last_error",
            "requested_by",
            "started_at",
            "finished_at",
            "updated_at",
        ]
    )
    dispatch_source_catalog_refresh(state)
    return state, True


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
        resolver = TitleResolver()
        refreshed = resolver.refresh_catalog(max_pages=normalize_refresh_max_pages(state.max_pages))
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


def combine_local_date_and_time(date_value, time_value):
    return timezone.make_aware(
        datetime.combine(date_value, time_value),
        timezone.get_current_timezone(),
    )


def day_interval_for_frequency(frequency):
    intervals = {
        CatalogAutomationFrequency.DAILY: 1,
        CatalogAutomationFrequency.WEEKLY: 7,
        CatalogAutomationFrequency.BIWEEKLY: 14,
    }
    return intervals.get(frequency)


def month_interval_for_frequency(frequency):
    intervals = {
        CatalogAutomationFrequency.MONTHLY: 1,
        CatalogAutomationFrequency.BIMONTHLY: 2,
        CatalogAutomationFrequency.QUARTERLY: 3,
        CatalogAutomationFrequency.FOUR_MONTHLY: 4,
        CatalogAutomationFrequency.HALF_YEARLY: 6,
    }
    return intervals.get(frequency)


def shift_date_by_months(date_value, months):
    month_index = date_value.month - 1 + months
    year = date_value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(date_value.day, monthrange(year, month)[1])
    return date_value.replace(year=year, month=month, day=day)


def next_catalog_automation_due_at(settings_obj, now=None, latest_run=None):
    now = timezone.localtime(now or timezone.now())
    today_slot = combine_local_date_and_time(now.date(), settings_obj.daily_run_time)
    latest_run = latest_run or latest_catalog_automation_run()

    latest_run_at = timezone.localtime(latest_run.created_at) if latest_run else None
    settings_updated_at = timezone.localtime(settings_obj.updated_at or settings_obj.created_at)

    # Treat schedule changes as a fresh cadence starting from the update time.
    if latest_run_at is None or settings_updated_at > latest_run_at:
        return today_slot

    day_interval = day_interval_for_frequency(settings_obj.frequency)
    if day_interval:
        next_date = latest_run_at.date() + timedelta(days=day_interval)
        return combine_local_date_and_time(next_date, settings_obj.daily_run_time)

    month_interval = month_interval_for_frequency(settings_obj.frequency)
    if month_interval:
        next_date = shift_date_by_months(latest_run_at.date(), month_interval)
        return combine_local_date_and_time(next_date, settings_obj.daily_run_time)

    return today_slot


def next_catalog_automation_run_at(settings_obj, now=None, latest_run=None):
    return next_catalog_automation_due_at(settings_obj, now=now, latest_run=latest_run)


def source_catalog_book_source_map(source_urls):
    book_sources = (
        BookSource.objects.filter(normalized_source_url__in=source_urls)
        .select_related("book")
        .prefetch_related("book__generated_assets", "book__processing_jobs", "book__book_categories__category")
    )
    return {book_source.normalized_source_url: book_source for book_source in book_sources}


def source_catalog_submission_map(source_urls):
    if not source_urls:
        return {}

    queryset = (
        BookSubmission.objects.filter(resolved_url__in=source_urls)
        .select_related(
            "linked_book",
            "canonical_submission",
            "canonical_submission__linked_book",
        )
        .prefetch_related(
            "processing_jobs",
            "canonical_submission__processing_jobs",
        )
        .order_by("-updated_at", "-created_at")
    )

    submission_map = {}
    for submission in queryset:
        submission_map.setdefault(submission.resolved_url, submission)
    return submission_map


def book_has_required_assets(book):
    asset_statuses = {asset.asset_type: asset.status for asset in book.generated_assets.all()}
    return all(asset_statuses.get(asset_type) == GeneratedAssetStatus.READY for asset_type in REQUIRED_READY_ASSETS)


def root_submission(submission):
    return submission.canonical_submission or submission


def latest_processing_job_for_submission(submission):
    if submission is None:
        return None
    canonical_submission = root_submission(submission)
    return canonical_submission.processing_jobs.first()


def latest_activity_at(entry, latest_submission, latest_job, local_book):
    return (
        (latest_job.finished_at if latest_job else None)
        or (latest_job.started_at if latest_job else None)
        or (latest_job.updated_at if latest_job else None)
        or (latest_submission.updated_at if latest_submission else None)
        or (local_book.updated_at if local_book else None)
        or entry.last_seen_at
    )


def inspect_source_catalog_entry(entry, source_map, submission_map=None):
    submission_map = submission_map or {}
    book_source = source_map.get(entry.source_url)
    local_book = book_source.book if book_source and book_source.book_id else None
    latest_submission = submission_map.get(entry.source_url)
    latest_job = local_book.processing_jobs.first() if local_book else latest_processing_job_for_submission(latest_submission)
    is_requeued = bool(latest_submission and (latest_submission.raw_payload or {}).get("requeued"))

    if local_book and local_book.deleted_at:
        status = "deleted"
    elif latest_job and latest_job.status in {JobStatus.QUEUED, JobStatus.PROCESSING}:
        status = "processing"
    elif latest_submission and latest_submission.status in {
        "pending_resolution",
        "queued",
        "processing",
    }:
        status = "processing"
    elif latest_job and latest_job.status == JobStatus.CANCELLED:
        status = "stopped"
    elif latest_submission and latest_submission.status == "cancelled":
        status = "stopped"
    elif is_requeued:
        status = "requeued"
    elif latest_job and latest_job.status == JobStatus.FAILED:
        status = "failed"
    elif latest_submission and latest_submission.status in {"failed", "needs_review", "duplicate"}:
        status = "failed"
    elif not local_book:
        status = "new"
    elif local_book.state != LifecycleState.READY or not book_has_required_assets(local_book):
        status = "unfinished"
    else:
        status = "ready"

    return {
        "entry": entry,
        "book_source": book_source,
        "local_book": local_book,
        "latest_submission": latest_submission,
        "latest_job": latest_job,
        "curation_status": status,
        "activity_at": latest_activity_at(entry, latest_submission, latest_job, local_book),
    }


def serialize_source_catalog_entry_inspection(inspection):
    entry = inspection["entry"]
    local_book = inspection["local_book"]
    latest_submission = inspection["latest_submission"]
    latest_job = inspection["latest_job"]
    raw_data = entry.raw_data or {}
    source_categories = (raw_data.get("category") or raw_data.get("book_type") or "").strip()
    local_categories = ""
    if local_book and not local_book.deleted_at:
        local_categories = ", ".join(
            relation.category.name
            for relation in local_book.book_categories.all()
            if relation.category_id and relation.category and relation.category.name
        )
    return {
        "id": str(entry.id),
        "title": entry.title,
        "author_line": entry.author_line,
        "categories": source_categories or local_categories,
        "source_url": entry.source_url,
        "created_at": entry.created_at,
        "last_seen_at": entry.last_seen_at,
        "curation_status": inspection["curation_status"],
        "local_book_slug": local_book.slug if local_book and not local_book.deleted_at else "",
        "local_book_title": local_book.title if local_book and not local_book.deleted_at else "",
        "local_book_state": local_book.state if local_book and not local_book.deleted_at else "",
        "latest_submission_status": latest_submission.status if latest_submission else "",
        "latest_job_status": latest_job.status if latest_job else "",
        "latest_job_error": latest_job.last_error if latest_job else "",
        "activity_at": inspection["activity_at"],
        "updated_at": local_book.updated_at if local_book and not local_book.deleted_at else None,
    }


def summarize_source_catalog_snapshots(snapshots):
    summary = Counter(snapshot["curation_status"] for snapshot in snapshots)
    return {
        "total": len(snapshots),
        "new": summary.get("new", 0),
        "processing": summary.get("processing", 0),
        "requeued": summary.get("requeued", 0),
        "stopped": summary.get("stopped", 0),
        "unfinished": summary.get("unfinished", 0),
        "failed": summary.get("failed", 0),
        "ready": summary.get("ready", 0),
        "deleted": summary.get("deleted", 0),
    }


def source_catalog_entry_snapshots(queryset):
    entries = list(queryset)
    source_map = source_catalog_book_source_map([entry.source_url for entry in entries])
    submission_map = source_catalog_submission_map([entry.source_url for entry in entries])
    inspections = [inspect_source_catalog_entry(entry, source_map, submission_map) for entry in entries]
    snapshots = [serialize_source_catalog_entry_inspection(inspection) for inspection in inspections]
    return snapshots, summarize_source_catalog_snapshots(snapshots)


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
            "requeued": 0,
            "stopped": 0,
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
    local_book = inspection["local_book"]
    return (local_book is None or bool(local_book.deleted_at)) and inspection["curation_status"] in {"new", "failed", "deleted"}


def should_retry_failed_entry(inspection, now=None):
    if inspection["curation_status"] != "failed":
        return True

    now = now or timezone.now()
    activity_at = inspection.get("activity_at")
    if activity_at is None:
        return True

    return now - activity_at >= FAILED_AUTOMATION_RETRY_COOLDOWN


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
