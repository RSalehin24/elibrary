import json
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import pytest
import requests
from django.db import IntegrityError
from django.utils import timezone

from apps.access.models import PreviewAccessSession
from apps.accounts.models import User
from apps.catalog.models import Book, BookContributor, BookSource, Category, Contributor, GeneratedAsset, GeneratedAssetStatus, GeneratedAssetType, Series
from apps.common.models import LifecycleState, ReviewState
from apps.ingestion.models import (
    CatalogAutomationFrequency,
    BookSubmission,
    CatalogCurationRun,
    DuplicateReview,
    DuplicateReviewStatus,
    JobStatus,
    MatchCandidate,
    ProcessingJob,
    ResolutionStatus,
    SourceCatalogEntry,
    SourceCatalogRefreshState,
    SourceCatalogRefreshStatus,
    SubmissionOrigin,
    SubmissionStatus,
    TitleResolutionAttempt,
)
from apps.ingestion.services.curation import (
    get_catalog_automation_settings,
    next_catalog_automation_run_at,
    run_due_catalog_automation,
    source_catalog_entry_snapshots,
)
from apps.ingestion.pipeline import scraper as legacy_scraper
from apps.ingestion.services.legacy_adapter import normalize_text
from apps.ingestion.services.legacy_adapter import normalize_source_url
from apps.ingestion.services.normalization import (
    clean_extracted_dedication_html,
    extract_main_content_segments,
    extract_front_matter_entries,
    normalize_scraped_book,
    promote_leading_front_matter,
    split_leading_front_sections,
)
from apps.ingestion.services.resolution import CATALOG_URL, TitleResolver, get_with_host_fallback
from apps.ingestion.services.submissions import (
    create_submission_records,
    detect_metadata_duplicate,
    find_exact_existing_book,
    process_submission_job,
    queue_submission,
    sync_assets,
)
from apps.ingestion.tasks import process_submission_task
from apps.catalog.services import find_existing_book_by_source_url


@pytest.mark.django_db
def test_processing_manager_can_queue_deleted_catalog_entry_for_recreation(client, monkeypatch):
    admin = User.objects.create_superuser(email="catalog-recreate-admin@example.com", password="strong-password-123")
    client.force_login(admin)
    deleted_book = Book.objects.create(title="Deleted Book", state="soft_deleted", review_state="pending")
    Book.objects.filter(pk=deleted_book.pk).update(deleted_at=timezone.now())
    deleted_book.refresh_from_db()
    entry = SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/deleted-book/",
        title="Deleted Book",
        author_line="Writer",
        normalized_title=normalize_text("Deleted Book"),
        normalized_display=normalize_text("Deleted Book Writer"),
    )
    BookSource.objects.create(
        book=deleted_book,
        source_url=entry.source_url,
        normalized_source_url=entry.source_url,
        source_title=entry.title,
    )
    queued_entries = []

    def fake_create_submission_records(*, submitter, parsed_entries, auto_process, origin):
        queued_entries.extend(parsed_entries)
        assert submitter == admin
        assert auto_process is True
        assert origin == SubmissionOrigin.CURATION
        return []

    monkeypatch.setattr("apps.ingestion.views.create_submission_records", fake_create_submission_records)

    response = client.post(
        "/api/ingestion/catalog/entries/create-books/",
        data=json.dumps({"ids": [str(entry.id)]}),
        content_type="application/json",
    )

    assert response.status_code == 202
    assert response.json()["queued_creates"] == 1
    assert response.json()["skipped_deleted"] == 0
    assert queued_entries == [{"kind": "url", "value": entry.source_url}]


@pytest.mark.django_db
def test_sync_assets_marks_book_for_review_when_epub_is_missing(tmp_path):
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/missing-epub/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/missing-epub/"),
        resolved_url="https://www.ebanglalibrary.com/books/missing-epub/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.PROCESSING,
    )
    job = ProcessingJob.objects.create(submission=submission, status=JobStatus.PROCESSING)
    book = Book.objects.create(title="Missing EPUB", state="ready", review_state="pending")
    html_path = tmp_path / "book.html"
    html_path.write_text("<html><body>ok</body></html>", encoding="utf-8")

    with pytest.raises(ValueError, match="Missing generated assets: EPUB"):
        sync_assets(
            book,
            job,
            {
                "book_title": "Missing EPUB",
                "output_folder": str(tmp_path),
                "cover": "",
            },
        )

    book.refresh_from_db()
    assert book.state == "needs_review"
    assert book.review_state == "needs_review"
    assert GeneratedAsset.objects.get(book=book, asset_type=GeneratedAssetType.HTML).status == GeneratedAssetStatus.READY
    assert GeneratedAsset.objects.get(book=book, asset_type=GeneratedAssetType.EPUB).status == GeneratedAssetStatus.FAILED


