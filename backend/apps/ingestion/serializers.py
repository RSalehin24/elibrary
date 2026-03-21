import csv
from io import StringIO

from rest_framework import serializers

from apps.ingestion.models import (
    BookSubmission,
    DuplicateReview,
    MatchCandidate,
    ProcessingJob,
    SubmissionInputType,
)
from apps.catalog.serializers import BookListSerializer


class SubmissionBatchCreateSerializer(serializers.Serializer):
    input_type = serializers.ChoiceField(choices=SubmissionInputType.choices)
    content = serializers.CharField()
    auto_process = serializers.BooleanField(default=True)

    def validate(self, attrs):
        content = attrs["content"].strip()
        if not content:
            raise serializers.ValidationError({"content": "At least one submission value is required."})

        parsed_entries = []
        if attrs["input_type"] in {SubmissionInputType.URL, SubmissionInputType.TITLE}:
            for line in content.splitlines():
                value = line.strip()
                if value:
                    parsed_entries.append({"kind": attrs["input_type"], "value": value})
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
            raise serializers.ValidationError({"content": "No usable submission entries were found."})

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
    class Meta:
        model = ProcessingJob
        fields = [
            "id",
            "job_type",
            "status",
            "retry_count",
            "last_error",
            "created_at",
            "started_at",
            "finished_at",
        ]


class SubmissionSerializer(serializers.ModelSerializer):
    candidates = serializers.SerializerMethodField()
    latest_job = serializers.SerializerMethodField()
    linked_book_slug = serializers.SerializerMethodField()
    linked_book = serializers.SerializerMethodField()
    served_from_database = serializers.SerializerMethodField()

    class Meta:
        model = BookSubmission
        fields = [
            "id",
            "input_type",
            "original_input",
            "resolved_url",
            "resolution_status",
            "resolution_confidence",
            "status",
            "review_state",
            "error_message",
            "linked_book_slug",
            "linked_book",
            "served_from_database",
            "candidates",
            "latest_job",
            "created_at",
        ]

    def get_candidates(self, obj):
        attempt = obj.resolution_attempts.first()
        if not attempt:
            return []
        return MatchCandidateSerializer(attempt.match_candidates.all()[:3], many=True).data

    def get_latest_job(self, obj):
        job = obj.processing_jobs.first()
        return ProcessingJobSerializer(job).data if job else None

    def get_linked_book_slug(self, obj):
        return obj.linked_book.slug if obj.linked_book_id else ""

    def get_linked_book(self, obj):
        if not obj.linked_book_id:
            return None
        return BookListSerializer(obj.linked_book, context=self.context).data

    def get_served_from_database(self, obj):
        return bool(obj.raw_payload.get("served_from_database"))


class DuplicateReviewSerializer(serializers.ModelSerializer):
    submission = SubmissionSerializer(read_only=True)
    existing_book = BookListSerializer(read_only=True)

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
            "created_at",
        ]


class DuplicateReviewDecisionSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=["confirm_existing", "dismiss"])
    notes = serializers.CharField(required=False, allow_blank=True)
