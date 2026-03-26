import csv
from io import StringIO

from rest_framework import serializers

from apps.ingestion.models import (
    BookSubmission,
    CatalogAutomationSettings,
    CatalogCurationMode,
    CatalogCurationRun,
    DuplicateReview,
    MatchCandidate,
    ProcessingJob,
    ProcessingLog,
    SourceCatalogEntry,
    SourceCatalogRefreshState,
    SubmissionInputType,
)
from apps.catalog.serializers import BookListSerializer
from apps.ingestion.services.curation import get_catalog_automation_settings, next_catalog_automation_run_at


def present_status(value):
    return "stopped" if value == "cancelled" else value


class SubmissionBatchCreateSerializer(serializers.Serializer):
    input_type = serializers.ChoiceField(choices=SubmissionInputType.choices, required=False)
    content = serializers.CharField(required=False, allow_blank=True)
    entries = serializers.ListField(child=serializers.CharField(), required=False, allow_empty=False)
    auto_process = serializers.BooleanField(default=True)

    def validate(self, attrs):
        parsed_entries = []
        entries = attrs.get("entries") or []
        if entries:
            for raw_value in entries:
                value = raw_value.strip()
                if value:
                    inferred_kind = "url" if value.startswith("http") else "title"
                    parsed_entries.append({"kind": inferred_kind, "value": value})
        else:
            input_type = attrs.get("input_type")
            content = attrs.get("content", "").strip()
            if not input_type:
                raise serializers.ValidationError({"input_type": "This field is required when entries are not supplied."})
            if not content:
                raise serializers.ValidationError({"content": "At least one submission value is required."})

            if input_type in {SubmissionInputType.URL, SubmissionInputType.TITLE}:
                for line in content.splitlines():
                    value = line.strip()
                    if value:
                        parsed_entries.append({"kind": input_type, "value": value})
            else:
                reader = csv.DictReader(StringIO(content))
                for row in reader:
                    raw_value = row.get("url") or row.get("title") or row.get("query")
                    if not raw_value:
                        for value in row.values():
                            if value:
                                raw_value = value
                                break
                    if not raw_value:
                        continue
                    inferred_kind = "url" if raw_value.strip().startswith("http") else "title"
                    parsed_entries.append({"kind": inferred_kind, "value": raw_value.strip()})

        if not parsed_entries:
            raise serializers.ValidationError({"entries": "No usable submission entries were found."})

        attrs["parsed_entries"] = parsed_entries
        return attrs


class MatchCandidateSerializer(serializers.ModelSerializer):
    class Meta:
        model = MatchCandidate
        fields = [
            "id",
            "rank",
            "candidate_title",
            "candidate_author",
            "candidate_url",
            "confidence",
            "is_selected",
        ]


class ProcessingJobSerializer(serializers.ModelSerializer):
    status = serializers.SerializerMethodField()
    submission_id = serializers.UUIDField(source="submission.id", read_only=True)
    submission_input = serializers.CharField(source="submission.original_input", read_only=True)
    submission_origin = serializers.CharField(source="submission.origin", read_only=True)
    submission_status = serializers.SerializerMethodField()
    submission_resolution_status = serializers.CharField(source="submission.resolution_status", read_only=True)
    queue_name = serializers.CharField(read_only=True)
    target_book_slug = serializers.SerializerMethodField()
    target_book_title = serializers.SerializerMethodField()
    target_book_deleted = serializers.SerializerMethodField()
    is_requeued = serializers.SerializerMethodField()
    requeue_reason = serializers.SerializerMethodField()

    class Meta:
        model = ProcessingJob
        fields = [
            "id",
            "submission_id",
            "job_type",
            "status",
            "task_id",
            "queue_name",
            "retry_count",
            "cancel_requested",
            "submission_origin",
            "submission_input",
            "submission_status",
            "submission_resolution_status",
            "target_book_slug",
            "target_book_title",
            "target_book_deleted",
            "is_requeued",
            "requeue_reason",
            "last_error",
            "created_at",
            "updated_at",
            "started_at",
            "finished_at",
        ]

    def linked_book_for(self, submission):
        return submission.linked_book if submission.linked_book_id else None

    def get_target_book(self, obj):
        if obj.book_id and not obj.book.deleted_at:
            return obj.book
        submission = obj.submission
        linked_book = self.linked_book_for(submission)
        if linked_book and not linked_book.deleted_at:
            return submission.linked_book
        return None

    def get_raw_target_book(self, obj):
        if obj.book_id:
            return obj.book
        return self.linked_book_for(obj.submission)

    def get_target_book_slug(self, obj):
        book = self.get_target_book(obj)
        return book.slug if book else ""

    def get_target_book_title(self, obj):
        book = self.get_raw_target_book(obj)
        return book.title if book else ""

    def get_status(self, obj):
        return present_status(obj.status)

    def get_submission_status(self, obj):
        return present_status(obj.submission.status)

    def get_target_book_deleted(self, obj):
        book = self.get_raw_target_book(obj)
        return bool(book and book.deleted_at)

    def get_is_requeued(self, obj):
        raw_payload = obj.submission.raw_payload or {}
        return bool(obj.job_type == "reprocess" or raw_payload.get("requeued", False))

    def get_requeue_reason(self, obj):
        raw_payload = obj.submission.raw_payload or {}
        if obj.job_type == "reprocess":
            return "Regeneration requested."
        return raw_payload.get("requeue_reason", "")


