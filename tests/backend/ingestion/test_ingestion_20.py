import pytest
from django.db import connection
from django.db import ProgrammingError
from django.test.utils import CaptureQueriesContext

from apps.accounts.models import User
from apps.catalog.models import Book
from apps.ingestion.models import (
    BookSubmission,
    CatalogCurationRun,
    DuplicateReview,
    JobStatus,
    ProcessingJob,
    SourceCatalogRefreshState,
    SourceCatalogRefreshStatus,
    SubmissionOrigin,
    SubmissionStatus,
)
from apps.ingestion.tasks import (
    recover_stale_processing_jobs_task,
    run_catalog_automation_schedule_task,
)


HEAVY_BOOK_COLUMNS = (
    '"catalog_book"."summary"',
    '"catalog_book"."raw_scraped_metadata"',
    '"catalog_book"."raw_scrape_payload"',
    '"catalog_book"."main_content_html"',
    '"catalog_book"."book_info_html"',
    '"catalog_book"."dedication_html"',
    '"catalog_book"."toc"',
    '"catalog_book"."content_items"',
)


def assert_queries_do_not_select_columns(captured_queries, table_name, forbidden_columns):
    matching_queries = [
        query["sql"]
        for query in captured_queries.captured_queries
        if table_name in query["sql"] and "COUNT(" not in query["sql"]
    ]
    assert matching_queries
    for sql in matching_queries:
        for column in forbidden_columns:
            assert column not in sql


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


@pytest.mark.django_db
def test_recover_stale_processing_jobs_task_returns_recovered_count(monkeypatch):
    calls = []

    def fake_recover_stale_processing_jobs(*, origin="", limit=100):
        calls.append((origin, limit))
        return {
            SubmissionOrigin.USER: 2,
            SubmissionOrigin.CURATION: 1,
        }.get(origin, 0)

    monkeypatch.setattr(
        "apps.ingestion.tasks.recover_stale_processing_jobs",
        fake_recover_stale_processing_jobs,
    )
    monkeypatch.setattr(
        "apps.ingestion.tasks.get_catalog_automation_settings",
        lambda: type("AutomationSettings", (), {"enabled": False})(),
    )

    assert recover_stale_processing_jobs_task() == {"recovered_jobs": 3}
    assert calls == [
        (SubmissionOrigin.USER, 100),
        (SubmissionOrigin.CURATION, 98),
    ]


@pytest.mark.django_db
def test_recover_stale_processing_jobs_task_recovers_automation_work_only_when_enabled(monkeypatch):
    calls = []

    def fake_recover_stale_processing_jobs(*, origin="", limit=100):
        calls.append((origin, limit))
        return {
            SubmissionOrigin.USER: 1,
            SubmissionOrigin.CURATION: 2,
            SubmissionOrigin.AUTOMATION: 4,
        }[origin]

    monkeypatch.setattr(
        "apps.ingestion.tasks.recover_stale_processing_jobs",
        fake_recover_stale_processing_jobs,
    )
    monkeypatch.setattr(
        "apps.ingestion.tasks.get_catalog_automation_settings",
        lambda: type("AutomationSettings", (), {"enabled": True})(),
    )

    assert recover_stale_processing_jobs_task() == {"recovered_jobs": 7}
    assert calls == [
        (SubmissionOrigin.USER, 100),
        (SubmissionOrigin.CURATION, 99),
        (SubmissionOrigin.AUTOMATION, 97),
    ]


@pytest.mark.django_db
def test_submission_list_avoids_loading_heavy_linked_book_columns(client):
    admin = User.objects.create_superuser(
        email="submission-list-admin@example.com",
        password="strong-password-123",
    )
    book = Book.objects.create(
        title="ভারী প্রসেসিং বই",
        state="ready",
        review_state="approved",
        summary="Summary",
        raw_scraped_metadata={"source": "seed"},
        raw_scrape_payload={"payload": "seed"},
        main_content_html="<p>Heavy content</p>",
        book_info_html="<p>Book info</p>",
        dedication_html="<p>Dedication</p>",
        toc=[{"label": "One", "href": "#one"}],
        content_items=[{"title": "One", "slug": "one"}],
    )
    submission = BookSubmission.objects.create(
        submitter=admin,
        input_type="url",
        original_input="https://example.com/heavy-submission",
        normalized_input="heavy-submission",
        resolved_url="https://example.com/heavy-submission",
        resolution_status="resolved",
        resolution_confidence=1.0,
        status=SubmissionStatus.READY,
        origin=SubmissionOrigin.CURATION,
        linked_book=book,
    )
    ProcessingJob.objects.create(
        submission=submission,
        book=book,
        status=JobStatus.SUCCEEDED,
        payload={"heavy": "payload"},
    )
    client.force_login(admin)

    with CaptureQueriesContext(connection) as captured_queries:
        response = client.get("/api/ingestion/submissions/?limit=1&origin=curation")

    assert response.status_code == 200
    assert_queries_do_not_select_columns(
        captured_queries,
        '"catalog_book"',
        HEAVY_BOOK_COLUMNS,
    )
    assert_queries_do_not_select_columns(
        captured_queries,
        '"ingestion_processingjob"',
        ('"ingestion_processingjob"."payload"',),
    )
    assert_queries_do_not_select_columns(
        captured_queries,
        '"ingestion_titleresolutionattempt"',
        ('"ingestion_titleresolutionattempt"."raw_results"',),
    )


