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
    resume_sync,
    run_catalog_automation,
    run_incomplete_automation,
    start_sync,
    sync_record_state,
    update_automation_settings,
)


def state_payload():
    mark_stale_processing_requests()
    for record in BookRecord.objects.prefetch_related("creation_requests"):
        sync_record_state(record)

    return {
        "records": BookRecordSerializer(
            BookRecord.objects.prefetch_related("creation_requests").order_by("name", "id"),
            many=True,
        ).data,
        "requests": BookCreationRequestSerializer(
            BookCreationRequest.objects.select_related("book_record", "linked_book").order_by("-updated_at", "-created_at"),
            many=True,
        ).data,
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


class ProcessingStateView(APIView):
    permission_classes = [CanManageProcessing]

    def get(self, request):
        return Response(state_payload())


class ProcessingPipelineAdvanceView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        advanced = advance_pipeline_once()
        payload = state_payload()
        payload["advancedCount"] = advanced
        return Response(payload)


class ProcessingSyncStartView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        serializer = SyncStartSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        start_sync(serializer.validated_data.get("remotePages", []))
        return Response(state_payload())


class ProcessingSyncPauseView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        pause_sync()
        return Response(state_payload())


class ProcessingSyncAdvanceView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        advance_sync_once()
        return Response(state_payload())


class ProcessingSyncResumeView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        resume_sync()
        return Response(state_payload())


class ProcessingRecordCreateRequestsView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        serializer = BulkIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        created = create_requests_for_record_ids(serializer.validated_data["ids"])
        payload = state_payload()
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
        )
        payload = state_payload()
        payload["changedCount"] = len(changed)
        return Response(payload)


class ProcessingAutomationView(APIView):
    permission_classes = [CanManageProcessing]
    kind = None

    def post(self, request):
        serializer = AutomationUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        update_automation_settings(self.kind, serializer.validated_data)
        return Response(state_payload())


class ProcessingCatalogAutomationView(ProcessingAutomationView):
    kind = ProcessingAutomationKind.CATALOG


class ProcessingIncompleteAutomationView(ProcessingAutomationView):
    kind = ProcessingAutomationKind.INCOMPLETE


class ProcessingCatalogAutomationRunView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        created = run_catalog_automation()
        payload = state_payload()
        payload["createdCount"] = len(created)
        return Response(payload)


class ProcessingIncompleteAutomationRunView(APIView):
    permission_classes = [CanManageProcessing]

    def post(self, request):
        resolved = run_incomplete_automation()
        payload = state_payload()
        payload["resolvedCount"] = len(resolved)
        return Response(payload)
