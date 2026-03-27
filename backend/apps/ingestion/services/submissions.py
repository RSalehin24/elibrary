import hashlib
import logging
from pathlib import Path

from celery import current_app
from django.conf import settings
from django.core.files import File
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from apps.access.models import PermissionScope, PreviewAccessSession
from apps.catalog.models import (
    Book,
    BookCategory,
    BookContributor,
    BookSeries,
    BookSource,
    Category,
    Contributor,
    GeneratedAsset,
    GeneratedAssetStatus,
    GeneratedAssetType,
    MetadataVersion,
    Series,
    ContributorRole,
)
from apps.catalog.services import (
    find_deleted_book_by_title,
    find_existing_book_by_source_url,
    replace_book_relations,
)
from apps.common.models import AuditLog, LifecycleState, ReviewState
from apps.common.permissions import user_has_scope
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
from apps.common.text import normalize_catalog_text

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


def can_manage_processing_records(user):
    return bool(user.is_staff or user_has_scope(user, [PermissionScope.PROCESSING_MANAGE]))


def ensure_preview_session(user, book, submission=None, allow_guest=False):
    if not user and not allow_guest:
        return None

    filters = {
        "book": book,
        "expires_at__gt": timezone.now(),
    }
    if user:
        filters["user"] = user
    else:
        filters["user__isnull"] = True
        if submission is not None:
            filters["source_submission"] = submission

    existing_session = PreviewAccessSession.objects.filter(**filters).order_by("-created_at").first()
    if existing_session:
        return existing_session
    return PreviewAccessSession.objects.create(
        user=user if user else None,
        book=book,
        source_submission=submission,
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


def primary_source_url_for_book(book):
    source = book.source_urls.order_by("-is_primary", "-created_at").first()
    return source.normalized_source_url if source else ""


def root_submission(submission):
    return submission.canonical_submission or submission


def build_retry_payload(raw_payload, actor, previous_status, previous_error_message):
    next_payload = dict(raw_payload or {})
    next_payload["requeued"] = True
    next_payload["requeued_at"] = timezone.now().isoformat()
    next_payload["requeue_requested_by"] = str(actor.id)
    next_payload["requeue_reason"] = previous_error_message or f"Retry requested from status: {previous_status}."
    for key in RETRY_PAYLOAD_RESET_KEYS:
        next_payload.pop(key, None)
    return next_payload


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
    canonical_submission = root_submission(canonical_submission)
    if submission.pk == canonical_submission.pk:
        return submission

    update_fields = []
    field_names = (
        "resolved_url",
        "resolution_status",
        "resolution_confidence",
        "status",
        "review_state",
        "linked_book",
        "duplicate_of_book",
        "error_message",
    )
    for field_name in field_names:
        canonical_value = getattr(canonical_submission, field_name)
        if getattr(submission, field_name) != canonical_value:
            setattr(submission, field_name, canonical_value)
            update_fields.append(field_name)

    if submission.canonical_submission_id != canonical_submission.id:
        submission.canonical_submission = canonical_submission
        update_fields.append("canonical_submission")

    next_payload = {
        **submission.raw_payload,
        "deduplicated": True,
        "canonical_submission_id": str(canonical_submission.id),
    }
    for key in SUBMISSION_PAYLOAD_KEYS_TO_SHARE:
        if key in canonical_submission.raw_payload:
            next_payload[key] = canonical_submission.raw_payload[key]
    if submission.raw_payload != next_payload:
        submission.raw_payload = next_payload
        update_fields.append("raw_payload")

    if update_fields:
        submission.save(update_fields=[*update_fields, "updated_at"])

    if submission.status == SubmissionStatus.READY and submission.linked_book_id and submission.submitter_id:
        ensure_preview_session(submission.submitter, submission.linked_book, submission=submission)

    return submission


def sync_deduplicated_submissions(submission):
    submission = root_submission(submission)
    for dependent_submission in submission.deduplicated_submissions.select_related("submitter", "linked_book"):
        sync_submission_from_canonical(dependent_submission, submission)


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
    target_title = scraped_data.get("book_title", "")
    normalized_scraped = normalize_scraped_book(scraped_data)
    target_author_names = {
        normalize_catalog_text(entry["name"])
        for entry in normalized_scraped.get("contributors", [])
        if entry.get("role") == ContributorRole.AUTHOR and normalize_catalog_text(entry.get("name", ""))
    }
    target_translator_names = {
        normalize_catalog_text(entry["name"])
        for entry in normalized_scraped.get("contributors", [])
        if entry.get("role") == ContributorRole.TRANSLATOR and normalize_catalog_text(entry.get("name", ""))
    }
    target_category_names = {
        normalize_catalog_text(value)
        for value in normalized_scraped.get("categories", [])
        if normalize_catalog_text(value)
    }
    target_series_names = {
        normalize_catalog_text(value)
        for value in normalized_scraped.get("series", [])
        if normalize_catalog_text(value)
    }

    if not target_title:
        return None

    books = Book.objects.filter(deleted_at__isnull=True).prefetch_related("book_contributors__contributor")
    for book in books:
        if not texts_are_similar(target_title, book.title):
            continue

        existing_author_names = {
            normalize_catalog_text(relation.contributor.name)
            for relation in book.book_contributors.all()
            if relation.role == ContributorRole.AUTHOR and normalize_catalog_text(relation.contributor.name)
        }
        existing_translator_names = {
            normalize_catalog_text(relation.contributor.name)
            for relation in book.book_contributors.all()
            if relation.role == ContributorRole.TRANSLATOR and normalize_catalog_text(relation.contributor.name)
        }
        existing_category_names = {
            normalize_catalog_text(relation.category.name)
            for relation in book.book_categories.all()
            if normalize_catalog_text(relation.category.name)
        }
        existing_series_names = {
            normalize_catalog_text(relation.series.name)
            for relation in book.book_series.all()
            if normalize_catalog_text(relation.series.name)
        }

        if (
            not target_author_names
            or not existing_author_names
            or not target_category_names
            or not existing_category_names
        ):
            continue

        if not (target_category_names & existing_category_names):
            continue

        if target_series_names and not (target_series_names & existing_series_names):
            continue

        if target_translator_names and not (target_translator_names & existing_translator_names):
            continue

        if target_author_names & existing_author_names:
            return book

    return None


def find_exact_existing_book(scraped_data):
    normalized_title = normalize_catalog_text(scraped_data.get("book_title", ""))
    if not normalized_title:
        return None

    candidate_books = (
        Book.objects.filter(
            source_site="ebanglalibrary.com",
            normalized_title=normalized_title,
            deleted_at__isnull=True,
        )
        .prefetch_related("book_contributors__contributor")
        .order_by("-created_at")
    )

    normalized_scraped = normalize_scraped_book(scraped_data)
    target_author_names = {
        normalize_catalog_text(entry["name"])
        for entry in normalized_scraped.get("contributors", [])
        if entry.get("role") == ContributorRole.AUTHOR and normalize_catalog_text(entry.get("name", ""))
    }
    target_translator_names = {
        normalize_catalog_text(entry["name"])
        for entry in normalized_scraped.get("contributors", [])
        if entry.get("role") == ContributorRole.TRANSLATOR and normalize_catalog_text(entry.get("name", ""))
    }
    target_category_names = {
        normalize_catalog_text(value)
        for value in normalized_scraped.get("categories", [])
        if normalize_catalog_text(value)
    }
    target_series_names = {
        normalize_catalog_text(value)
        for value in normalized_scraped.get("series", [])
        if normalize_catalog_text(value)
    }

    if not target_author_names or not target_category_names:
        return None

    for book in candidate_books:
        existing_author_names = {
            normalize_catalog_text(relation.contributor.name)
            for relation in book.book_contributors.all()
            if relation.role == ContributorRole.AUTHOR and normalize_catalog_text(relation.contributor.name)
        }
        existing_translator_names = {
            normalize_catalog_text(relation.contributor.name)
            for relation in book.book_contributors.all()
            if relation.role == ContributorRole.TRANSLATOR and normalize_catalog_text(relation.contributor.name)
        }
        existing_category_names = {
            normalize_catalog_text(relation.category.name)
            for relation in book.book_categories.all()
            if normalize_catalog_text(relation.category.name)
        }
        existing_series_names = {
            normalize_catalog_text(relation.series.name)
            for relation in book.book_series.all()
            if normalize_catalog_text(relation.series.name)
        }

        if not existing_author_names or not existing_category_names:
            continue
        if not (target_category_names & existing_category_names):
            continue
        if target_series_names and not (target_series_names & existing_series_names):
            continue
        if target_translator_names and not (target_translator_names & existing_translator_names):
            continue
        if existing_author_names and target_author_names & existing_author_names:
            return book

    return None


def calculate_checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(8192), b""):
            digest.update(chunk)
    return digest.hexdigest()


