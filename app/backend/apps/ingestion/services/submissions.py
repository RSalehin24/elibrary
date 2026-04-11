import logging

from celery import current_app
from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from apps.catalog.models import (
    Book,
    BookCategory,
    BookContributor,
    BookSeries,
    Category,
    Contributor,
    GeneratedAssetType,
    Series,
    ContributorRole,
)
from apps.catalog.services import (
    find_deleted_book_by_title,
    find_existing_book_by_source_url,
    replace_book_relations,
)
from apps.common.models import AuditLog, LifecycleState, ReviewState
from apps.common.text import normalize_catalog_text
from apps.ingestion.models import (
    BookSubmission,
    DuplicateReview,
    DuplicateReviewStatus,
    JobStatus,
    JobType,
    MatchCandidate,
    ProcessingJob,
    ProcessingLog,
    ResolutionStatus,
    SubmissionOrigin,
    SubmissionInputType,
    SubmissionStatus,
    TitleResolutionAttempt,
)
from apps.ingestion.services.legacy_adapter import (
    generate_exports,
    load_legacy_config_entries,
    normalize_source_url,
    normalize_text,
    scrape_book,
    texts_are_similar,
    validate_source_url,
)
from apps.ingestion.services.normalization import clean_extracted_dedication_html, normalize_scraped_book, promote_leading_front_matter
from apps.ingestion.services.resolution import (
    TitleResolver,
    fetch_source_page_metadata,
    upsert_source_catalog_entry,
)
from apps.ingestion.services.submissions_support.assets import (
    calculate_checksum,
    candidate_asset_paths,
    cleanup_staged_asset_files,
    content_type_for_suffix,
    path_is_within,
    resolve_generated_cover_path,
    sync_assets as _sync_assets,
)
from apps.ingestion.services.submissions_support.detection import (
    detect_metadata_duplicate as _detect_metadata_duplicate,
    find_exact_existing_book as _find_exact_existing_book,
)
from apps.ingestion.services.submissions_support.persistence import (
    complete_processed_submission as _complete_processed_submission,
    export_payload_from_book,
    persist_scraped_book as _persist_scraped_book,
    sync_metadata_relations as _sync_metadata_relations,
)
from apps.ingestion.services.submissions_support.preview import (
    can_manage_processing_records,
    ensure_preview_session,
)
from apps.ingestion.services.submissions_support.sync import (
    build_retry_payload,
    primary_source_url_for_book,
    root_submission,
    sync_deduplicated_submissions as _sync_deduplicated_submissions,
    sync_submission_from_canonical as _sync_submission_from_canonical,
)

logger = logging.getLogger(__name__)

REUSABLE_SUBMISSION_STATUSES = (
    SubmissionStatus.PENDING_RESOLUTION,
    SubmissionStatus.QUEUED,
    SubmissionStatus.PROCESSING,
    SubmissionStatus.READY,
)

SUBMISSION_PAYLOAD_KEYS_TO_SHARE = (
    "served_from_database",
    "existing_book_source",
    "linked_book_slug",
    "source_page_metadata",
    "normalized_url",
    "scraped_preview",
)

ACTIVE_JOB_STATUSES = (JobStatus.QUEUED, JobStatus.PROCESSING)
JOB_CANCEL_MESSAGE = "Stopped by user."
REQUIRED_GENERATED_ASSET_TYPES = (GeneratedAssetType.HTML, GeneratedAssetType.EPUB)
GENERATED_ASSET_LABELS = {
    GeneratedAssetType.HTML: "HTML",
    GeneratedAssetType.EPUB: "EPUB",
}
RETRY_PAYLOAD_RESET_KEYS = (
    "served_from_database",
    "existing_book_source",
    "linked_book_slug",
)


def record_job_log(job, level, message, details=None):
    return ProcessingLog.objects.create(
        job=job,
        level=level,
        message=message,
        details=details or {},
    )


