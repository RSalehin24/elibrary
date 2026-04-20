import json
import time

from django.http import StreamingHttpResponse
from rest_framework.exceptions import ValidationError
from rest_framework.renderers import BaseRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.permissions import CanManageProcessing

from .models import (
    BookCreationRequest,
    BookRecord,
    ProcessingAutomationKind,
)
from .serializers import (
    AutomationUpdateSerializer,
    BookCreationRequestSerializer,
    BookRecordSerializer,
    BulkIdsSerializer,
    RequestActionSerializer,
    SyncStartSerializer,
)
from .services import (
    PROCESSING_SYNC_KEY_CATALOG,
    PROCESSING_SYNC_KEY_INCOMPLETE,
    active_sync_scope,
    advance_processing_push_tick,
    allow_processing_remote_page_payloads,
    advance_sync_once,
    advance_pipeline_once,
    apply_request_action,
    create_requests_for_record_ids,
    get_automation_settings,
    get_sync_state,
    mark_stale_processing_requests,
    pause_sync,
    processing_card_payload,
    processing_invalidation_snapshot,
    processing_invalidation_targets,
    processing_summary_payload,
    processing_table_payload,
    refresh_processing_state,
    resume_sync,
    run_catalog_automation,
    run_incomplete_automation,
    run_manual_catalog_sync,
    serialize_automation_settings,
    serialize_sync_state,
    should_manually_advance_processing_work,
    sync_run_mode,
    stop_sync,
    update_automation_settings,
)