@pytest.mark.django_db
def test_processing_manager_can_start_catalog_curation_run(client, monkeypatch):
    admin = User.objects.create_superuser(email="curation-admin@example.com", password="strong-password-123")
    queued_run = CatalogCurationRun.objects.create(
        trigger="manual",
        mode="pending",
        status="queued",
        refresh_catalog=True,
        refresh_max_pages=80,
        requested_by=admin,
    )
    client.force_login(admin)

    monkeypatch.setattr("apps.ingestion.views.create_catalog_curation_run", lambda **kwargs: queued_run)

    response = client.post(
        "/api/ingestion/catalog/curation-runs/",
        data=json.dumps({"mode": "pending", "refresh_catalog": True, "refresh_max_pages": 80}),
        content_type="application/json",
    )

    assert response.status_code == 202
    assert response.json()["id"] == str(queued_run.id)
    assert response.json()["status"] == "queued"


@pytest.mark.django_db
def test_processing_manager_can_update_catalog_automation_settings(client):
    admin = User.objects.create_superuser(email="automation-admin@example.com", password="strong-password-123")
    client.force_login(admin)

    response = client.patch(
        "/api/ingestion/catalog/automation/",
        data=json.dumps(
            {
                "enabled": True,
                "daily_run_time": "03:45",
                "frequency": "weekly",
                "mode": "all",
                "refresh_max_pages": 40,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()["settings"]
    assert payload["enabled"] is True
    assert payload["daily_run_time"].startswith("03:45")
    assert payload["frequency"] == "weekly"
    assert payload["mode"] == "all"
    assert payload["refresh_max_pages"] == 40


@pytest.mark.django_db
def test_processing_lists_filter_by_origin_and_recover_stale_jobs(client, monkeypatch):
    admin = User.objects.create_superuser(email="origin-admin@example.com", password="strong-password-123")
    client.force_login(admin)

    user_submission = BookSubmission.objects.create(
        input_type="url",
        origin=SubmissionOrigin.USER,
        original_input="https://www.ebanglalibrary.com/books/user-book/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/user-book/"),
        resolved_url="https://www.ebanglalibrary.com/books/user-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )
    curation_submission = BookSubmission.objects.create(
        input_type="url",
        origin=SubmissionOrigin.CURATION,
        original_input="https://www.ebanglalibrary.com/books/source-book/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/source-book/"),
        resolved_url="https://www.ebanglalibrary.com/books/source-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )
    user_job = ProcessingJob.objects.create(submission=user_submission, status=JobStatus.QUEUED)
    ProcessingJob.objects.create(submission=curation_submission, status=JobStatus.QUEUED, task_id="already-dispatched")
    dispatched_ids = []

    def fake_dispatch(job, force=False):
        dispatched_ids.append(str(job.id))
        job.task_id = f"task-{job.id}"
        job.queue_name = "celery"
        job.save(update_fields=["task_id", "queue_name", "updated_at"])
        return job

    monkeypatch.setattr("apps.ingestion.services.submissions.dispatch_processing_job", fake_dispatch)

    job_response = client.get("/api/ingestion/jobs/?origin=user")
    submission_response = client.get("/api/ingestion/submissions/?origin=curation")
    recover_response = client.post(
        "/api/ingestion/jobs/recover/",
        data=json.dumps({"origin": "user"}),
        content_type="application/json",
    )

    assert job_response.status_code == 200
    assert [entry["id"] for entry in job_response.json()] == [str(user_job.id)]
    assert submission_response.status_code == 200
    assert [entry["id"] for entry in submission_response.json()] == [str(curation_submission.id)]
    assert recover_response.status_code == 202
    assert recover_response.json()["recovered_jobs"] == 1
    assert dispatched_ids == [str(user_job.id)]