def revoke_processing_task(task_id, *, terminate=False):
    if not task_id:
        return
    try:
        current_app.control.revoke(task_id, terminate=terminate)
    except Exception:
        logger.warning("Failed to revoke processing task.", exc_info=True)


def reprocess_target_book_for_job(job):
    reprocess_book_id = job.payload.get("reprocess_book_id") or job.book_id or job.submission.linked_book_id
    if not reprocess_book_id:
        return None
    return Book.objects.filter(pk=reprocess_book_id).first()


def finalize_cancelled_job(job, message=JOB_CANCEL_MESSAGE):
    submission = job.submission
    submission.status = SubmissionStatus.CANCELLED
    submission.error_message = message
    submission.save(update_fields=["status", "error_message", "updated_at"])
    sync_deduplicated_submissions(submission)

    if job.job_type == JobType.REPROCESS:
        reprocess_book = reprocess_target_book_for_job(job)
        previous_book_state = job.payload.get("previous_book_state")
        if reprocess_book is not None and previous_book_state:
            reprocess_book.state = previous_book_state
            reprocess_book.save(update_fields=["state", "updated_at"])

    job.status = JobStatus.CANCELLED
    job.cancel_requested = False
    job.last_error = message
    job.finished_at = timezone.now()
    job.save(update_fields=["status", "cancel_requested", "last_error", "finished_at", "updated_at"])
    record_job_log(job, "warning", message)
    return job


def cancel_processing_job(job, message=JOB_CANCEL_MESSAGE):
    job = ProcessingJob.objects.select_related("submission").get(pk=job.pk)
    if job.status in {JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED}:
        return job

    job.cancel_requested = True
    job.save(update_fields=["cancel_requested", "updated_at"])
    if job.status in {JobStatus.QUEUED, JobStatus.PROCESSING}:
        revoke_processing_task(job.task_id, terminate=job.status == JobStatus.PROCESSING)
        return finalize_cancelled_job(job, message=message)
    record_job_log(job, "warning", "Stop requested.")
    return job


def resume_processing_job(job):
    job = ProcessingJob.objects.select_related("submission").get(pk=job.pk)
    if job.status not in {JobStatus.QUEUED, JobStatus.CANCELLED}:
        raise ValueError("Only queued or stopped jobs can be resumed.")
    if job.status == JobStatus.CANCELLED:
        job.status = JobStatus.QUEUED
        job.cancel_requested = False
        job.task_id = ""
        job.queue_name = ""
        job.last_error = ""
        job.started_at = None
        job.finished_at = None
        job.save(
            update_fields=[
                "status",
                "cancel_requested",
                "task_id",
                "queue_name",
                "last_error",
                "started_at",
                "finished_at",
                "updated_at",
            ]
        )
        if job.submission.status == SubmissionStatus.CANCELLED:
            job.submission.status = SubmissionStatus.QUEUED
            job.submission.error_message = ""
            job.submission.save(update_fields=["status", "error_message", "updated_at"])
            sync_deduplicated_submissions(job.submission)
    if job.cancel_requested:
        raise ValueError("This job has a pending stop request.")
    dispatch_processing_job(job, force=True)
    return job


def recover_stale_processing_jobs(*, origin="", limit=50):
    queryset = (
        ProcessingJob.objects.select_related("submission")
        .filter(status=JobStatus.QUEUED, cancel_requested=False)
        .filter(Q(task_id="") | Q(task_id__isnull=True))
        .order_by("created_at")
    )
    if origin:
        queryset = queryset.filter(submission__origin=origin)

    recovered = 0
    for job in queryset[:limit]:
        dispatch_processing_job(job, force=True)
        recovered += 1
    return recovered


def capture_source_page_metadata(source_url):
    try:
        metadata = fetch_source_page_metadata(source_url)
    except Exception:
        return None

    upsert_source_catalog_entry(metadata)
    return metadata