def truthy_query_param(raw_value, *, default):
    if raw_value is None:
        return default

    normalized = str(raw_value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def int_query_param(raw_value, *, default, minimum=0, maximum=None):
    try:
        parsed = int(raw_value)
    except (TypeError, ValueError):
        parsed = default

    parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def normalize_sync_scope(raw_scope, *, default=PROCESSING_SYNC_KEY_CATALOG):
    scope = str(raw_scope or default).strip().lower()
    if scope in {PROCESSING_SYNC_KEY_CATALOG, PROCESSING_SYNC_KEY_INCOMPLETE}:
        return scope
    raise ValidationError({"scope": [f"Unsupported processing scope: {scope}"]})


def requested_resume_run_mode(request, *, default):
    raw_value = request.data.get("runMode") if isinstance(request.data, dict) else None
    if raw_value in {None, ""}:
        return default
    run_mode = str(raw_value).strip()
    valid_modes = {"manual", "catalog_automation", "incomplete_automation"}
    if run_mode not in valid_modes:
        raise ValidationError({"runMode": [f"Unsupported sync run mode: {run_mode}"]})
    return run_mode


def primary_sync_state(catalog_sync, incomplete_sync):
    if active_sync_scope() == PROCESSING_SYNC_KEY_INCOMPLETE:
        return incomplete_sync
    if active_sync_scope() == PROCESSING_SYNC_KEY_CATALOG and catalog_sync.status in {
        "syncing",
        "pausing",
        "paused",
    }:
        return catalog_sync
    return (
        incomplete_sync
        if incomplete_sync.updated_at >= catalog_sync.updated_at
        else catalog_sync
    )


def serialized_processing_records():
    return BookRecordSerializer(
        BookRecord.objects.select_related("linked_book")
        .prefetch_related("creation_requests")
        .order_by("name", "id"),
        many=True,
    ).data


def serialized_processing_requests():
    return BookCreationRequestSerializer(
        BookCreationRequest.objects.select_related(
            "book_record",
            "linked_book",
            "book_record__linked_book",
        ).order_by(
            "-updated_at",
            "-created_at",
        ),
        many=True,
    ).data


def base_state_payload():
    catalog_sync = get_sync_state(PROCESSING_SYNC_KEY_CATALOG)
    incomplete_sync = get_sync_state(PROCESSING_SYNC_KEY_INCOMPLETE)
    primary_sync = primary_sync_state(catalog_sync, incomplete_sync)

    return {
        "summary": processing_summary_payload(),
        "sync": serialize_sync_state(primary_sync, include_remote_pages=False),
        "syncStates": {
            "catalog": serialize_sync_state(catalog_sync, include_remote_pages=False),
            "incomplete": serialize_sync_state(
                incomplete_sync,
                include_remote_pages=False,
            ),
        },
        "orchestration": {
            "manualPipelineAdvance": should_manually_advance_processing_work(),
        },
        "automation": {
            "catalog": serialize_automation_settings(
                get_automation_settings(ProcessingAutomationKind.CATALOG)
            ),
            "incomplete": serialize_automation_settings(
                get_automation_settings(ProcessingAutomationKind.INCOMPLETE)
            ),
        },
    }


def state_payload(*, include_lists=True):
    mark_stale_processing_requests()
    refresh_processing_state()

    payload = base_state_payload()
    if include_lists:
        payload["records"] = serialized_processing_records()
        payload["requests"] = serialized_processing_requests()
    return payload


def state_response_payload(*, previous_snapshot=None, include_lists=True, extra=None):
    payload = state_payload(include_lists=include_lists)
    if previous_snapshot is not None:
        next_snapshot = processing_invalidation_snapshot()
        payload["targets"] = processing_invalidation_targets(
            previous_snapshot,
            next_snapshot,
        )
    if extra:
        payload.update(extra)
    return payload


def processing_response(payload):
    response = Response(payload)
    response["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response["Pragma"] = "no-cache"
    return response


def snapshot_has_active_work(snapshot):
    request_counts = snapshot.get("requests", {}).get("counts", {})
    has_active_requests = any(
        request_counts.get(state, 0)
        for state in ("initial", "queued", "processing")
    )
    has_active_sync = any(
        snapshot.get(key, {}).get("status") in {"syncing", "pausing"}
        for key in ("catalogSync", "incompleteSync")
    )
    return has_active_requests or has_active_sync


def snapshot_event_scope(snapshot):
    if snapshot.get("incompleteSync", {}).get("status") in {"syncing", "pausing", "paused"}:
        return PROCESSING_SYNC_KEY_INCOMPLETE
    if snapshot.get("catalogSync", {}).get("status") in {"syncing", "pausing", "paused"}:
        return PROCESSING_SYNC_KEY_CATALOG
    return None


def stream_event_payload(snapshot, *, targets, transition_count=0, final=False):
    scope = snapshot_event_scope(snapshot)
    sync_key = "incompleteSync" if scope == PROCESSING_SYNC_KEY_INCOMPLETE else "catalogSync"
    sync_state = snapshot.get(sync_key, {}) if scope else {}
    payload = {
        "eventId": int(time.time() * 1000),
        "targets": list(dict.fromkeys(targets)),
    }
    if scope:
        payload["scope"] = scope
    if sync_state.get("runMode"):
        payload["triggerMode"] = sync_state["runMode"]
    if sync_state.get("status"):
        payload["phase"] = sync_state["status"]
    elif transition_count:
        payload["phase"] = "pipeline"
    if "pageIndex" in sync_state:
        payload["pageIndex"] = sync_state.get("pageIndex", 0)
    if transition_count:
        payload["transitionCount"] = transition_count
    if final:
        payload["final"] = True
    return payload


class EventStreamRenderer(BaseRenderer):
    media_type = "text/event-stream"
    format = "event-stream"
    charset = "utf-8"
    render_style = "binary"

    def render(self, data, accepted_media_type=None, renderer_context=None):
        return data if data is not None else b""


class ProcessingStateView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return processing_response(state_payload(include_lists=include_lists))


class ProcessingCardView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        mark_stale_processing_requests()
        refresh_processing_state()

        card = str(request.query_params.get("card") or "").strip()
        if not card:
            raise ValidationError({"card": ["This query parameter is required."]})

        try:
            payload = processing_card_payload(card)
        except KeyError as exc:
            raise ValidationError({"card": [f"Unsupported processing card: {exc.args[0]}"]}) from exc

        return processing_response(payload)


class ProcessingStreamView(APIView):
    permission_classes = [CanManageProcessing]
    renderer_classes = [EventStreamRenderer]

    def get(self, request):
        keepalive_seconds = 15
        active_snapshot_interval_seconds = 1
        idle_snapshot_interval_seconds = 4
        request_batch_threshold = 25
        max_batch_window_seconds = 2

        def stream():
            yield "event: connected\ndata: {}\n\n"
            last_snapshot = processing_invalidation_snapshot()
            pending_targets = []
            pending_transition_count = 0
            pending_snapshot = last_snapshot
            last_flush_at = time.monotonic()
            idle_seconds = 0
            snapshot_interval_seconds = (
                active_snapshot_interval_seconds
                if snapshot_has_active_work(last_snapshot)
                else idle_snapshot_interval_seconds
            )
            try:
                while True:
                    time.sleep(snapshot_interval_seconds)
                    advance_processing_push_tick()
                    next_snapshot = processing_invalidation_snapshot()
                    had_active_work = snapshot_has_active_work(last_snapshot)
                    has_active_work = snapshot_has_active_work(next_snapshot)
                    targets = processing_invalidation_targets(
                        last_snapshot,
                        next_snapshot,
                    )
                    if targets:
                        pending_targets.extend(targets)
                        pending_snapshot = next_snapshot
                        sync_changed = (
                            last_snapshot.get("catalogSync") != next_snapshot.get("catalogSync")
                            or last_snapshot.get("incompleteSync") != next_snapshot.get("incompleteSync")
                            or last_snapshot.get("catalogAutomation")
                            != next_snapshot.get("catalogAutomation")
                            or last_snapshot.get("incompleteAutomation")
                            != next_snapshot.get("incompleteAutomation")
                        )
                        if sync_changed:
                            pending_transition_count = 0
                        else:
                            pending_transition_count += 1

                        should_flush = (
                            sync_changed
                            or pending_transition_count >= request_batch_threshold
                            or (had_active_work and not has_active_work)
                            or (time.monotonic() - last_flush_at) >= max_batch_window_seconds
                        )

                        if should_flush:
                            payload = json.dumps(
                                stream_event_payload(
                                    pending_snapshot,
                                    targets=pending_targets,
                                    transition_count=pending_transition_count,
                                    final=had_active_work and not has_active_work,
                                )
                            )
                            yield f"event: invalidation\ndata: {payload}\n\n"
                            pending_targets = []
                            pending_transition_count = 0
                            last_flush_at = time.monotonic()
                        last_snapshot = next_snapshot
                        idle_seconds = 0
                    else:
                        if pending_targets and (
                            (time.monotonic() - last_flush_at) >= max_batch_window_seconds
                            or not has_active_work
                        ):
                            payload = json.dumps(
                                stream_event_payload(
                                    pending_snapshot,
                                    targets=pending_targets,
                                    transition_count=pending_transition_count,
                                    final=had_active_work and not has_active_work,
                                )
                            )
                            yield f"event: invalidation\ndata: {payload}\n\n"
                            pending_targets = []
                            pending_transition_count = 0
                            last_flush_at = time.monotonic()
                        idle_seconds += snapshot_interval_seconds
                        if idle_seconds >= keepalive_seconds:
                            yield ": keepalive\n\n"
                            idle_seconds = 0
                    snapshot_interval_seconds = (
                        active_snapshot_interval_seconds
                        if snapshot_has_active_work(next_snapshot) or pending_targets
                        else idle_snapshot_interval_seconds
                    )
            except GeneratorExit:
                return

        response = StreamingHttpResponse(stream(), content_type="text/event-stream")
        response["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response["Pragma"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        return response


class ProcessingTableView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        mark_stale_processing_requests()

        card = str(request.query_params.get("card") or "").strip()
        if not card:
            raise ValidationError({"card": ["This query parameter is required."]})

        try:
            payload = processing_table_payload(
                card,
                query=request.query_params.get("q", ""),
                category=request.query_params.get("category", ""),
                status=request.query_params.get("status", ""),
                offset=int_query_param(
                    request.query_params.get("offset"),
                    default=0,
                    minimum=0,
                ),
                limit=int_query_param(
                    request.query_params.get("limit"),
                    default=60,
                    minimum=1,
                    maximum=600,
                ),
            )
        except KeyError as exc:
            raise ValidationError({"card": [f"Unsupported processing table: {exc.args[0]}"]}) from exc

        return processing_response(payload)


class ProcessingPipelineAdvanceView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        previous_snapshot = processing_invalidation_snapshot()
        advanced = advance_pipeline_once()
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
                extra={"advancedCount": advanced},
            )
        )


class ProcessingSyncStartView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        previous_snapshot = processing_invalidation_snapshot()
        serializer = SyncStartSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        remote_pages = (
            serializer.validated_data.get("remotePages")
            if allow_processing_remote_page_payloads()
            else None
        )
        run_manual_catalog_sync(remote_pages or None)
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
            )
        )