class SubmissionSerializer(serializers.ModelSerializer):
    status = serializers.SerializerMethodField()
    candidates = serializers.SerializerMethodField()
    latest_job = serializers.SerializerMethodField()
    linked_book_slug = serializers.SerializerMethodField()
    linked_book = serializers.SerializerMethodField()
    linked_book_deleted = serializers.SerializerMethodField()
    served_from_database = serializers.SerializerMethodField()
    canonical_submission_id = serializers.SerializerMethodField()
    uses_existing_request = serializers.SerializerMethodField()

    class Meta:
        model = BookSubmission
        fields = [
            "id",
            "input_type",
            "origin",
            "original_input",
            "resolved_url",
            "resolution_status",
            "resolution_confidence",
            "status",
            "review_state",
            "error_message",
            "linked_book_slug",
            "linked_book",
            "linked_book_deleted",
            "served_from_database",
            "canonical_submission_id",
            "uses_existing_request",
            "candidates",
            "latest_job",
            "created_at",
            "updated_at",
        ]

    def canonical_submission_for(self, obj):
        return obj.canonical_submission or obj

    def linked_book_for(self, obj):
        return obj.linked_book if obj.linked_book_id else None

    def get_status(self, obj):
        linked_book = self.linked_book_for(obj)
        if linked_book and linked_book.deleted_at:
            return "deleted"
        return present_status(obj.status)

    def get_candidates(self, obj):
        attempt = obj.resolution_attempts.first()
        if not attempt and obj.canonical_submission_id:
            attempt = obj.canonical_submission.resolution_attempts.first()
        if not attempt:
            return []
        return MatchCandidateSerializer(attempt.match_candidates.all()[:3], many=True).data

    def get_latest_job(self, obj):
        job = obj.processing_jobs.first()
        if not job and obj.canonical_submission_id:
            job = obj.canonical_submission.processing_jobs.first()
        return ProcessingJobSerializer(job).data if job else None

    def get_linked_book_slug(self, obj):
        linked_book = self.linked_book_for(obj)
        return linked_book.slug if linked_book and not linked_book.deleted_at else ""

    def get_linked_book(self, obj):
        linked_book = self.linked_book_for(obj)
        if not linked_book:
            return None
        return BookListSerializer(linked_book, context=self.context).data

    def get_linked_book_deleted(self, obj):
        linked_book = self.linked_book_for(obj)
        return bool(linked_book and linked_book.deleted_at)

    def get_served_from_database(self, obj):
        return bool(obj.raw_payload.get("served_from_database"))

    def get_canonical_submission_id(self, obj):
        canonical = obj.canonical_submission
        return str(canonical.id) if canonical else ""

    def get_uses_existing_request(self, obj):
        return bool(obj.canonical_submission_id)


