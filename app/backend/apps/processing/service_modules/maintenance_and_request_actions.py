

def repair_self_linked_duplicate_requests():
    repaired = []
    published_domains = set()
    queryset = (
        BookCreationRequest.objects.filter(
            state=BookCreationRequestState.DUPLICATE,
            linked_book__isnull=False,
            linked_book__deleted_at__isnull=True,
            duplicate_of_request__isnull=True,
            duplicate_of_record__isnull=True,
        )
        .select_related("book_record", "linked_book", "book_record__linked_book")
        .order_by("created_at", "id")
    )

    for processing_request in queryset:
        previous_state = processing_request.state
        record_before = processing_record_snapshot(processing_request.book_record)
        current_book = processing_linked_book(
            processing_request.book_record,
            processing_request,
        )
        if current_book is None or current_book.id != processing_request.linked_book_id:
            continue

        processing_request.state = BookCreationRequestState.CREATED
        processing_request.progress = None
        processing_request.error_message = ""
        processing_request.duplicate_confirmed = False
        processing_request.save(
            update_fields=[
                "state",
                "progress",
                "error_message",
                "duplicate_confirmed",
                "updated_at",
            ]
        )

        record = processing_request.book_record
        record_update_fields = []
        if record.linked_book_id != current_book.id:
            record.linked_book = current_book
            record_update_fields.append("linked_book")
        if record.is_duplicate:
            record.is_duplicate = False
            record_update_fields.append("is_duplicate")
        if record.duplicate_of_record_id:
            record.duplicate_of_record = None
            record_update_fields.append("duplicate_of_record")
        if record_update_fields:
            record.save(update_fields=[*record_update_fields, "updated_at"])

        sync_record_state(record)
        repaired.append(processing_request)
        published_domains.update(
            processing_domains_for_request_change(
                previous_state,
                BookCreationRequestState.CREATED,
                record=record,
            )
            | processing_domains_for_record_change(
                record_before,
                processing_record_snapshot(record),
                current_request_state=BookCreationRequestState.CREATED,
            )
        )

    if published_domains:
        publish_processing_ui_domains(published_domains)
    return repaired


def mark_stale_processing_requests():
    cutoff = timezone.now() - PROCESSING_STALE_AFTER
    stale_requests = list(
        BookCreationRequest.objects.filter(
            state=BookCreationRequestState.PROCESSING,
            updated_at__lt=cutoff,
        ).select_related("book_record")
    )
    recovered = []
    for processing_request in stale_requests:
        recovered_request = _transition_request_state(
            processing_request.id,
            BookCreationRequestState.PROCESSING,
            BookCreationRequestState.QUEUED,
        )
        recovered_request.error_message = ""
        recovered_request.save(update_fields=["error_message", "updated_at"])
        recovered.append(recovered_request)
        queue_processing_request(processing_request)
    return recovered


def run_processing_maintenance():
    recovered = mark_stale_processing_requests()
    repaired = repair_self_linked_duplicate_requests()
    return {
        "recoveredCount": len(recovered),
        "repairedCount": len(repaired),
    }


def run_processing_runtime_tick():
    sync_results = {}
    for sync_key in (PROCESSING_SYNC_KEY_CATALOG, PROCESSING_SYNC_KEY_INCOMPLETE):
        state = get_sync_state(sync_key)
        if state.status in SYNC_ACTIVE_STATUSES:
            sync_results[sync_key] = sync_state_task_payload(
                advance_sync_once(sync_key)
            )
    return {
        "sync": sync_results,
        "advancedCount": advance_pipeline_once(),
    }


def apply_delete_action(processing_request, *, delete_book=False):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    if delete_book and processing_request.linked_book and processing_request.linked_book.deleted_at is None:
        processing_request.linked_book.soft_delete()

    processing_request.state = BookCreationRequestState.DELETED
    processing_request.progress = None
    processing_request.error_message = ""
    processing_request.save(update_fields=["state", "progress", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.DELETED,
            record=processing_request.book_record,
        )
    )
    return processing_request


def apply_pause_action(processing_request):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    saved_data = _request_saved_data(processing_request)
    processing_request.state = BookCreationRequestState.PAUSED
    processing_request.progress = _build_processing_progress(
        _request_progress(processing_request).get("checkpoint") or "Pause requested",
        saved_data,
    )
    processing_request.error_message = ""
    processing_request.save(update_fields=["state", "progress", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.PAUSED,
            record=processing_request.book_record,
        )
    )
    return processing_request


def apply_resume_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    processing_request.state = BookCreationRequestState.INITIAL
    processing_request.is_resumed = True
    processing_request.error_message = ""
    processing_request.save(update_fields=["state", "is_resumed", "error_message", "updated_at"])
    sync_record_state(processing_request.book_record)
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.INITIAL,
            record=processing_request.book_record,
        )
    )
    queue_processing_request(processing_request)
    return processing_request


def apply_retry_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    record_before = processing_record_snapshot(processing_request.book_record)
    processing_request.state = BookCreationRequestState.INITIAL
    processing_request.error_message = ""
    processing_request.progress = None
    processing_request.duplicate_confirmed = False
    processing_request.save(
        update_fields=[
            "state",
            "error_message",
            "progress",
            "duplicate_confirmed",
            "updated_at",
        ]
    )
    record = processing_request.book_record
    if record.is_duplicate or record.duplicate_of_record_id:
        record.is_duplicate = False
        record.duplicate_of_record = None
        record.save(update_fields=["is_duplicate", "duplicate_of_record", "updated_at"])
    sync_record_state(record)
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            previous_state,
            BookCreationRequestState.INITIAL,
            record=record,
        )
        | processing_domains_for_record_change(
            record_before,
            processing_record_snapshot(record),
            current_request_state=BookCreationRequestState.INITIAL,
        )
    )
    queue_processing_request(processing_request)
    return processing_request