def retry_submission_record(submission, actor):
    target_submission = root_submission(submission)
    can_manage_processing = can_manage_processing_records(actor)
    if not actor.is_staff and not can_manage_processing and submission.submitter_id != actor.id:
        raise PermissionDenied("You cannot retry this submission.")
    if not target_submission.resolved_url and target_submission.input_type != "title":
        raise ValueError("This submission does not have a resolved URL yet.")

    previous_status = target_submission.status
    previous_error_message = (target_submission.error_message or "").strip()
    update_fields = []

    if target_submission.linked_book_id and target_submission.linked_book and target_submission.linked_book.deleted_at:
        target_submission.linked_book = None
        update_fields.append("linked_book")
    if target_submission.duplicate_of_book_id and (
        not target_submission.duplicate_of_book or target_submission.duplicate_of_book.deleted_at
    ):
        target_submission.duplicate_of_book = None
        update_fields.append("duplicate_of_book")
    if target_submission.error_message:
        target_submission.error_message = ""
        update_fields.append("error_message")

    next_payload = build_retry_payload(
        target_submission.raw_payload,
        actor,
        previous_status,
        previous_error_message,
        RETRY_PAYLOAD_RESET_KEYS,
    )
    if next_payload != (target_submission.raw_payload or {}):
        target_submission.raw_payload = next_payload
        update_fields.append("raw_payload")

    if target_submission.review_state != ReviewState.PENDING:
        target_submission.review_state = ReviewState.PENDING
        update_fields.append("review_state")
    if target_submission.status not in {SubmissionStatus.QUEUED, SubmissionStatus.PROCESSING}:
        target_submission.status = SubmissionStatus.QUEUED
        update_fields.append("status")

    if update_fields:
        target_submission.save(update_fields=[*dict.fromkeys(update_fields), "updated_at"])
        sync_deduplicated_submissions(target_submission)

    return queue_submission(target_submission, actor=actor)


def retry_submission_records(submissions, actor):
    queued_count = 0
    skipped_invalid = 0
    skipped_duplicate_targets = 0
    seen_target_ids = set()

    for submission in submissions:
        target_id = str(submission.canonical_submission_id or submission.id)
        if target_id in seen_target_ids:
            skipped_duplicate_targets += 1
            continue
        seen_target_ids.add(target_id)

        try:
            retry_submission_record(submission, actor)
        except ValueError:
            skipped_invalid += 1
            continue

        queued_count += 1

    return {
        "queued_count": queued_count,
        "skipped_invalid": skipped_invalid,
        "skipped_duplicate_targets": skipped_duplicate_targets,
    }


def sync_submission_from_canonical(submission, canonical_submission):
    return _sync_submission_from_canonical(
        submission,
        canonical_submission,
        ensure_preview_session_callback=ensure_preview_session,
        root_submission_callback=root_submission,
        shared_payload_keys=SUBMISSION_PAYLOAD_KEYS_TO_SHARE,
        submission_status=SubmissionStatus,
    )


def sync_deduplicated_submissions(submission):
    return _sync_deduplicated_submissions(
        submission,
        root_submission_callback=root_submission,
        sync_submission_from_canonical_callback=sync_submission_from_canonical,
    )


def find_reusable_submission(*, normalized_input="", resolved_url="", exclude_submission_id=None):
    queryset = BookSubmission.objects.select_related(
        "linked_book",
        "duplicate_of_book",
        "submitter",
    ).filter(
        canonical_submission__isnull=True,
        status__in=REUSABLE_SUBMISSION_STATUSES,
    ).filter(
        Q(linked_book__isnull=True) | Q(linked_book__deleted_at__isnull=True),
        Q(duplicate_of_book__isnull=True) | Q(duplicate_of_book__deleted_at__isnull=True),
    )
    if exclude_submission_id:
        queryset = queryset.exclude(pk=exclude_submission_id)

    if resolved_url:
        submission = queryset.filter(resolved_url=resolved_url).order_by("-created_at").first()
        if submission:
            return submission

    if normalized_input:
        submission = queryset.filter(normalized_input=normalized_input).order_by("-created_at").first()
        if submission:
            return submission

    return None


