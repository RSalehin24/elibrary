

def process_submission_job(job_id, retry_count=0, task_id=""):
    job = ProcessingJob.objects.select_related("submission", "submission__submitter", "book").get(pk=job_id)
    submission = job.submission
    reprocess_book = None
    skip_duplicate_checks = bool((submission.raw_payload or {}).get("skip_duplicate_checks"))
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
            if reprocess_book.state != LifecycleState.PROCESSING:
                reprocess_book.state = LifecycleState.PROCESSING
                reprocess_book.save(update_fields=["state", "updated_at"])

        if cancel_requested_for_job(job):
            return finalize_cancelled_job(job)
        source_page_metadata = capture_source_page_metadata(normalized_url)
        if source_page_metadata:
            submission.raw_payload = {
                **submission.raw_payload,
                "source_page_metadata": source_page_metadata["raw_data"],
            }
            submission.save(update_fields=["raw_payload", "updated_at"])
        source_duplicate = None if reprocess_book or skip_duplicate_checks else find_existing_book_by_source_url(normalized_url)
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
        exact_title_duplicate = None if reprocess_book or skip_duplicate_checks else find_exact_existing_book(scraped_data)
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

        metadata_duplicate = None if reprocess_book or skip_duplicate_checks else detect_metadata_duplicate(scraped_data)
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
        next_retry_count = int(retry_count or 0) + 1
        should_retry = next_retry_count < MAX_PROCESSING_JOB_ATTEMPTS

        if should_retry:
            requeue_processing_job(
                job,
                retry_count=next_retry_count,
                message=PROCESSING_RETRY_MESSAGE_TEMPLATE.format(
                    attempt=next_retry_count,
                    max_attempts=MAX_PROCESSING_JOB_ATTEMPTS,
                ),
                preserve_dispatch_state=bool(task_id or job.task_id),
            )
            raise

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
        job.task_id = ""
        job.queue_name = ""
        job.last_error = str(exc)
        job.finished_at = timezone.now()
        job.save(
            update_fields=[
                "status",
                "task_id",
                "queue_name",
                "last_error",
                "finished_at",
                "updated_at",
            ]
        )
        record_job_log(job, "error", "Submission processing failed.", {"error": str(exc)})
        raise


def legacy_config_entries_as_submission_inputs():
    return [{"kind": "url", "value": url, "label": name} for name, url in load_legacy_config_entries()]
