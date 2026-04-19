from rest_framework.exceptions import ValidationError
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
    ProcessingAutomationSettingsSerializer,
    ProcessingSyncStateSerializer,
    RequestActionSerializer,
    SyncStartSerializer,
)
from .services import (
    advance_sync_once,
    advance_pipeline_once,
    apply_request_action,
    create_requests_for_record_ids,
    get_automation_settings,
    get_sync_state,
    mark_stale_processing_requests,
    pause_sync,
    processing_summary_payload,
    processing_table_payload,
    refresh_processing_state,
    resume_sync,
    run_catalog_automation,
    run_incomplete_automation,
    start_sync,
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


def state_payload(*, include_lists=True):
    mark_stale_processing_requests()
    refresh_processing_state()

    payload = {
        "summary": processing_summary_payload(),
        "sync": ProcessingSyncStateSerializer(get_sync_state()).data,
        "automation": {
            "catalog": ProcessingAutomationSettingsSerializer(
                get_automation_settings(ProcessingAutomationKind.CATALOG)
            ).data,
            "incomplete": ProcessingAutomationSettingsSerializer(
                get_automation_settings(ProcessingAutomationKind.INCOMPLETE)
            ).data,
        },
    }
    if include_lists:
        payload["records"] = BookRecordSerializer(
            BookRecord.objects.select_related("linked_book")
            .prefetch_related("creation_requests")
            .order_by("name", "id"),
            many=True,
        ).data
        payload["requests"] = BookCreationRequestSerializer(
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
    return payload


class ProcessingStateView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(state_payload(include_lists=include_lists))


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

        return Response(payload)


class ProcessingPipelineAdvanceView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        advanced = advance_pipeline_once()
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        payload = state_payload(include_lists=include_lists)
        payload["advancedCount"] = advanced
        return Response(payload)


class ProcessingSyncStartView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        serializer = SyncStartSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        remote_pages = serializer.validated_data.get("remotePages")
        start_sync(remote_pages or None)
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(state_payload(include_lists=include_lists))


class ProcessingSyncPauseView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        pause_sync()
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(state_payload(include_lists=include_lists))


class ProcessingSyncAdvanceView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        advance_sync_once()
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(state_payload(include_lists=include_lists))


class ProcessingSyncResumeView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        resume_sync()
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(state_payload(include_lists=include_lists))


class ProcessingSyncStopView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        stop_sync()
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(state_payload(include_lists=include_lists))


class ProcessingRecordCreateRequestsView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
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
        payload = state_payload(include_lists=include_lists)
        payload["createdCount"] = len(created)
        return Response(payload)


class ProcessingRequestActionView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
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
        payload = state_payload(include_lists=include_lists)
        payload["changedCount"] = len(changed)
        return Response(payload)


class ProcessingAutomationView(APIView):
    permission_classes = [CanManageProcessing]
    kind = None

    def post(self, request):
        serializer = AutomationUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        update_automation_settings(self.kind, serializer.validated_data)
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(state_payload(include_lists=include_lists))


class ProcessingCatalogAutomationView(ProcessingAutomationView):
    kind = ProcessingAutomationKind.CATALOG


class ProcessingIncompleteAutomationView(ProcessingAutomationView):
    kind = ProcessingAutomationKind.INCOMPLETE


class ProcessingCatalogAutomationRunView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        run_catalog_automation()
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(state_payload(include_lists=include_lists))


class ProcessingIncompleteAutomationRunView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        run_incomplete_automation()
        include_lists = truthy_query_param(
            request.query_params.get("includeLists"),
            default=True,
        )
        return Response(state_payload(include_lists=include_lists))
