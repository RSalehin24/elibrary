import hashlib
import logging
from pathlib import Path

from django.conf import settings
from django.core.files import File
from django.db import transaction
from django.utils import timezone

from apps.access.models import PreviewAccessSession
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
)
from apps.catalog.services import (
    find_existing_book_by_source_url,
    find_existing_book_by_title,
    replace_book_relations,
)
from apps.common.models import AuditLog, LifecycleState, ReviewState
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
from apps.ingestion.services.normalization import normalize_scraped_book
from apps.ingestion.services.resolution import (
    TitleResolver,
    fetch_source_page_metadata,
    upsert_source_catalog_entry,
)

logger = logging.getLogger(__name__)

REUSABLE_SUBMISSION_STATUSES = (
    SubmissionStatus.PENDING_RESOLUTION,
    SubmissionStatus.QUEUED,
    SubmissionStatus.PROCESSING,
    SubmissionStatus.NEEDS_REVIEW,
    SubmissionStatus.READY,
    SubmissionStatus.DUPLICATE,
)

SUBMISSION_PAYLOAD_KEYS_TO_SHARE = (
    "served_from_database",
    "existing_book_source",
    "linked_book_slug",
    "source_page_metadata",
    "normalized_url",
    "scraped_preview",
)


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
    existing_job = submission.processing_jobs.filter(status__in=[JobStatus.QUEUED, JobStatus.PROCESSING]).first()
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

    from apps.ingestion.tasks import process_submission_task

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
    return job