def content_type_for_suffix(path):
    suffix = path.suffix.lower()
    if suffix == ".epub":
        return "application/epub+zip"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".html":
        return "text/html"
    return "application/octet-stream"


def resolve_generated_cover_path(output_folder, requested_cover):
    if requested_cover:
        requested_path = Path(str(requested_cover))
        direct_path = requested_path if requested_path.is_absolute() else output_folder / requested_path
        if direct_path.exists():
            return direct_path

        requested_stem = requested_path.stem
        if requested_stem:
            for candidate in sorted(output_folder.glob(f"{requested_stem}.*")):
                if candidate.is_file():
                    return candidate

    for fallback_stem in ("book_cover", "book_image"):
        for candidate in sorted(output_folder.glob(f"{fallback_stem}.*")):
            if candidate.is_file():
                return candidate

    return None


def candidate_asset_paths(scraped_data):
    output_folder = Path(scraped_data["output_folder"])
    epub_path = output_folder / f"{scraped_data['book_title']}.epub"
    if not epub_path.exists():
        epub_candidates = sorted(output_folder.glob("*.epub"))
        epub_path = epub_candidates[0] if epub_candidates else None

    cover_path = resolve_generated_cover_path(output_folder, scraped_data.get("cover", ""))
    return {
        GeneratedAssetType.HTML: output_folder / "book.html",
        GeneratedAssetType.EPUB: epub_path,
        GeneratedAssetType.COVER: cover_path,
    }