def create_local_resolution_attempt(submission, book, confidence=1.0):
    return TitleResolutionAttempt.objects.create(
        submission=submission,
        query=submission.original_input,
        normalized_query=submission.normalized_input,
        status=ResolutionStatus.RESOLVED,
        confidence=confidence,
        resolved_url=primary_source_url_for_book(book),
        raw_results={
            "source": "local_database",
            "book_id": str(book.id),
            "book_slug": book.slug,
        },
    )


def fulfill_submission_with_existing_book(
    submission,
    book,
    source,
    confidence=1.0,
    resolution_status=ResolutionStatus.RESOLVED,
    resolved_url="",
):
    if not resolved_url:
        resolved_url = primary_source_url_for_book(book)

    submission.linked_book = book
    submission.resolved_url = resolved_url
    submission.resolution_status = resolution_status
    submission.resolution_confidence = confidence
    submission.status = SubmissionStatus.READY
    submission.review_state = book.review_state
    submission.error_message = ""
    submission.raw_payload = {
        **submission.raw_payload,
        "served_from_database": True,
        "existing_book_source": source,
        "linked_book_slug": book.slug,
    }
    submission.save()
    sync_deduplicated_submissions(submission)

    ensure_preview_session(submission.submitter, book, submission=submission)
    AuditLog.objects.create(
        actor=submission.submitter,
        verb="submission.fulfilled_from_database",
        target_type="BookSubmission",
        target_id=str(submission.id),
        payload={"book_id": str(book.id), "source": source},
    )
    return submission


def resolve_submission(submission, force_refresh=False):
    resolver = TitleResolver()
    result = resolver.resolve(submission.original_input, refresh_catalog=force_refresh)
    attempt = TitleResolutionAttempt.objects.create(
        submission=submission,
        query=submission.original_input,
        normalized_query=submission.normalized_input,
        status=result.status,
        confidence=result.confidence,
        resolved_url=result.resolved_url,
        raw_results=result.raw,
    )

    for index, candidate in enumerate(result.candidates, start=1):
        MatchCandidate.objects.create(
            resolution_attempt=attempt,
            rank=index,
            candidate_title=candidate["title"],
            candidate_author=candidate.get("author", ""),
            candidate_url=candidate["url"],
            confidence=candidate["confidence"],
            metadata={"title": candidate["title"], "author": candidate.get("author", "")},
        )

    if result.status == "exact_match":
        submission.resolved_url = result.resolved_url
        submission.resolution_status = ResolutionStatus.EXACT_MATCH
        submission.resolution_confidence = result.confidence
        submission.status = SubmissionStatus.QUEUED
    elif result.status == "ambiguous":
        submission.resolution_status = ResolutionStatus.AMBIGUOUS
        submission.resolution_confidence = result.confidence
        submission.status = SubmissionStatus.NEEDS_REVIEW
        submission.review_state = ReviewState.NEEDS_REVIEW
    else:
        submission.resolution_status = ResolutionStatus.UNRESOLVED
        submission.status = SubmissionStatus.NEEDS_REVIEW
        submission.review_state = ReviewState.NEEDS_REVIEW
        submission.error_message = "No confident catalog match was found."

    submission.save()
    sync_deduplicated_submissions(submission)
    return submission


def queue_submission(submission, actor=None):
    submission = root_submission(submission)
    existing_job = submission.processing_jobs.filter(status__in=ACTIVE_JOB_STATUSES).first()
    if existing_job:
        return existing_job

    job = ProcessingJob.objects.create(
        submission=submission,
        job_type=JobType.INGESTION,
        status=JobStatus.QUEUED,
        payload={
            "resolved_url": submission.resolved_url,
            "actor_id": getattr(actor, "id", None),
        },
    )
    submission.status = SubmissionStatus.QUEUED
    submission.save(update_fields=["status", "updated_at"])
    sync_deduplicated_submissions(submission)

    dispatch_processing_job(job)
    return job