class ProcessingSyncPauseView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request, scope=None):
        previous_snapshot = processing_invalidation_snapshot()
        pause_sync(
            normalize_sync_scope(
                scope,
                default=active_sync_scope(),
            )
        )
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
            )
        )


class ProcessingSyncAdvanceView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request, scope=None):
        previous_snapshot = processing_invalidation_snapshot()
        advance_sync_once(
            normalize_sync_scope(
                scope,
                default=active_sync_scope(),
            )
        )
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
            )
        )


class ProcessingSyncResumeView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request, scope=None):
        previous_snapshot = processing_invalidation_snapshot()
        sync_key = normalize_sync_scope(
            scope,
            default=active_sync_scope(),
        )
        default_run_mode = sync_run_mode(get_sync_state(sync_key))
        resume_sync(
            sync_key,
            run_mode=requested_resume_run_mode(
                request,
                default=default_run_mode,
            ),
        )
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
            )
        )


class ProcessingSyncStopView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request, scope=None):
        previous_snapshot = processing_invalidation_snapshot()
        stop_sync(
            normalize_sync_scope(
                scope,
                default=active_sync_scope(),
            )
        )
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
            )
        )


class ProcessingRecordCreateRequestsView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        previous_snapshot = processing_invalidation_snapshot()
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        created = create_requests_for_record_ids(
            serializer.validated_data["ids"],
            actor=request.user,
        )
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
                extra={"createdCount": len(created)},
            )
        )


