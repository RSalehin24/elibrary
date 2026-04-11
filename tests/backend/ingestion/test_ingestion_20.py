import pytest
from django.db import ProgrammingError

from apps.accounts.models import User
from apps.ingestion.models import (
    BookSubmission,
    CatalogCurationRun,
    JobStatus,
    ProcessingJob,
    SourceCatalogRefreshState,
    SourceCatalogRefreshStatus,
    SubmissionOrigin,
    SubmissionStatus,
)
from apps.ingestion.tasks import run_catalog_automation_schedule_task


@pytest.mark.django_db
def test_processing_activity_endpoint_limits_regular_users_to_their_visible_work(client):
    user = User.objects.create_user(
        email="activity-reader@example.com",
        password="strong-password-123",
    )
    other_user = User.objects.create_user(
        email="activity-other@example.com",
        password="strong-password-123",
    )
    client.force_login(user)

    own_submission = BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input="https://example.com/own",
        normalized_input="own",
        status=SubmissionStatus.PENDING_RESOLUTION,
        origin=SubmissionOrigin.USER,
    )
    ProcessingJob.objects.create(
        submission=own_submission,
        status=JobStatus.QUEUED,
    )

    hidden_submission = BookSubmission.objects.create(
        submitter=other_user,
        input_type="url",
        original_input="https://example.com/hidden",
        normalized_input="hidden",
        status=SubmissionStatus.PROCESSING,
        origin=SubmissionOrigin.USER,
    )
    ProcessingJob.objects.create(
        submission=hidden_submission,
        status=JobStatus.PROCESSING,
    )

    response = client.get("/api/ingestion/activity/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["can_manage_processing"] is False
    assert payload["has_visible_activity"] is True
    assert payload["active_scopes"] == ["submissions", "jobs"]


@pytest.mark.django_db
def test_processing_activity_endpoint_reports_shared_manager_activity(client):
    admin = User.objects.create_superuser(
        email="activity-admin@example.com",
        password="strong-password-123",
    )
    client.force_login(admin)

    source_submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://example.com/source",
        normalized_input="source",
        status=SubmissionStatus.QUEUED,
        origin=SubmissionOrigin.CURATION,
    )
    automation_submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://example.com/automation",
        normalized_input="automation",
        status=SubmissionStatus.PROCESSING,
        origin=SubmissionOrigin.AUTOMATION,
    )
    ProcessingJob.objects.create(
        submission=source_submission,
        status=JobStatus.QUEUED,
    )
    ProcessingJob.objects.create(
        submission=automation_submission,
        status=JobStatus.PROCESSING,
    )
    CatalogCurationRun.objects.create(status=JobStatus.PROCESSING)
    SourceCatalogRefreshState.objects.create(
        singleton_key="default",
        status=SourceCatalogRefreshStatus.PROCESSING,
        max_pages=8,
    )

    response = client.get("/api/ingestion/activity/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["can_manage_processing"] is True
    assert payload["has_visible_activity"] is True
    assert set(payload["active_scopes"]) == {
        "submissions",
        "jobs",
        "source_jobs",
        "automation_jobs",
        "runs",
        "catalog_refresh",
    }


@pytest.mark.django_db
def test_catalog_automation_schedule_task_skips_when_schema_is_not_ready(monkeypatch):
    def fail_due_schedule():
        raise ProgrammingError('relation "ingestion_catalogautomationsettings" does not exist')

    monkeypatch.setattr("apps.ingestion.tasks.run_due_catalog_automation", fail_due_schedule)

    result = run_catalog_automation_schedule_task()

    assert result == {"ran": False, "reason": "schema_not_ready"}


@pytest.mark.django_db
def test_catalog_automation_schedule_task_reraises_unrelated_database_errors(monkeypatch):
    def fail_due_schedule():
        raise ProgrammingError("column ingestion_catalogautomationsettings.mode does not exist")

    monkeypatch.setattr("apps.ingestion.tasks.run_due_catalog_automation", fail_due_schedule)

    with pytest.raises(ProgrammingError, match="column ingestion_catalogautomationsettings.mode does not exist"):
        run_catalog_automation_schedule_task()