@pytest.mark.django_db
def test_processing_job_list_avoids_loading_heavy_book_columns(client):
    admin = User.objects.create_superuser(
        email="job-list-admin@example.com",
        password="strong-password-123",
    )
    book = Book.objects.create(
        title="ভারী জব বই",
        state="ready",
        review_state="approved",
        summary="Summary",
        raw_scraped_metadata={"source": "seed"},
        raw_scrape_payload={"payload": "seed"},
        main_content_html="<p>Heavy content</p>",
        book_info_html="<p>Book info</p>",
        dedication_html="<p>Dedication</p>",
        toc=[{"label": "One", "href": "#one"}],
        content_items=[{"title": "One", "slug": "one"}],
    )
    submission = BookSubmission.objects.create(
        submitter=admin,
        input_type="url",
        original_input="https://example.com/heavy-job",
        normalized_input="heavy-job",
        status=SubmissionStatus.PROCESSING,
        origin=SubmissionOrigin.CURATION,
        linked_book=book,
    )
    ProcessingJob.objects.create(
        submission=submission,
        book=book,
        status=JobStatus.PROCESSING,
        payload={"heavy": "payload"},
    )
    client.force_login(admin)

    with CaptureQueriesContext(connection) as captured_queries:
        response = client.get("/api/ingestion/jobs/?limit=1&origin=curation")

    assert response.status_code == 200
    assert_queries_do_not_select_columns(
        captured_queries,
        '"catalog_book"',
        HEAVY_BOOK_COLUMNS,
    )
    assert_queries_do_not_select_columns(
        captured_queries,
        '"ingestion_processingjob"',
        ('"ingestion_processingjob"."payload"',),
    )


@pytest.mark.django_db
def test_duplicate_review_list_avoids_loading_heavy_book_columns(client):
    admin = User.objects.create_superuser(
        email="duplicate-list-admin@example.com",
        password="strong-password-123",
    )
    linked_book = Book.objects.create(
        title="লিঙ্কড বই",
        state="ready",
        review_state="approved",
        summary="Summary",
        raw_scraped_metadata={"source": "seed"},
        raw_scrape_payload={"payload": "seed"},
        main_content_html="<p>Heavy content</p>",
        book_info_html="<p>Book info</p>",
        dedication_html="<p>Dedication</p>",
        toc=[{"label": "One", "href": "#one"}],
        content_items=[{"title": "One", "slug": "one"}],
    )
    existing_book = Book.objects.create(
        title="বিদ্যমান বই",
        state="ready",
        review_state="approved",
        summary="Summary",
        raw_scraped_metadata={"source": "seed"},
        raw_scrape_payload={"payload": "seed"},
        main_content_html="<p>Heavy content</p>",
        book_info_html="<p>Book info</p>",
        dedication_html="<p>Dedication</p>",
        toc=[{"label": "One", "href": "#one"}],
        content_items=[{"title": "One", "slug": "one"}],
    )
    submission = BookSubmission.objects.create(
        submitter=admin,
        input_type="url",
        original_input="https://example.com/heavy-duplicate",
        normalized_input="heavy-duplicate",
        resolved_url="https://example.com/heavy-duplicate",
        resolution_status="resolved",
        resolution_confidence=1.0,
        status=SubmissionStatus.DUPLICATE,
        origin=SubmissionOrigin.CURATION,
        linked_book=linked_book,
    )
    ProcessingJob.objects.create(
        submission=submission,
        book=linked_book,
        status=JobStatus.FAILED,
        payload={"heavy": "payload"},
    )
    DuplicateReview.objects.create(
        submission=submission,
        existing_book=existing_book,
        raw_evidence={"kind": "source-url"},
    )
    client.force_login(admin)

    with CaptureQueriesContext(connection) as captured_queries:
        response = client.get("/api/ingestion/duplicate-reviews/?limit=1&origin=curation")

    assert response.status_code == 200
    assert_queries_do_not_select_columns(
        captured_queries,
        '"catalog_book"',
        HEAVY_BOOK_COLUMNS,
    )
    assert_queries_do_not_select_columns(
        captured_queries,
        '"ingestion_processingjob"',
        ('"ingestion_processingjob"."payload"',),
    )
    assert_queries_do_not_select_columns(
        captured_queries,
        '"ingestion_titleresolutionattempt"',
        ('"ingestion_titleresolutionattempt"."raw_results"',),
    )