def dispatch_processing_job(job, force=False):
    from apps.ingestion.tasks import process_submission_task

    job.refresh_from_db(fields=["status", "task_id", "queue_name", "cancel_requested", "updated_at"])
    if job.status == JobStatus.CANCELLED or job.cancel_requested:
        return job
    if not force and job.status == JobStatus.QUEUED and job.task_id:
        return job

    try:
        async_result = process_submission_task.delay(str(job.id))
        job.task_id = getattr(async_result, "id", "")
        job.queue_name = "celery"
        job.save(update_fields=["task_id", "queue_name", "updated_at"])
    except Exception as exc:
        logger.warning("Celery dispatch failed, falling back to inline processing", exc_info=True)
        job.queue_name = "inline-fallback"
        job.last_error = f"Celery dispatch failed: {exc}"
        job.save(update_fields=["queue_name", "last_error", "updated_at"])
        record_job_log(
            job,
            "warning",
            "Celery dispatch failed, processing inline instead.",
            {"error": str(exc), "always_eager": settings.CELERY_TASK_ALWAYS_EAGER},
        )
        process_submission_job(str(job.id), retry_count=job.retry_count, task_id="")
        job.refresh_from_db()


def queue_reprocess_book(book, actor=None, origin=SubmissionOrigin.USER):
    existing_job = book.processing_jobs.filter(status__in=ACTIVE_JOB_STATUSES).first()
    if existing_job:
        return existing_job, False

    resolved_url = normalize_source_url(primary_source_url_for_book(book))
    submission = BookSubmission.objects.create(
        submitter=actor if getattr(actor, "is_authenticated", False) else None,
        input_type=SubmissionInputType.URL,
        origin=origin,
        original_input=resolved_url,
        normalized_input=normalize_text(resolved_url),
        resolved_url=resolved_url,
        resolution_status=ResolutionStatus.RESOLVED,
        resolution_confidence=1.0,
        status=SubmissionStatus.QUEUED,
        review_state=book.review_state,
        linked_book=book,
        raw_payload={
            "submitted_publicly": False,
            "reprocess_book_id": str(book.id),
        },
    )
    job = ProcessingJob.objects.create(
        submission=submission,
        book=book,
        job_type=JobType.REPROCESS,
        status=JobStatus.QUEUED,
        payload={
            "resolved_url": resolved_url,
            "actor_id": getattr(actor, "id", None),
            "reprocess_book_id": str(book.id),
            "previous_book_state": book.state,
        },
    )
    book.state = LifecycleState.PROCESSING
    book.save(update_fields=["state", "updated_at"])

    dispatch_processing_job(job)
    return job, True


