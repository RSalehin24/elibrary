

def apply_new_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    record_before = processing_record_snapshot(processing_request.book_record)
    processing_request.state = BookCreationRequestState.INITIAL
    processing_request.is_confirmed_not_duplicate = True
    processing_request.duplicate_confirmed = False
    processing_request.duplicate_of_request = None
    processing_request.duplicate_of_record = None
    processing_request.linked_book = None
    processing_request.error_message = ""
    processing_request.progress = None
    processing_request.save(
        update_fields=[
            "state",
            "is_confirmed_not_duplicate",
            "duplicate_confirmed",
            "duplicate_of_request",
            "duplicate_of_record",
            "linked_book",
            "error_message",
            "progress",
            "updated_at",
        ]
    )
    record = processing_request.book_record
    record.linked_book = None
    record.is_duplicate = False
    record.duplicate_of_record = None
    record.save(
        update_fields=["linked_book", "is_duplicate", "duplicate_of_record", "updated_at"]
    )
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


def apply_confirm_duplicate_action(processing_request):
    processing_request = _reload_processing_request(processing_request.id)
    record_before = processing_record_snapshot(processing_request.book_record)
    target_request = processing_request.duplicate_of_request
    if processing_request.duplicate_of_record_id and not target_request:
        target_request = (
            BookCreationRequest.objects.filter(book_record_id=processing_request.duplicate_of_record_id)
            .exclude(pk=processing_request.pk)
            .order_by("-updated_at", "-created_at")
            .first()
        )
    processing_request.state = BookCreationRequestState.DUPLICATE
    processing_request.duplicate_confirmed = True
    if target_request:
        processing_request.duplicate_of_request = target_request
        processing_request.duplicate_of_record = target_request.book_record
    processing_request.save(
        update_fields=[
            "state",
            "duplicate_confirmed",
            "duplicate_of_request",
            "duplicate_of_record",
            "updated_at",
        ]
    )

    if processing_request.duplicate_of_record_id:
        processing_request.book_record.is_duplicate = True
        processing_request.book_record.duplicate_of_record = processing_request.duplicate_of_record
        processing_request.book_record.save(
            update_fields=["is_duplicate", "duplicate_of_record", "updated_at"]
        )
    sync_record_state(processing_request.book_record)
    publish_processing_ui_domains(
        processing_domains_for_request_change(
            BookCreationRequestState.DUPLICATE,
            BookCreationRequestState.DUPLICATE,
            record=processing_request.book_record,
        )
        | processing_domains_for_record_change(
            record_before,
            processing_record_snapshot(processing_request.book_record),
            current_request_state=BookCreationRequestState.DUPLICATE,
        )
    )
    return processing_request


def apply_recreate_action(processing_request, *, actor=None):
    processing_request = _reload_processing_request(processing_request.id)
    previous_state = processing_request.state
    record_before = processing_record_snapshot(processing_request.book_record)
    processing_request.state = BookCreationRequestState.INITIAL
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


def advance_pipeline_once():
    advanced = 0
    advanced += len(mark_stale_processing_requests())

    queued_request = (
        BookCreationRequest.objects.filter(state=BookCreationRequestState.QUEUED)
        .order_by("created_at", "id")
        .first()
    )
    if queued_request:
        if should_run_processing_jobs_inline():
            _transition_request_state(
                queued_request.id,
                BookCreationRequestState.QUEUED,
                BookCreationRequestState.PROCESSING,
            )
            advanced += 1
        elif should_enqueue_processing_work():
            workers_available = processing_workers_available()
            if not _request_dispatch_pending(queued_request) or not workers_available:
                if not workers_available or not enqueue_request_processing(queued_request):
                    kickoff_request_processing(queued_request.id)
                advanced += 1
        else:
            _transition_request_state(
                queued_request.id,
                BookCreationRequestState.QUEUED,
                BookCreationRequestState.PROCESSING,
            )
            advanced += 1

    processing_request = (
        BookCreationRequest.objects.filter(state=BookCreationRequestState.PROCESSING)
        .order_by("created_at", "id")
        .first()
    )
    if processing_request and (
        should_run_processing_jobs_inline()
        or should_manually_advance_processing_work()
    ):
        _run_processing_request(processing_request)
        advanced += 1

    initial_request = (
        BookCreationRequest.objects.filter(state=BookCreationRequestState.INITIAL)
        .order_by("created_at", "id")
        .first()
    )
    if initial_request:
        _transition_request_state(
            initial_request.id,
            BookCreationRequestState.INITIAL,
            BookCreationRequestState.QUEUED,
        )
        advanced += 1

    if advanced == 0:
        repair_self_linked_duplicate_requests()
    return advanced


def apply_request_action(request_ids, action, *, delete_book=False, actor=None):
    requests = list(
        BookCreationRequest.objects.filter(pk__in=request_ids)
        .select_related("book_record", "linked_book")
        .order_by("created_at", "id")
    )
    changed = []
    for processing_request in requests:
        if action == "delete":
            apply_delete_action(processing_request, delete_book=delete_book)
        elif action == "pause":
            apply_pause_action(processing_request)
        elif action == "resume":
            apply_resume_action(processing_request, actor=actor)
        elif action == "retry":
            apply_retry_action(processing_request, actor=actor)
        elif action == "new":
            apply_new_action(processing_request, actor=actor)
        elif action == "confirm_duplicate":
            apply_confirm_duplicate_action(processing_request)
        elif action in {"create_again", "recreate"}:
            apply_recreate_action(processing_request, actor=actor)
        else:
            continue
        changed.append(processing_request)
    sync_records_for_requests(changed)
    return changed