def path_is_within(path, root):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def cleanup_staged_asset_files(output_folder, synced_paths):
    if not output_folder:
        return

    output_folder = Path(output_folder)
    if not output_folder.exists() or not output_folder.is_dir():
        return

    media_root = Path(settings.MEDIA_ROOT)
    if path_is_within(output_folder, media_root):
        return

    for path in synced_paths:
        if path.exists() and path_is_within(path, output_folder):
            path.unlink()

    try:
        output_folder.rmdir()
    except OSError:
        pass


def sync_assets(book, job, scraped_data):
    synced_paths = []
    ready_asset_types = set()
    for asset_type, path in candidate_asset_paths(scraped_data).items():
        asset, _ = GeneratedAsset.objects.get_or_create(book=book, asset_type=asset_type)
        if not path or not Path(path).exists():
            asset.status = GeneratedAssetStatus.FAILED
            asset.save()
            continue

        path = Path(path)
        asset.status = GeneratedAssetStatus.READY
        asset.legacy_path = str(path)
        asset.file_size = path.stat().st_size
        asset.content_type = content_type_for_suffix(path)
        asset.checksum = calculate_checksum(path)
        asset.source_job = job
        if asset.file and asset.file.name:
            asset.file.delete(save=False)
        with open(path, "rb") as handle:
            asset.file.save(path.name, File(handle), save=False)
        asset.storage_path = asset.file.name
        asset.legacy_path = ""
        asset.save()
        synced_paths.append(path)
        ready_asset_types.add(asset_type)

    cleanup_staged_asset_files(scraped_data.get("output_folder"), synced_paths)

    missing_required_assets = [
        GENERATED_ASSET_LABELS[asset_type]
        for asset_type in REQUIRED_GENERATED_ASSET_TYPES
        if asset_type not in ready_asset_types
    ]
    if missing_required_assets:
        book.state = LifecycleState.NEEDS_REVIEW
        book.review_state = ReviewState.NEEDS_REVIEW
        book.save(update_fields=["state", "review_state", "updated_at"])
        raise ValueError(f"Missing generated assets: {', '.join(missing_required_assets)}.")


