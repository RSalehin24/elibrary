from django.db import models

from apps.common.models import ReviewState, TimeStampedModel, UUIDPrimaryKeyModel


class SubmissionInputType(models.TextChoices):
    URL = "url", "Direct URL"
    TITLE = "title", "Title query"
    CSV = "csv", "CSV import"


class ResolutionStatus(models.TextChoices):
    UNRESOLVED = "unresolved", "Unresolved"
    RESOLVED = "resolved", "Resolved"
    EXACT_MATCH = "exact_match", "Exact match"
    AMBIGUOUS = "ambiguous", "Ambiguous"
    REJECTED = "rejected", "Rejected"
    INVALID = "invalid", "Invalid"


class SubmissionStatus(models.TextChoices):
    DRAFT = "draft", "Draft"
    PENDING_RESOLUTION = "pending_resolution", "Pending resolution"
    QUEUED = "queued", "Queued"
    PROCESSING = "processing", "Processing"
    NEEDS_REVIEW = "needs_review", "Needs review"
    READY = "ready", "Ready"
    FAILED = "failed", "Failed"
    DUPLICATE = "duplicate", "Duplicate candidate"


class JobStatus(models.TextChoices):
    QUEUED = "queued", "Queued"
    PROCESSING = "processing", "Processing"
    SUCCEEDED = "succeeded", "Succeeded"
    FAILED = "failed", "Failed"


class JobType(models.TextChoices):
    RESOLUTION = "resolution", "Resolution"
    INGESTION = "ingestion", "Ingestion"
    REPROCESS = "reprocess", "Reprocess"


class DuplicateReviewStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    CONFIRMED = "confirmed", "Confirmed"
    DISMISSED = "dismissed", "Dismissed"
    MERGED = "merged", "Merged"


class SourceCatalogEntry(UUIDPrimaryKeyModel, TimeStampedModel):
    source_url = models.URLField(unique=True)
    title = models.CharField(max_length=255)
    author_line = models.CharField(max_length=255, blank=True)
    normalized_title = models.CharField(max_length=255, db_index=True)
    normalized_display = models.CharField(max_length=255, db_index=True)
    raw_data = models.JSONField(default=dict, blank=True)
    last_seen_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["title"]


class BookSubmission(UUIDPrimaryKeyModel, TimeStampedModel):
    submitter = models.ForeignKey(
        "accounts.User",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
        related_name="submissions",
    )
    input_type = models.CharField(max_length=16, choices=SubmissionInputType.choices)
    original_input = models.TextField()
    normalized_input = models.TextField(blank=True)
    resolved_url = models.URLField(blank=True)
    resolution_status = models.CharField(
        max_length=24,
        choices=ResolutionStatus.choices,
        default=ResolutionStatus.UNRESOLVED,
    )
    resolution_confidence = models.FloatField(default=0.0)
    status = models.CharField(max_length=32, choices=SubmissionStatus.choices, default=SubmissionStatus.DRAFT)
    review_state = models.CharField(max_length=32, choices=ReviewState.choices, default=ReviewState.PENDING)
    linked_book = models.ForeignKey(
        "catalog.Book",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
        related_name="linked_submissions",
    )
    duplicate_of_book = models.ForeignKey(
        "catalog.Book",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
        related_name="duplicate_submissions",
    )
    raw_payload = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)

    class Meta:
        ordering = ["-created_at"]


class TitleResolutionAttempt(UUIDPrimaryKeyModel, TimeStampedModel):
    submission = models.ForeignKey(BookSubmission, on_delete=models.CASCADE, related_name="resolution_attempts")
    query = models.TextField()
    normalized_query = models.TextField(blank=True)
    status = models.CharField(max_length=24, choices=ResolutionStatus.choices, default=ResolutionStatus.UNRESOLVED)
    confidence = models.FloatField(default=0.0)
    resolved_url = models.URLField(blank=True)
    raw_results = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)

    class Meta:
        ordering = ["-created_at"]


class MatchCandidate(UUIDPrimaryKeyModel, TimeStampedModel):
    resolution_attempt = models.ForeignKey(
        TitleResolutionAttempt,
        on_delete=models.CASCADE,
        related_name="match_candidates",
    )
    rank = models.PositiveIntegerField(default=0)
    candidate_title = models.CharField(max_length=255)
    candidate_author = models.CharField(max_length=255, blank=True)
    candidate_url = models.URLField()
    confidence = models.FloatField(default=0.0)
    metadata = models.JSONField(default=dict, blank=True)
    is_selected = models.BooleanField(default=False)

    class Meta:
        ordering = ["rank"]


class ProcessingJob(UUIDPrimaryKeyModel, TimeStampedModel):
    submission = models.ForeignKey(
        BookSubmission,
        on_delete=models.CASCADE,
        related_name="processing_jobs",
    )
    book = models.ForeignKey(
        "catalog.Book",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
        related_name="processing_jobs",
    )
    job_type = models.CharField(max_length=24, choices=JobType.choices, default=JobType.INGESTION)
    status = models.CharField(max_length=16, choices=JobStatus.choices, default=JobStatus.QUEUED)
    task_id = models.CharField(max_length=255, blank=True)
    queue_name = models.CharField(max_length=100, blank=True)
    retry_count = models.PositiveIntegerField(default=0)
    payload = models.JSONField(default=dict, blank=True)
    last_error = models.TextField(blank=True)
    started_at = models.DateTimeField(blank=True, null=True)
    finished_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-created_at"]


class ProcessingLog(UUIDPrimaryKeyModel, TimeStampedModel):
    job = models.ForeignKey(ProcessingJob, on_delete=models.CASCADE, related_name="logs")
    level = models.CharField(max_length=16, default="info")
    message = models.TextField()
    details = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["created_at"]


class DuplicateReview(UUIDPrimaryKeyModel, TimeStampedModel):
    submission = models.ForeignKey(BookSubmission, on_delete=models.CASCADE, related_name="duplicate_reviews")
    existing_book = models.ForeignKey("catalog.Book", on_delete=models.CASCADE, related_name="duplicate_reviews")
    detected_by = models.CharField(max_length=50, default="exact_source_url")
    status = models.CharField(
        max_length=24,
        choices=DuplicateReviewStatus.choices,
        default=DuplicateReviewStatus.PENDING,
    )
    notes = models.TextField(blank=True)
    raw_evidence = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]

# Create your models here.