def create_submission_records(submitter, parsed_entries, auto_process=True, origin=SubmissionOrigin.USER):
    submissions = []

    for entry in parsed_entries:
        submission = BookSubmission.objects.create(
            submitter=submitter,
            input_type=entry["kind"],
            origin=origin,
            original_input=entry["value"],
            normalized_input=normalize_text(entry["value"]),
            status=SubmissionStatus.PENDING_RESOLUTION
            if entry["kind"] == "title"
            else SubmissionStatus.QUEUED,
            raw_payload={"submitted_publicly": submitter is None},
        )

        AuditLog.objects.create(
            actor=submitter,
            verb="submission.created",
            target_type="BookSubmission",
            target_id=str(submission.id),
            payload={"input_type": submission.input_type},
        )

        if entry["kind"] == "url":
            try:
                submission.resolved_url = validate_source_url(entry["value"])
                reusable_submission = find_reusable_submission(
                    resolved_url=submission.resolved_url,
                    exclude_submission_id=submission.id,
                )
                if reusable_submission:
                    sync_submission_from_canonical(submission, reusable_submission)
                    submissions.append(submission)
                    continue
                source_metadata = capture_source_page_metadata(submission.resolved_url)
                if source_metadata:
                    submission.raw_payload = {
                        **submission.raw_payload,
                        "source_page_metadata": source_metadata["raw_data"],
                    }
                existing_book = find_existing_book_by_source_url(submission.resolved_url)
                if existing_book:
                    fulfill_submission_with_existing_book(
                        submission,
                        existing_book,
                        source="source_url",
                        confidence=1.0,
                    )
                    submissions.append(submission)
                    continue
                submission.resolution_status = ResolutionStatus.RESOLVED
                submission.resolution_confidence = 1.0
                submission.status = SubmissionStatus.QUEUED
                submission.save()
            except ValueError as exc:
                submission.resolution_status = ResolutionStatus.INVALID
                submission.status = SubmissionStatus.NEEDS_REVIEW
                submission.review_state = ReviewState.NEEDS_REVIEW
                submission.error_message = str(exc)
                submission.save()
        else:
            reusable_submission = find_reusable_submission(
                normalized_input=submission.normalized_input,
                exclude_submission_id=submission.id,
            )
            if reusable_submission:
                sync_submission_from_canonical(submission, reusable_submission)
                submissions.append(submission)
                continue

            resolve_submission(submission)
            if submission.resolved_url:
                reusable_submission = find_reusable_submission(
                    resolved_url=submission.resolved_url,
                    exclude_submission_id=submission.id,
                )
                if reusable_submission:
                    sync_submission_from_canonical(submission, reusable_submission)
                    submissions.append(submission)
                    continue
                existing_book = find_existing_book_by_source_url(submission.resolved_url)
                if existing_book:
                    fulfill_submission_with_existing_book(
                        submission,
                        existing_book,
                        source="resolved_source_url",
                        confidence=submission.resolution_confidence,
                        resolution_status=submission.resolution_status,
                        resolved_url=submission.resolved_url,
                    )
                    submissions.append(submission)
                    continue

        if auto_process and submission.resolved_url and submission.status == SubmissionStatus.QUEUED:
            queue_submission(submission, actor=submitter)
            submission.refresh_from_db()

        submissions.append(submission)

    return submissions


def detect_metadata_duplicate(scraped_data):
    return _detect_metadata_duplicate(
        scraped_data,
        normalize_scraped_book_fn=normalize_scraped_book,
        texts_are_similar_fn=texts_are_similar,
    )


def find_exact_existing_book(scraped_data):
    return _find_exact_existing_book(
        scraped_data,
        normalize_scraped_book_fn=normalize_scraped_book,
    )


def sync_assets(book, job, scraped_data):
    return _sync_assets(
        book,
        job,
        scraped_data,
        generated_asset_labels=GENERATED_ASSET_LABELS,
        required_asset_types=REQUIRED_GENERATED_ASSET_TYPES,
    )


def complete_processed_submission(submission, book, normalized_url, source="scrape"):
    return _complete_processed_submission(
        submission,
        book,
        normalized_url,
        ensure_preview_session_fn=ensure_preview_session,
        source=source,
        sync_deduplicated_submissions_fn=sync_deduplicated_submissions,
    )


def sync_metadata_relations(book, normalized):
    return _sync_metadata_relations(
        book,
        normalized,
        replace_book_relations_fn=replace_book_relations,
    )


def persist_scraped_book(submission, job, scraped_data, target_book=None):
    return _persist_scraped_book(
        submission,
        scraped_data,
        clean_extracted_dedication_html_fn=clean_extracted_dedication_html,
        find_deleted_book_by_title_fn=find_deleted_book_by_title,
        find_existing_book_by_source_url_fn=find_existing_book_by_source_url,
        job=job,
        normalize_scraped_book_fn=normalize_scraped_book,
        normalize_source_url_fn=normalize_source_url,
        sync_metadata_relations_fn=sync_metadata_relations,
        target_book=target_book,
    )


