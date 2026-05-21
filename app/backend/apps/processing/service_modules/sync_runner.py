

def advance_incomplete_sync_once(state):
    if sync_uses_live_fetch(state):
        try:
            return advance_live_incomplete_sync_once(state)
        except Exception as exc:
            logger.exception("Live incomplete sync failed.")
            return fail_sync(state, exc)

    page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    if not page:
        resolved = resolve_incomplete_records(stale_incomplete_record_ids(state.remote_pages))
        state.updated_count = len(resolved)
        save_sync_state(state, update_fields=["updated_count", "updated_at"])
        return complete_incomplete_automation(state, resolved_count=len(resolved))

    if isinstance(page, list) and all(not isinstance(item, dict) for item in page):
        resolved = resolve_incomplete_records(page)
        state.fetched_count += len(page)
        state.updated_count += len(resolved)
        state.page_index += 1
        next_page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
        latest_status = persisted_sync_status(state)
        if latest_status == ProcessingSyncStatus.PAUSING:
            state.status = ProcessingSyncStatus.PAUSED
            state.progress = build_sync_progress(
                SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
                next_page_index=state.page_index,
                fetched_count=state.fetched_count,
                saved_at=timezone.now().isoformat(),
                live_fetch=sync_uses_live_fetch(state),
                trigger_source=sync_trigger_source(state),
            )
            state.message = (
                f"Saved progress for {state.fetched_count} "
                f"{'record' if state.fetched_count == 1 else 'records'} before pausing."
            )
            update_automation_run_status(SYNC_RUN_MODE_INCOMPLETE_AUTOMATION, state.message)
        elif latest_status != ProcessingSyncStatus.SYNCING:
            return ProcessingSyncState.objects.get(pk=state.pk)
        elif not next_page:
            return complete_incomplete_automation(state, resolved_count=state.updated_count)
        else:
            state.progress = build_sync_progress(
                SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
                next_page_index=state.page_index,
                fetched_count=state.fetched_count,
                live_fetch=sync_uses_live_fetch(state),
                trigger_source=sync_trigger_source(state),
            )
            state.message = sync_progress_message(
                SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
                state.fetched_count,
            )
        save_sync_state(state)
        return state

    result = upsert_remote_records(page)
    state.fetched_count += len(page)
    state.skipped_count += result["skipped_count"]
    state.appended_count += result["appended_count"]
    state.page_index += 1
    next_page = state.remote_pages[state.page_index] if state.page_index < len(state.remote_pages) else []
    latest_status = persisted_sync_status(state)
    if latest_status == ProcessingSyncStatus.PAUSING:
        state.status = ProcessingSyncStatus.PAUSED
        state.progress = build_sync_progress(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            saved_at=timezone.now().isoformat(),
            live_fetch=sync_uses_live_fetch(state),
            trigger_source=sync_trigger_source(state),
        )
        state.message = (
            f"Saved progress for {state.fetched_count} "
            f"{'record' if state.fetched_count == 1 else 'records'} before pausing."
        )
        update_automation_run_status(SYNC_RUN_MODE_INCOMPLETE_AUTOMATION, state.message)
    elif latest_status != ProcessingSyncStatus.SYNCING:
        return ProcessingSyncState.objects.get(pk=state.pk)
    elif not next_page:
        resolved = resolve_incomplete_records(stale_incomplete_record_ids(state.remote_pages))
        state.updated_count = len(resolved)
        save_sync_state(state, update_fields=["updated_count", "updated_at"])
        return complete_incomplete_automation(state, resolved_count=len(resolved))
    else:
        state.progress = build_sync_progress(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            next_page_index=state.page_index,
            fetched_count=state.fetched_count,
            live_fetch=sync_uses_live_fetch(state),
            trigger_source=sync_trigger_source(state),
        )
        state.message = sync_progress_message(
            SYNC_RUN_MODE_INCOMPLETE_AUTOMATION,
            state.fetched_count,
        )
    save_sync_state(state)
    return state


def run_processing_sync(singleton_key=PROCESSING_SYNC_KEY_CATALOG, task_id=""):
    state = ProcessingSyncState.objects.get(singleton_key=singleton_key)
    if task_id and state.task_id and state.task_id != task_id:
        return state
    if state.status not in SYNC_ACTIVE_STATUSES:
        return state

    run_mode = sync_run_mode(state)
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        return advance_incomplete_sync_once(state)
    if sync_phase(state) == CATALOG_REQUEST_CREATION_PHASE:
        return advance_catalog_request_creation_once(state)
    if not sync_uses_live_fetch(state):
        return advance_catalog_sync_once(state, run_mode)

    return run_processing_sync_until_blocked(singleton_key=singleton_key, task_id=task_id)


