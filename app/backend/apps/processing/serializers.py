from rest_framework import serializers

from .models import (
    BookCreationRequest,
    BookRecord,
    ProcessingAutomationKind,
    ProcessingAutomationSettings,
    ProcessingSyncState,
)
from .services import latest_request_for_record, record_is_selectable, sync_run_mode


class BookRecordSerializer(serializers.ModelSerializer):
    bookCreationState = serializers.CharField(source="book_creation_state")
    createdAt = serializers.DateTimeField(source="created_at")
    updatedAt = serializers.DateTimeField(source="updated_at")
    wasIncomplete = serializers.BooleanField(source="was_incomplete")
    resolvedFromIncomplete = serializers.BooleanField(source="resolved_from_incomplete")
    willResolveToCategory = serializers.CharField(source="will_resolve_to_category")
    isDuplicate = serializers.BooleanField(source="is_duplicate")
    duplicateOfRecordId = serializers.CharField(source="duplicate_of_record_id", allow_null=True)
    linkedBookId = serializers.CharField(source="linked_book_id", allow_null=True)
    selectable = serializers.SerializerMethodField()
    latestRequestId = serializers.SerializerMethodField()

    class Meta:
        model = BookRecord
        fields = [
            "id",
            "name",
            "url",
            "category",
            "writer",
            "translator",
            "composer",
            "publisher",
            "createdAt",
            "updatedAt",
            "bookCreationState",
            "linkedBookId",
            "wasIncomplete",
            "resolvedFromIncomplete",
            "willResolveToCategory",
            "isDuplicate",
            "duplicateOfRecordId",
            "selectable",
            "latestRequestId",
        ]

    def get_selectable(self, obj):
        return record_is_selectable(obj)

    def get_latestRequestId(self, obj):
        request = latest_request_for_record(obj)
        return request.id if request else None


class BookCreationRequestSerializer(serializers.ModelSerializer):
    bookRecordId = serializers.CharField(source="book_record_id")
    createdAt = serializers.DateTimeField(source="created_at")
    updatedAt = serializers.DateTimeField(source="updated_at")
    errorMessage = serializers.CharField(source="error_message", allow_blank=True)
    isResumed = serializers.BooleanField(source="is_resumed")
    isConfirmedNotDuplicate = serializers.BooleanField(source="is_confirmed_not_duplicate")
    duplicateOfRequestId = serializers.CharField(source="duplicate_of_request_id", allow_null=True)
    duplicateOfRecordId = serializers.CharField(source="duplicate_of_record_id", allow_null=True)
    duplicateConfirmed = serializers.BooleanField(source="duplicate_confirmed")
    linkedBookId = serializers.CharField(source="linked_book_id", allow_null=True)

    class Meta:
        model = BookCreationRequest
        fields = [
            "id",
            "bookRecordId",
            "state",
            "createdAt",
            "updatedAt",
            "progress",
            "errorMessage",
            "isResumed",
            "isConfirmedNotDuplicate",
            "duplicateOfRequestId",
            "duplicateOfRecordId",
            "duplicateConfirmed",
            "linkedBookId",
            "pipeline_outcome",
        ]


class ProcessingSyncStateSerializer(serializers.ModelSerializer):
    fetchedCount = serializers.IntegerField(source="fetched_count")
    skippedCount = serializers.IntegerField(source="skipped_count")
    updatedCount = serializers.IntegerField(source="updated_count")
    appendedCount = serializers.IntegerField(source="appended_count")
    remotePages = serializers.JSONField(source="remote_pages")
    pageIndex = serializers.IntegerField(source="page_index")
    runMode = serializers.SerializerMethodField()

    class Meta:
        model = ProcessingSyncState
        fields = [
            "status",
            "progress",
            "fetchedCount",
            "skippedCount",
            "updatedCount",
            "appendedCount",
            "message",
            "remotePages",
            "pageIndex",
            "runMode",
        ]

    def get_runMode(self, obj):
        return sync_run_mode(obj)


class ProcessingAutomationSettingsSerializer(serializers.ModelSerializer):
    lastRunAt = serializers.DateTimeField(source="last_run_at", allow_null=True)
    statusMessage = serializers.CharField(source="status_message", allow_blank=True)

    class Meta:
        model = ProcessingAutomationSettings
        fields = [
            "kind",
            "enabled",
            "interval",
            "time",
            "saved",
            "lastRunAt",
            "statusMessage",
        ]


class ProcessingStateSerializer(serializers.Serializer):
    records = BookRecordSerializer(many=True)
    requests = BookCreationRequestSerializer(many=True)
    sync = ProcessingSyncStateSerializer()
    automation = serializers.DictField()


class BulkIdsSerializer(serializers.Serializer):
    ids = serializers.ListField(
        child=serializers.CharField(),
        allow_empty=False,
    )


class RequestActionSerializer(BulkIdsSerializer):
    action = serializers.ChoiceField(
        choices=[
            "delete",
            "pause",
            "resume",
            "retry",
            "new",
            "confirm_duplicate",
            "create_again",
            "recreate",
        ]
    )
    deleteBook = serializers.BooleanField(required=False, default=False)


class SyncStartSerializer(serializers.Serializer):
    remotePages = serializers.ListField(
        child=serializers.ListField(child=serializers.DictField()),
        required=False,
        default=list,
    )


class AutomationUpdateSerializer(serializers.Serializer):
    enabled = serializers.BooleanField(required=False)
    interval = serializers.CharField(required=False, allow_blank=False)
    time = serializers.TimeField(required=False)


def automation_payload():
    catalog = ProcessingAutomationSettingsSerializer(
        ProcessingAutomationSettings.objects.get(kind=ProcessingAutomationKind.CATALOG)
    ).data
    incomplete = ProcessingAutomationSettingsSerializer(
        ProcessingAutomationSettings.objects.get(kind=ProcessingAutomationKind.INCOMPLETE)
    ).data
    return {
        "catalog": catalog,
        "incomplete": incomplete,
    }


__all__ = [
    "AutomationUpdateSerializer",
    "BookCreationRequestSerializer",
    "BookRecordSerializer",
    "BulkIdsSerializer",
    "ProcessingStateSerializer",
    "ProcessingSyncStateSerializer",
    "RequestActionSerializer",
    "SyncStartSerializer",
    "automation_payload",
]