def cancel_requested_for_job(job):
    job.refresh_from_db(fields=["status", "cancel_requested", "updated_at"])
    return job.status == JobStatus.CANCELLED or job.cancel_requested


def process_submission_job(job_id, retry_count=0, task_id=""):
    job = ProcessingJob.objects.select_related("submission", "submission__submitter", "book").get(pk=job_id)
    submission = job.submission
    reprocess_book = None
    if job.status == JobStatus.SUCCEEDED:
        return job
    if job.status == JobStatus.CANCELLED:
        return job
    if job.cancel_requested:
        return finalize_cancelled_job(job)
    job.status = JobStatus.PROCESSING
    job.retry_count = retry_count
    job.task_id = task_id or job.task_id
    job.started_at = timezone.now()
    job.save(update_fields=["status", "retry_count", "task_id", "started_at", "updated_at"])

    submission.status = SubmissionStatus.PROCESSING
    submission.save(update_fields=["status", "updated_at"])
    sync_deduplicated_submissions(submission)
    record_job_log(job, "info", "Started processing submission.", {"submission_id": str(submission.id)})

    try:
        if cancel_requested_for_job(job):
            return finalize_cancelled_job(job)
        if not submission.resolved_url and submission.input_type == "title":
            resolve_submission(submission, force_refresh=True)
            if not submission.resolved_url:
                job.status = JobStatus.SUCCEEDED
                job.finished_at = timezone.now()
                job.save(update_fields=["status", "finished_at", "updated_at"])
                record_job_log(job, "warning", "Submission requires review before processing can continue.")
                sync_deduplicated_submissions(submission)
                return job

        normalized_url = normalize_source_url(submission.resolved_url)
        if job.job_type == JobType.REPROCESS:
            reprocess_book_id = job.payload.get("reprocess_book_id") or job.book_id or submission.linked_book_id
            reprocess_book = Book.objects.filter(pk=reprocess_book_id, deleted_at__isnull=True).first()
            if reprocess_book is None:
                raise ValueError("The target book for regeneration is unavailable.")

        if cancel_requested_for_job(job):
            return finalize_cancelled_job(job)
        source_page_metadata = capture_source_page_metadata(normalized_url)
        if source_page_metadata:
            submission.raw_payload = {
                **submission.raw_payload,
                "source_page_metadata": source_page_metadata["raw_data"],
            }
            submission.save(update_fields=["raw_payload", "updated_at"])
        source_duplicate = None if reprocess_book else find_existing_book_by_source_url(normalized_url)
        if source_duplicate:
            fulfill_submission_with_existing_book(
                submission,
                source_duplicate,
                source="processing_source_url",
                confidence=1.0,
                resolved_url=normalized_url,
            )
            DuplicateReview.objects.get_or_create(
                submission=submission,
                existing_book=source_duplicate,
                defaults={
                    "detected_by": "exact_source_url",
                    "status": DuplicateReviewStatus.CONFIRMED,
                    "raw_evidence": {"resolved_url": normalized_url},
                },
            )
            record_job_log(job, "info", "Submission matched an existing book by exact source URL.")
            job.book = source_duplicate
            job.status = JobStatus.SUCCEEDED
            job.finished_at = timezone.now()
            job.save(update_fields=["book", "status", "finished_at", "updated_at"])
            return job

        if cancel_requested_for_job(job):
            return finalize_cancelled_job(job)
        scraped_data = scrape_book(submission.resolved_url)
        if not isinstance(scraped_data, dict):
            raise ValueError(
                f"Source scraping returned no content for {submission.resolved_url}. "
                "Verify the source URL is valid and publicly reachable."
            )
        promoted_book_info, cleaned_main_content = promote_leading_front_matter(
            scraped_data.get("book_info", ""),
            scraped_data.get("main_content", ""),
        )
        scraped_data["book_info"] = promoted_book_info
        scraped_data["main_content"] = cleaned_main_content
        record_job_log(job, "info", "Scraped source content.", {"title": scraped_data.get("book_title", "")})
        if cancel_requested_for_job(job):
            return finalize_cancelled_job(job)
        exact_title_duplicate = None if reprocess_book else find_exact_existing_book(scraped_data)
        if exact_title_duplicate:
            fulfill_submission_with_existing_book(
                submission,
                exact_title_duplicate,
                source="processing_title_match",
                confidence=1.0,
                resolved_url=normalized_url,
            )
            DuplicateReview.objects.get_or_create(
                submission=submission,
                existing_book=exact_title_duplicate,
                defaults={
                    "detected_by": "exact_normalized_title",
                    "status": DuplicateReviewStatus.CONFIRMED,
                    "raw_evidence": {
                        "book_title": scraped_data.get("book_title", ""),
                        "resolved_url": normalized_url,
                    },
                },
            )
            record_job_log(job, "info", "Submission matched an existing book by exact normalized title.")
            job.book = exact_title_duplicate
            job.status = JobStatus.SUCCEEDED
            job.finished_at = timezone.now()
            job.save(update_fields=["book", "status", "finished_at", "updated_at"])
            return job

        metadata_duplicate = None if reprocess_book else detect_metadata_duplicate(scraped_data)
        if metadata_duplicate:
            submission.duplicate_of_book = metadata_duplicate
            submission.status = SubmissionStatus.DUPLICATE
            submission.review_state = ReviewState.NEEDS_REVIEW
            submission.raw_payload = {
                **submission.raw_payload,
                "scraped_preview": {
                    "book_title": scraped_data.get("book_title", ""),
                    "author": scraped_data.get("author", ""),
                },
            }
            submission.save()
            sync_deduplicated_submissions(submission)
            DuplicateReview.objects.create(
                submission=submission,
                existing_book=metadata_duplicate,
                detected_by="normalized_metadata",
                status=DuplicateReviewStatus.PENDING,
                raw_evidence=submission.raw_payload["scraped_preview"],
            )
            record_job_log(job, "warning", "Potential duplicate detected by normalized metadata.")
            job.book = metadata_duplicate
            job.status = JobStatus.SUCCEEDED
            job.finished_at = timezone.now()
            job.save(update_fields=["book", "status", "finished_at", "updated_at"])
            return job

        book = persist_scraped_book(submission, job, scraped_data, target_book=reprocess_book)
        export_payload = export_payload_from_book(book, scraped_data)
        generate_exports(export_payload)
        sync_assets(book, job, export_payload)
        record_job_log(job, "info", "Generated HTML and EPUB exports from canonical book data.")
        complete_processed_submission(
            submission,
            book,
            normalized_url,
            source="reprocess" if reprocess_book else "scrape",
        )
        job.book = book
        job.status = JobStatus.SUCCEEDED
        job.finished_at = timezone.now()
        job.save(update_fields=["book", "status", "finished_at", "updated_at"])
        record_job_log(
            job,
            "info",
            "Submission finished successfully.",
            {"book_id": str(book.id), "job_type": job.job_type},
        )
        return job
    except Exception as exc:
        logger.exception("Submission processing failed", extra={"submission_id": str(submission.id)})
        submission.status = SubmissionStatus.FAILED
        submission.error_message = str(exc)
        submission.save(update_fields=["status", "error_message", "updated_at"])
        sync_deduplicated_submissions(submission)
        if reprocess_book is not None:
            previous_book_state = job.payload.get("previous_book_state")
            if previous_book_state:
                reprocess_book.state = previous_book_state
                reprocess_book.save(update_fields=["state", "updated_at"])
        job.status = JobStatus.FAILED
        job.last_error = str(exc)
        job.finished_at = timezone.now()
        job.save(update_fields=["status", "last_error", "finished_at", "updated_at"])
        record_job_log(job, "error", "Submission processing failed.", {"error": str(exc)})
        raise


def legacy_config_entries_as_submission_inputs():
    return [{"kind": "url", "value": url, "label": name} for name, url in load_legacy_config_entries()]