def run_processing_sync_until_blocked(
    singleton_key=PROCESSING_SYNC_KEY_CATALOG,
    task_id="",
):
    state = ProcessingSyncState.objects.get(singleton_key=singleton_key)
    if task_id and state.task_id and state.task_id != task_id:
        return state
    if state.status not in SYNC_ACTIVE_STATUSES:
        return state

    run_mode = sync_run_mode(state)
    if run_mode == SYNC_RUN_MODE_INCOMPLETE_AUTOMATION:
        while True:
            state.refresh_from_db()
            if task_id and state.task_id and state.task_id != task_id:
                return state
            if state.status not in SYNC_ACTIVE_STATUSES:
                return state
            state = advance_incomplete_sync_once(state)
            if state.status not in SYNC_ACTIVE_STATUSES:
                return state
    if not sync_uses_live_fetch(state):
        while True:
            state.refresh_from_db()
            if task_id and state.task_id and state.task_id != task_id:
                return state
            if state.status not in SYNC_ACTIVE_STATUSES:
                return state
            state = advance_catalog_processing_once(state, run_mode)
            if state.status not in SYNC_ACTIVE_STATUSES:
                return state

    resolver = TitleResolver(session=create_session_with_retries())
    seen_urls = set()
    page_signatures = set()

    try:
        while True:
            state.refresh_from_db()
            if task_id and state.task_id and state.task_id != task_id:
                return state
            if state.status not in SYNC_ACTIVE_STATUSES:
                return state
            if sync_phase(state) == CATALOG_REQUEST_CREATION_PHASE:
                state = advance_catalog_request_creation_once(state)
                if state.status not in SYNC_ACTIVE_STATUSES:
                    return state
                continue

            page_number = state.page_index + 1
            page = fetch_live_catalog_page(resolver, page_number)
            unique_page = []
            for item in page:
                source_url = item.get("url")
                if not source_url or source_url in seen_urls:
                    continue
                seen_urls.add(source_url)
                unique_page.append(item)

            signature = tuple(item["url"] for item in unique_page[:5])
            if not unique_page or signature in page_signatures:
                if run_mode == SYNC_RUN_MODE_CATALOG_AUTOMATION:
                    state = begin_catalog_request_creation(state)
                    if state.status not in SYNC_ACTIVE_STATUSES:
                        return state
                    continue
                return finalize_catalog_sync(state, run_mode=run_mode)

            page_signatures.add(signature)
            result = upsert_remote_records(unique_page)
            state.fetched_count += len(unique_page)
            state.skipped_count += result["skipped_count"]
            state.updated_count += result["updated_count"]
            state.appended_count += result["appended_count"]
            state.page_index += 1

            session_id = sync_saved_data(state).get("sessionId") or ""
            request_creation_phase_state = catalog_phase_state(
                state,
                CATALOG_REQUEST_CREATION_PHASE,
            )
            latest_status = persisted_sync_status(state)
            if latest_status == ProcessingSyncStatus.PAUSING:
                state.status = ProcessingSyncStatus.PAUSED
                state.progress = build_catalog_sync_progress(
                    state,
                    run_mode,
                    next_page_index=state.page_index,
                    fetched_count=state.fetched_count,
                    saved_at=timezone.now().isoformat(),
                    live_fetch=True,
                    trigger_source=sync_trigger_source(state),
                    session_id=session_id,
                    sync_phase_status=CATALOG_PHASE_STATUS_PAUSED,
                    request_creation_phase_state=request_creation_phase_state,
                )
                state.message = f"Sync progress saved. {catalog_record_total_message()}"
                save_sync_state(state)
                update_automation_run_status(run_mode, state.message)
                return state
            if latest_status != ProcessingSyncStatus.SYNCING:
                return ProcessingSyncState.objects.get(pk=state.pk)

            state.progress = build_catalog_sync_progress(
                state,
                run_mode,
                next_page_index=state.page_index,
                fetched_count=state.fetched_count,
                live_fetch=True,
                trigger_source=sync_trigger_source(state),
                session_id=session_id,
                sync_phase_status=CATALOG_PHASE_STATUS_RUNNING,
                request_creation_phase_state=request_creation_phase_state,
            )
            state.message = sync_progress_message(run_mode, state.fetched_count)
            save_sync_state(state)
    except Exception as exc:
        logger.exception("Live processing sync failed.", extra={"task_id": task_id})
        return fail_sync(state, exc)


def advance_sync_once(sync_key=None):
    sync_key = sync_key or active_sync_scope()
    state = get_sync_state(sync_key)
    if state.status not in SYNC_ACTIVE_STATUSES:
        return state
    if state.task_id and not settings.CELERY_TASK_ALWAYS_EAGER:
        return state
    return run_processing_sync(singleton_key=state.singleton_key, task_id=state.task_id)


def request_id_for_record(record):
    return f"request-{record.id}"