class ProcessingRequestActionView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        previous_snapshot = processing_invalidation_snapshot()
        serializer = RequestActionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        changed = apply_request_action(
            serializer.validated_data["ids"],
            serializer.validated_data["action"],
            delete_book=serializer.validated_data["deleteBook"],
            actor=request.user,
        )
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
                extra={"changedCount": len(changed)},
            )
        )


class ProcessingAutomationView(APIView):
    permission_classes = [CanManageProcessing]
    kind = None

    def post(self, request):
        previous_snapshot = processing_invalidation_snapshot()
        serializer = AutomationUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        update_automation_settings(self.kind, serializer.validated_data)
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
            )
        )


class ProcessingCatalogAutomationView(ProcessingAutomationView):
    kind = ProcessingAutomationKind.CATALOG


class ProcessingIncompleteAutomationView(ProcessingAutomationView):
    kind = ProcessingAutomationKind.INCOMPLETE


class ProcessingCatalogAutomationRunView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        previous_snapshot = processing_invalidation_snapshot()
        run_catalog_automation()
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
            )
        )


class ProcessingIncompleteAutomationRunView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        previous_snapshot = processing_invalidation_snapshot()
        run_incomplete_automation()
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(
            state_response_payload(
                previous_snapshot=previous_snapshot,
                include_lists=include_lists,
            )
        )