def complete_processed_submission(submission, book, normalized_url, source="scrape"):
    submission.linked_book = book
    submission.duplicate_of_book = None
    submission.resolved_url = normalized_url
    submission.resolution_status = ResolutionStatus.RESOLVED
    submission.resolution_confidence = max(submission.resolution_confidence, 1.0)
    submission.status = SubmissionStatus.READY
    submission.review_state = book.review_state
    submission.error_message = ""
    submission.raw_payload = {
        **submission.raw_payload,
        "normalized_url": normalized_url,
        "linked_book_slug": book.slug,
        "processing_source": source,
        "served_from_database": False,
    }
    submission.save()
    sync_deduplicated_submissions(submission)

    if submission.submitter_id:
        ensure_preview_session(submission.submitter, book, submission=submission)

    AuditLog.objects.create(
        actor=submission.submitter,
        verb="submission.processed",
        target_type="BookSubmission",
        target_id=str(submission.id),
        payload={"book_id": str(book.id), "source": source},
    )


def sync_metadata_relations(book, normalized):
    replace_book_relations(
        book,
        contributors=normalized["contributors"],
        series_names=normalized["series"],
        category_names=normalized["categories"],
    )


def persist_scraped_book(submission, job, scraped_data, target_book=None):
    normalized = normalize_scraped_book(scraped_data)
    cleaned_dedication_html = clean_extracted_dedication_html(scraped_data.get("dedication", ""))
    cover_source_url = scraped_data.get("cover") or ""
    normalized_submission_source_url = normalize_source_url(submission.resolved_url)

    def apply_scraped_fields(book):
        book.deleted_at = None
        book.state = LifecycleState.READY
        book.review_state = ReviewState.PENDING
        book.raw_scraped_metadata = normalized["raw_strings"]
        book.raw_scrape_payload = scraped_data
        book.main_content_html = scraped_data.get("main_content", "")
        book.book_info_html = scraped_data.get("book_info", "")
        book.dedication_html = cleaned_dedication_html
        book.toc = scraped_data.get("toc", [])
        book.content_items = scraped_data.get("content_items", [])
        book.cover_source_url = cover_source_url

    existing_book = target_book or find_deleted_book_by_title(scraped_data["book_title"])
    if existing_book:
        book = existing_book
        apply_scraped_fields(book)
        book.save()
    else:
        create_kwargs = {
            "title": scraped_data["book_title"],
            "state": LifecycleState.READY,
            "review_state": ReviewState.PENDING,
            "raw_scraped_metadata": normalized["raw_strings"],
            "raw_scrape_payload": scraped_data,
            "main_content_html": scraped_data.get("main_content", ""),
            "book_info_html": scraped_data.get("book_info", ""),
            "dedication_html": cleaned_dedication_html,
            "toc": scraped_data.get("toc", []),
            "content_items": scraped_data.get("content_items", []),
            "cover_source_url": cover_source_url,
        }
        try:
            with transaction.atomic():
                book = Book.objects.create(**create_kwargs)
        except IntegrityError:
            if not normalized_submission_source_url:
                raise
            book = find_existing_book_by_source_url(normalized_submission_source_url)
            if book is None:
                raise
            apply_scraped_fields(book)
            book.save()

    sync_metadata_relations(book, normalized)
    BookSource.objects.update_or_create(
        normalized_source_url=normalized_submission_source_url,
        defaults={
            "book": book,
            "source_url": submission.resolved_url,
            "source_title": scraped_data.get("book_title", ""),
            "raw_metadata": normalized["raw_strings"],
        },
    )
    MetadataVersion.objects.create(book=book, snapshot=scraped_data, source="scrape")
    return book


def export_payload_from_book(book, scraped_data):
    author_names = [
        relation.contributor.name
        for relation in book.book_contributors.all()
        if relation.role == ContributorRole.AUTHOR
    ]
    series_names = [relation.series.name for relation in book.book_series.all()]
    category_names = [relation.category.name for relation in book.book_categories.all()]

    return {
        "book_title": book.title,
        "author": author_names or scraped_data.get("author", ""),
        "series": series_names or scraped_data.get("series", ""),
        "book_type": category_names or scraped_data.get("book_type", ""),
        "cover": book.cover_source_url or scraped_data.get("cover") or "",
        "main_content": book.main_content_html or "",
        "book_info": book.book_info_html or "",
        "dedication": book.dedication_html or "",
        "toc": book.toc or [],
        "content_items": book.content_items or [],
        "output_folder": scraped_data["output_folder"],
    }


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