class DuplicateReviewSerializer(serializers.ModelSerializer):
    submission = SubmissionSerializer(read_only=True)
    existing_book = BookListSerializer(read_only=True)
    existing_book_deleted = serializers.SerializerMethodField()

    class Meta:
        model = DuplicateReview
        fields = [
            "id",
            "detected_by",
            "status",
            "notes",
            "raw_evidence",
            "submission",
            "existing_book",
            "existing_book_deleted",
            "created_at",
        ]

    def get_existing_book_deleted(self, obj):
        return bool(obj.existing_book_id and obj.existing_book.deleted_at)


class ProcessingLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProcessingLog
        fields = ["id", "level", "message", "details", "created_at"]


class DuplicateReviewDecisionSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=["confirm_existing", "dismiss"])
    notes = serializers.CharField(required=False, allow_blank=True)


class SourceCatalogEntrySnapshotSerializer(serializers.Serializer):
    id = serializers.CharField()
    title = serializers.CharField()
    author_line = serializers.CharField(allow_blank=True)
    categories = serializers.CharField(allow_blank=True)
    source_url = serializers.URLField()
    created_at = serializers.DateTimeField()
    last_seen_at = serializers.DateTimeField()
    curation_status = serializers.CharField()
    local_book_slug = serializers.CharField(allow_blank=True)
    local_book_title = serializers.CharField(allow_blank=True)
    local_book_state = serializers.CharField(allow_blank=True)
    latest_submission_status = serializers.CharField(allow_blank=True)
    latest_job_status = serializers.CharField(allow_blank=True)
    latest_job_error = serializers.CharField(allow_blank=True)
    activity_at = serializers.DateTimeField(allow_null=True)
    updated_at = serializers.DateTimeField(allow_null=True)

    def to_representation(self, instance):
        payload = super().to_representation(instance)
        payload["latest_submission_status"] = present_status(payload.get("latest_submission_status", ""))
        payload["latest_job_status"] = present_status(payload.get("latest_job_status", ""))
        payload["curation_status"] = present_status(payload.get("curation_status", ""))
        return payload


class CatalogCurationRunSerializer(serializers.ModelSerializer):
    status = serializers.SerializerMethodField()
    requested_by_email = serializers.EmailField(source="requested_by.email", read_only=True)

    class Meta:
        model = CatalogCurationRun
        fields = [
            "id",
            "trigger",
            "mode",
            "status",
            "refresh_catalog",
            "refresh_max_pages",
            "task_id",
            "queue_name",
            "retry_count",
            "cancel_requested",
            "requested_by_email",
            "summary",
            "last_error",
            "created_at",
            "updated_at",
            "started_at",
            "finished_at",
        ]

    def get_status(self, obj):
        return present_status(obj.status)


class CatalogCurationRunCreateSerializer(serializers.Serializer):
    mode = serializers.ChoiceField(choices=CatalogCurationMode.choices, default=CatalogCurationMode.PENDING)
    refresh_catalog = serializers.BooleanField(default=True)
    refresh_max_pages = serializers.IntegerField(required=False, min_value=1, max_value=80, default=80)


class SourceCatalogRefreshStateSerializer(serializers.ModelSerializer):
    requested_by_email = serializers.EmailField(source="requested_by.email", read_only=True)

    class Meta:
        model = SourceCatalogRefreshState
        fields = [
            "status",
            "max_pages",
            "task_id",
            "queue_name",
            "retry_count",
            "refreshed_entries",
            "last_error",
            "requested_by_email",
            "created_at",
            "updated_at",
            "started_at",
            "finished_at",
        ]


class CatalogAutomationSettingsSerializer(serializers.ModelSerializer):
    next_run_at = serializers.SerializerMethodField()

    class Meta:
        model = CatalogAutomationSettings
        fields = [
            "enabled",
            "daily_run_time",
            "frequency",
            "mode",
            "refresh_max_pages",
            "next_run_at",
        ]

    def get_next_run_at(self, obj):
        return next_catalog_automation_run_at(obj)


class CatalogAutomationSettingsUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = CatalogAutomationSettings
        fields = [
            "enabled",
            "daily_run_time",
            "frequency",
            "mode",
            "refresh_max_pages",
        ]


class BulkIdsSerializer(serializers.Serializer):
    ids = serializers.ListField(child=serializers.UUIDField(), allow_empty=False, max_length=200)