def create_submission_records(submitter, parsed_entries, auto_process=True):
    submissions = []

    for entry in parsed_entries:
        submission = BookSubmission.objects.create(
            submitter=submitter,
            input_type=entry["kind"],
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
            existing_book = find_existing_book_by_title(entry["value"])
            if existing_book:
                create_local_resolution_attempt(submission, existing_book, confidence=1.0)
                fulfill_submission_with_existing_book(
                    submission,
                    existing_book,
                    source="title_match",
                    confidence=1.0,
                )
                submissions.append(submission)
                continue

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
    target_author = scraped_data.get("author", "")
    books = Book.objects.prefetch_related("book_contributors__contributor")
    for book in books:
        if not texts_are_similar(target_title, book.title):
            continue

        existing_authors = [
            relation.contributor.name
            for relation in book.book_contributors.all()
            if relation.role == "author"
        ]
        if not target_author or not existing_authors:
            return book

        if any(texts_are_similar(target_author, author) for author in existing_authors):
            return book

    return None


def find_exact_existing_book(scraped_data):
    return find_existing_book_by_title(scraped_data.get("book_title", ""))


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


def candidate_asset_paths(scraped_data):
    output_folder = Path(scraped_data["output_folder"])
    epub_path = output_folder / f"{scraped_data['book_title']}.epub"
    if not epub_path.exists():
        epub_candidates = sorted(output_folder.glob("*.epub"))
        epub_path = epub_candidates[0] if epub_candidates else None

    cover_path = output_folder / scraped_data["cover"] if scraped_data.get("cover") else None
    return {
        GeneratedAssetType.HTML: output_folder / "book.html",
        GeneratedAssetType.EPUB: epub_path,
        GeneratedAssetType.COVER: cover_path,
    }


def sync_assets(book, job, scraped_data):
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
        with open(path, "rb") as handle:
            asset.file.save(path.name, File(handle), save=False)
        asset.storage_path = asset.file.name
        asset.save()


def sync_metadata_relations(book, normalized):
    replace_book_relations(
        book,
        contributors=normalized["contributors"],
        series_names=normalized["series"],
        category_names=normalized["categories"],
    )


def persist_scraped_book(submission, job, scraped_data):
    normalized = normalize_scraped_book(scraped_data)
    existing_book = find_existing_book_by_title(scraped_data["book_title"])
    if existing_book:
        book = existing_book
        book.state = LifecycleState.READY
        book.review_state = ReviewState.PENDING
        book.raw_scraped_metadata = normalized["raw_strings"]
        book.raw_scrape_payload = scraped_data
        book.main_content_html = scraped_data.get("main_content", "")
        book.book_info_html = scraped_data.get("book_info", "")
        book.dedication_html = scraped_data.get("dedication", "")
        book.toc = scraped_data.get("toc", [])
        book.cover_source_url = scraped_data.get("cover", "")
        book.save()
    else:
        book = Book.objects.create(
            title=scraped_data["book_title"],
            state=LifecycleState.READY,
            review_state=ReviewState.PENDING,
            raw_scraped_metadata=normalized["raw_strings"],
            raw_scrape_payload=scraped_data,
            main_content_html=scraped_data.get("main_content", ""),
            book_info_html=scraped_data.get("book_info", ""),
            dedication_html=scraped_data.get("dedication", ""),
            toc=scraped_data.get("toc", []),
            cover_source_url=scraped_data.get("cover", ""),
        )
    sync_metadata_relations(book, normalized)
    BookSource.objects.update_or_create(
        normalized_source_url=normalize_source_url(submission.resolved_url),
        defaults={
            "book": book,
            "source_url": submission.resolved_url,
            "source_title": scraped_data.get("book_title", ""),
            "raw_metadata": normalized["raw_strings"],
        },
    )
    MetadataVersion.objects.create(book=book, snapshot=scraped_data, source="scrape")
    sync_assets(book, job, scraped_data)
    return book


@transaction.atomic
def process_submission_job(job_id, retry_count=0, task_id=""):
    job = ProcessingJob.objects.select_related("submission", "submission__submitter").get(pk=job_id)
    submission = job.submission
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
        source_page_metadata = capture_source_page_metadata(normalized_url)
        if source_page_metadata:
            submission.raw_payload = {
                **submission.raw_payload,
                "source_page_metadata": source_page_metadata["raw_data"],
            }
            submission.save(update_fields=["raw_payload", "updated_at"])
        source_duplicate = find_existing_book_by_source_url(normalized_url)
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

        scraped_data = scrape_book(submission.resolved_url)
        record_job_log(job, "info", "Scraped source content.", {"title": scraped_data.get("book_title", "")})
        generate_exports(scraped_data)
        record_job_log(job, "info", "Generated HTML and EPUB exports.")

        exact_title_duplicate = find_exact_existing_book(scraped_data)
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

        metadata_duplicate = detect_metadata_duplicate(scraped_data)
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

        book = persist_scraped_book(submission, job, scraped_data)
        submission.linked_book = book
        submission.status = SubmissionStatus.READY
        submission.review_state = ReviewState.PENDING
        submission.raw_payload = {**submission.raw_payload, "normalized_url": normalized_url}
        submission.save()
        sync_deduplicated_submissions(submission)
        job.book = book
        job.status = JobStatus.SUCCEEDED
        job.finished_at = timezone.now()
        job.save(update_fields=["book", "status", "finished_at", "updated_at"])

        if submission.submitter_id:
            ensure_preview_session(submission.submitter, book, submission=submission)

        AuditLog.objects.create(
            actor=submission.submitter,
            verb="submission.processed",
            target_type="BookSubmission",
            target_id=str(submission.id),
            payload={"book_id": str(book.id)},
        )
        record_job_log(job, "info", "Submission finished successfully.", {"book_id": str(book.id)})
        return job
    except Exception as exc:
        logger.exception("Submission processing failed", extra={"submission_id": str(submission.id)})
        submission.status = SubmissionStatus.FAILED
        submission.error_message = str(exc)
        submission.save(update_fields=["status", "error_message", "updated_at"])
        sync_deduplicated_submissions(submission)
        job.status = JobStatus.FAILED
        job.last_error = str(exc)
        job.finished_at = timezone.now()
        job.save(update_fields=["status", "last_error", "finished_at", "updated_at"])
        record_job_log(job, "error", "Submission processing failed.", {"error": str(exc)})
        raise


def legacy_config_entries_as_submission_inputs():
    return [{"kind": "url", "value": url, "label": name} for name, url in load_legacy_config_entries()]
