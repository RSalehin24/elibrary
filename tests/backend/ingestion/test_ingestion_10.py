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
from apps.ingestion.services.curation import (
    dispatch_catalog_curation_run,
    dispatch_source_catalog_refresh,
)
from apps.ingestion.services.submissions import (
    MAX_PROCESSING_JOB_ATTEMPTS,
    create_submission_records,
    detect_metadata_duplicate,
    dispatch_processing_job,
    find_exact_existing_book,
    process_submission_job,
    queue_submission,
    recover_stale_processing_jobs,
    sync_assets,
)
from apps.ingestion.services.curation_support.source_refresh import (
    process_source_catalog_refresh,
)
from apps.ingestion.tasks import process_submission_task
from apps.catalog.services import find_existing_book_by_source_url


def test_scrape_book_data_recurses_through_nested_toc_links(monkeypatch, tmp_path):
    root_url = "https://www.ebanglalibrary.com/books/root-book/"
    child_url = "https://www.ebanglalibrary.com/books/child-book/"
    lesson_url = "https://www.ebanglalibrary.com/books/child-book/chapter-1/"

    html_map = {
        root_url: """
        <html>
          <head><title>মূল বই – লেখক</title></head>
          <body>
            <div class="ld-tab-content ld-visible entry-content">
              <p>মূল বইয়ের ভূমিকা</p>
              <p><strong>সূচীপত্র</strong></p>
              <ul>
                <li><a href="https://www.ebanglalibrary.com/books/child-book/">সংগ্রহ খণ্ড</a></li>
              </ul>
            </div>
          </body>
        </html>
        """,
        child_url: """
        <html>
          <head><title>সংগ্রহ খণ্ড – লেখক</title></head>
          <body>
            <div class="ld-tab-content ld-visible entry-content">
              <p>খণ্ড পরিচিতি</p>
            </div>
          </body>
        </html>
        """,
        lesson_url: """
        <html>
          <head><title>অধ্যায় ১ – লেখক</title></head>
          <body>
            <div class="ld-tab-content ld-visible entry-content">
              <h2>অধ্যায় ১</h2>
              <p>পাতার ভেতরের লেখা</p>
            </div>
          </body>
        </html>
        """,
    }

    monkeypatch.setattr(
        legacy_scraper,
        "get_soup",
        lambda url, max_retries=3: legacy_scraper.BeautifulSoup(
            html_map[url], "html.parser"
        ),
    )
    monkeypatch.setattr(
        legacy_scraper,
        "create_output_folder",
        lambda _title: str(tmp_path / "output"),
    )
    monkeypatch.setattr(legacy_scraper, "download_cover_image", lambda *_args: None)

    def fake_scrape_all_lessons(url):
        if url == child_url:
            return [
                {
                    "title": "অধ্যায় ১",
                    "url": lesson_url,
                    "topics": [],
                    "has_topics": False,
                }
            ]
        return []

    monkeypatch.setattr(legacy_scraper, "scrape_all_lessons", fake_scrape_all_lessons)

    scraped = legacy_scraper.scrape_book_data(root_url)

    assert "মূল বইয়ের ভূমিকা" in scraped["main_content"]
    assert "সূচীপত্র" not in scraped["main_content"]
    assert [entry["title"] for entry in scraped["toc"]] == ["সংগ্রহ খণ্ড"]
    assert [child["title"] for child in scraped["toc"][0]["children"]] == ["অধ্যায় ১"]
    assert [item["title"] for item in scraped["content_items"]] == [
        "সংগ্রহ খণ্ড",
        "অধ্যায় ১",
    ]
    assert scraped["content_items"][0]["path"] == ["সংগ্রহ খণ্ড"]
    assert scraped["content_items"][1]["path"] == ["সংগ্রহ খণ্ড", "অধ্যায় ১"]
    assert "খণ্ড পরিচিতি" in scraped["content_items"][0]["content"]
    assert "পাতার ভেতরের লেখা" in scraped["content_items"][1]["content"]


def test_download_cover_image_uses_retry_session_and_saves_the_cover(monkeypatch, tmp_path):
    class FakeResponse:
        status_code = 200
        content = b"cover-bytes"

        def raise_for_status(self):
            return None

    class FakeSession:
        def __init__(self):
            self.calls = []

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def get(self, url, headers=None, timeout=None):
            self.calls.append(
                {
                    "url": url,
                    "headers": headers,
                    "timeout": timeout,
                }
            )
            return FakeResponse()

    session = FakeSession()
    monkeypatch.setattr(
        legacy_scraper,
        "create_session_with_retries",
        lambda: session,
    )

    soup = legacy_scraper.BeautifulSoup(
        """
        <figure class="entry-image-link entry-image-single">
          <img src="https://cdn.example.com/cover.webp" />
        </figure>
        """,
        "html.parser",
    )

    filename = legacy_scraper.download_cover_image(soup, str(tmp_path))

    assert filename == "book_cover.webp"
    assert session.calls == [
        {
            "url": "https://cdn.example.com/cover.webp",
            "headers": legacy_scraper.HEADERS,
            "timeout": 30,
        }
    ]
    assert (tmp_path / filename).read_bytes() == b"cover-bytes"


def test_scrape_all_lessons_waits_between_pages(monkeypatch):
    seen_urls = []
    sleep_calls = []
    lesson_pages = {
        "https://www.ebanglalibrary.com/books/example/?ld-courseinfo-lesson-page=1": {
            "lessons": [{"title": "প্রথম পাঠ", "url": "lesson-1", "topics": [], "has_topics": False}],
            "total_pages": 2,
        },
        "https://www.ebanglalibrary.com/books/example/?ld-courseinfo-lesson-page=2": {
            "lessons": [{"title": "দ্বিতীয় পাঠ", "url": "lesson-2", "topics": [], "has_topics": False}],
            "total_pages": 2,
        },
    }

    def fake_get_soup(url):
        seen_urls.append(url)
        return url

    monkeypatch.setattr(legacy_scraper, "get_soup", fake_get_soup)
    monkeypatch.setattr(
        legacy_scraper,
        "scrape_lesson_list",
        lambda soup: lesson_pages[soup]["lessons"],
    )
    monkeypatch.setattr(
        legacy_scraper,
        "get_total_pages",
        lambda soup: lesson_pages[soup]["total_pages"],
    )
    monkeypatch.setattr(legacy_scraper.time, "sleep", sleep_calls.append)

    lessons = legacy_scraper.scrape_all_lessons(
        "https://www.ebanglalibrary.com/books/example/",
    )

    assert [lesson["title"] for lesson in lessons] == ["প্রথম পাঠ", "দ্বিতীয় পাঠ"]
    assert seen_urls == [
        "https://www.ebanglalibrary.com/books/example/?ld-courseinfo-lesson-page=1",
        "https://www.ebanglalibrary.com/books/example/?ld-courseinfo-lesson-page=2",
    ]
    assert sleep_calls == [1]


def test_normalize_scraped_book_drops_author_role_when_same_person_is_translator_or_editor():
    normalized = normalize_scraped_book(
        {
            "book_title": "উদাহরণ",
            "author": "ইশরাক অর্ণব, কেইগো হিগাশিনো, সালমান হক",
            "series": "",
            "book_type": "",
            "book_info": """
            <p><strong>অনুবাদ</strong>: ইশরাক অর্ণব</p>
            <p><strong>সম্পাদক</strong>: কেইগো হিগাশিনো</p>
            """,
        }
    )

    contributor_roles = {(entry["name"], entry["role"]) for entry in normalized["contributors"]}

    assert ("সালমান হক", "author") in contributor_roles
    assert ("ইশরাক অর্ণব", "translator") in contributor_roles
    assert ("কেইগো হিগাশিনো", "editor") in contributor_roles
    assert ("ইশরাক অর্ণব", "author") not in contributor_roles
    assert ("কেইগো হিগাশিনো", "author") not in contributor_roles


@pytest.mark.django_db
def test_queue_submission_falls_back_to_inline_processing_when_celery_dispatch_fails(monkeypatch):
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/fallback/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/fallback/"),
        resolved_url="https://www.ebanglalibrary.com/books/fallback/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )

    def fail_apply_async(args=None, task_id=None, **_kwargs):
        raise RuntimeError("Error 111 connecting to redis")

    def fake_process(job_id, retry_count=0, task_id=""):
        job = ProcessingJob.objects.get(pk=job_id)
        job.status = JobStatus.SUCCEEDED
        job.save(update_fields=["status", "updated_at"])
        job.submission.status = SubmissionStatus.READY
        job.submission.save(update_fields=["status", "updated_at"])
        return job

    monkeypatch.setattr("apps.ingestion.tasks.process_submission_task.apply_async", fail_apply_async)
    monkeypatch.setattr("apps.ingestion.services.submissions.process_submission_job", fake_process)

    job = queue_submission(submission)

    assert job.queue_name == "inline-fallback"
    assert "Celery dispatch failed" in job.last_error
    submission.refresh_from_db()
    assert submission.status == SubmissionStatus.READY


@pytest.mark.django_db
def test_queue_submission_inline_fallback_retries_up_to_three_total_attempts(monkeypatch):
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/fallback-retry/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/fallback-retry/"),
        resolved_url="https://www.ebanglalibrary.com/books/fallback-retry/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )
    attempts = []

    def fail_apply_async(args=None, task_id=None, **_kwargs):
        raise RuntimeError("Error 111 connecting to redis")

    def fake_process(job_id, retry_count=0, task_id=""):
        attempts.append(retry_count)
        job = ProcessingJob.objects.get(pk=job_id)
        job.retry_count = retry_count
        if retry_count < MAX_PROCESSING_JOB_ATTEMPTS - 1:
            job.status = JobStatus.FAILED
            job.last_error = f"retry-{retry_count}"
            job.save(update_fields=["retry_count", "status", "last_error", "updated_at"])
            raise RuntimeError(f"retry-{retry_count}")

        job.status = JobStatus.SUCCEEDED
        job.save(update_fields=["retry_count", "status", "updated_at"])
        job.submission.status = SubmissionStatus.READY
        job.submission.save(update_fields=["status", "updated_at"])
        return job

    monkeypatch.setattr("apps.ingestion.tasks.process_submission_task.apply_async", fail_apply_async)
    monkeypatch.setattr("apps.ingestion.services.submissions.process_submission_job", fake_process)

    job = queue_submission(submission)

    assert attempts == [0, 1, 2]
    assert job.queue_name == "inline-fallback"
    submission.refresh_from_db()
    assert submission.status == SubmissionStatus.READY


@pytest.mark.django_db
def test_queue_submission_inline_fallback_stops_after_three_total_attempts(monkeypatch):
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/fallback-stop/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/fallback-stop/"),
        resolved_url="https://www.ebanglalibrary.com/books/fallback-stop/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )
    attempts = []

    def fail_apply_async(args=None, task_id=None, **_kwargs):
        raise RuntimeError("Error 111 connecting to redis")

    def fake_process(job_id, retry_count=0, task_id=""):
        attempts.append(retry_count)
        job = ProcessingJob.objects.get(pk=job_id)
        job.retry_count = retry_count
        job.status = JobStatus.FAILED
        job.last_error = f"retry-{retry_count}"
        job.save(update_fields=["retry_count", "status", "last_error", "updated_at"])
        raise RuntimeError(f"retry-{retry_count}")

    monkeypatch.setattr("apps.ingestion.tasks.process_submission_task.apply_async", fail_apply_async)
    monkeypatch.setattr("apps.ingestion.services.submissions.process_submission_job", fake_process)

    with pytest.raises(RuntimeError, match="retry-2"):
        queue_submission(submission)

    assert attempts == [0, 1, 2]
    job = ProcessingJob.objects.get(submission=submission)
    assert job.retry_count == 2
    assert job.status == JobStatus.FAILED


@pytest.mark.django_db
def test_process_submission_task_returns_serializable_job_payload(monkeypatch):
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/2001-space-odyssey/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/2001-space-odyssey/"),
        resolved_url="https://www.ebanglalibrary.com/books/2001-space-odyssey/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )
    job = ProcessingJob.objects.create(submission=submission, status=JobStatus.SUCCEEDED)

    monkeypatch.setattr("apps.ingestion.tasks.process_submission_job", lambda *args, **kwargs: job)

    result = process_submission_task.apply(args=[str(job.id)])

    assert result.result == {
        "job_id": str(job.id),
        "submission_id": str(submission.id),
        "book_id": "",
        "status": JobStatus.SUCCEEDED,
    }
    json.dumps(result.result)


@pytest.mark.django_db
def test_process_submission_task_uses_three_total_attempts():
    assert process_submission_task.max_retries == 2


@pytest.mark.django_db
def test_process_submission_job_requeues_intermediate_failures_without_becoming_terminal(monkeypatch):
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/retry-intermediate/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/retry-intermediate/"),
        resolved_url="https://www.ebanglalibrary.com/books/retry-intermediate/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )
    job = ProcessingJob.objects.create(
        submission=submission,
        status=JobStatus.QUEUED,
        task_id="celery-retry-task",
        queue_name="celery",
    )

    monkeypatch.setattr(
        "apps.ingestion.services.submissions.capture_source_page_metadata",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "apps.ingestion.services.submissions.find_existing_book_by_source_url",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "apps.ingestion.services.submissions.scrape_book",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("temporary scrape failure")),
    )

    with pytest.raises(RuntimeError, match="temporary scrape failure"):
        process_submission_job(
            str(job.id),
            retry_count=1,
            task_id="celery-retry-task",
        )

    job.refresh_from_db()
    submission.refresh_from_db()
    assert job.status == JobStatus.QUEUED
    assert job.retry_count == 2
    assert job.task_id == "celery-retry-task"
    assert job.queue_name == "celery"
    assert "attempt 2 of 3" in job.last_error
    assert submission.status == SubmissionStatus.QUEUED
    assert submission.error_message == ""


@pytest.mark.django_db
def test_process_submission_job_marks_last_attempt_as_failed(monkeypatch):
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/retry-final/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/retry-final/"),
        resolved_url="https://www.ebanglalibrary.com/books/retry-final/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )
    job = ProcessingJob.objects.create(
        submission=submission,
        status=JobStatus.QUEUED,
        task_id="celery-final-task",
        queue_name="celery",
    )

    monkeypatch.setattr(
        "apps.ingestion.services.submissions.capture_source_page_metadata",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "apps.ingestion.services.submissions.find_existing_book_by_source_url",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "apps.ingestion.services.submissions.scrape_book",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("permanent scrape failure")),
    )

    with pytest.raises(RuntimeError, match="permanent scrape failure"):
        process_submission_job(
            str(job.id),
            retry_count=MAX_PROCESSING_JOB_ATTEMPTS - 1,
            task_id="celery-final-task",
        )

    job.refresh_from_db()
    submission.refresh_from_db()
    assert job.status == JobStatus.FAILED
    assert job.retry_count == MAX_PROCESSING_JOB_ATTEMPTS - 1
    assert job.task_id == ""
    assert job.queue_name == ""
    assert submission.status == SubmissionStatus.FAILED
    assert submission.error_message == "permanent scrape failure"


@pytest.mark.django_db
def test_source_catalog_refresh_ignores_stale_task_after_stop(monkeypatch):
    state = SourceCatalogRefreshState.objects.create(
        singleton_key="default",
        status=SourceCatalogRefreshStatus.IDLE,
        task_id="",
        queue_name="",
    )

    def fail_refresh_catalog(*_args, **_kwargs):
        raise AssertionError("stale source refresh task should not run")

    monkeypatch.setattr(
        "apps.ingestion.services.curation_support.source_refresh.TitleResolver.refresh_catalog",
        fail_refresh_catalog,
    )

    result = process_source_catalog_refresh(task_id="stale-task-id")

    state.refresh_from_db()
    assert result.id == state.id
    assert state.status == SourceCatalogRefreshStatus.IDLE


@pytest.mark.django_db
def test_source_catalog_refresh_ignores_completion_after_stop(monkeypatch):
    SourceCatalogRefreshState.objects.create(
        singleton_key="default",
        status=SourceCatalogRefreshStatus.QUEUED,
        task_id="active-task-id",
        queue_name="celery",
    )

    def fake_refresh_catalog(*_args, **_kwargs):
        state = SourceCatalogRefreshState.objects.get(singleton_key="default")
        state.status = SourceCatalogRefreshStatus.IDLE
        state.task_id = ""
        state.queue_name = ""
        state.last_error = "Stopped by user."
        state.finished_at = timezone.now()
        state.save(update_fields=["status", "task_id", "queue_name", "last_error", "finished_at", "updated_at"])
        return [{"source_url": "https://www.ebanglalibrary.com/books/new-book/"}]

    monkeypatch.setattr(
        "apps.ingestion.services.curation_support.source_refresh.TitleResolver.refresh_catalog",
        fake_refresh_catalog,
    )

    result = process_source_catalog_refresh(task_id="active-task-id")

    state = SourceCatalogRefreshState.objects.get(singleton_key="default")
    assert result.id == state.id
    assert state.status == SourceCatalogRefreshStatus.IDLE
    assert state.task_id == ""
    assert state.last_error == "Stopped by user."
    assert state.refreshed_entries == 0


@pytest.mark.django_db
def test_source_catalog_refresh_ignores_completion_after_replacement(monkeypatch):
    SourceCatalogRefreshState.objects.create(
        singleton_key="default",
        status=SourceCatalogRefreshStatus.QUEUED,
        task_id="old-task-id",
        queue_name="celery",
    )

    def fake_refresh_catalog(*_args, **_kwargs):
        state = SourceCatalogRefreshState.objects.get(singleton_key="default")
        state.status = SourceCatalogRefreshStatus.QUEUED
        state.task_id = "new-task-id"
        state.queue_name = "celery"
        state.last_error = ""
        state.finished_at = None
        state.save(update_fields=["status", "task_id", "queue_name", "last_error", "finished_at", "updated_at"])
        return [{"source_url": "https://www.ebanglalibrary.com/books/new-book/"}]

    monkeypatch.setattr(
        "apps.ingestion.services.curation_support.source_refresh.TitleResolver.refresh_catalog",
        fake_refresh_catalog,
    )

    result = process_source_catalog_refresh(task_id="old-task-id")

    state = SourceCatalogRefreshState.objects.get(singleton_key="default")
    assert result.id == state.id
    assert state.status == SourceCatalogRefreshStatus.QUEUED
    assert state.task_id == "new-task-id"
    assert state.queue_name == "celery"
    assert state.refreshed_entries == 0


@pytest.mark.django_db
def test_source_catalog_refresh_ignores_failure_after_replacement(monkeypatch):
    SourceCatalogRefreshState.objects.create(
        singleton_key="default",
        status=SourceCatalogRefreshStatus.QUEUED,
        task_id="old-task-id",
        queue_name="celery",
    )

    def fail_refresh_catalog(*_args, **_kwargs):
        state = SourceCatalogRefreshState.objects.get(singleton_key="default")
        state.status = SourceCatalogRefreshStatus.QUEUED
        state.task_id = "new-task-id"
        state.queue_name = "celery"
        state.last_error = ""
        state.finished_at = None
        state.save(update_fields=["status", "task_id", "queue_name", "last_error", "finished_at", "updated_at"])
        raise RuntimeError("old refresh failed after replacement")

    monkeypatch.setattr(
        "apps.ingestion.services.curation_support.source_refresh.TitleResolver.refresh_catalog",
        fail_refresh_catalog,
    )

    result = process_source_catalog_refresh(task_id="old-task-id")

    state = SourceCatalogRefreshState.objects.get(singleton_key="default")
    assert result.id == state.id
    assert state.status == SourceCatalogRefreshStatus.QUEUED
    assert state.task_id == "new-task-id"
    assert state.queue_name == "celery"
    assert state.last_error == ""


@pytest.mark.django_db
def test_dispatch_processing_job_returns_failed_job_after_eager_execution_error(monkeypatch, settings):
    settings.CELERY_TASK_ALWAYS_EAGER = True
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/eager-job/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/eager-job/"),
        resolved_url="https://www.ebanglalibrary.com/books/eager-job/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )
    job = ProcessingJob.objects.create(submission=submission, status=JobStatus.QUEUED)

    def fake_apply_async(args=None, task_id=None, **_kwargs):
        eager_job = ProcessingJob.objects.get(pk=args[0])
        eager_job.status = JobStatus.FAILED
        eager_job.task_id = task_id
        eager_job.queue_name = "celery"
        eager_job.last_error = "eager-job-failure"
        eager_job.finished_at = timezone.now()
        eager_job.save(update_fields=["status", "task_id", "queue_name", "last_error", "finished_at", "updated_at"])
        eager_job.submission.status = SubmissionStatus.FAILED
        eager_job.submission.error_message = "eager-job-failure"
        eager_job.submission.save(update_fields=["status", "error_message", "updated_at"])
        raise RuntimeError("eager-job-failure")

    monkeypatch.setattr("apps.ingestion.tasks.process_submission_task.apply_async", fake_apply_async)
    monkeypatch.setattr(
        "apps.ingestion.services.submissions.process_submission_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("inline fallback should not rerun eager job failures")),
    )

    result = dispatch_processing_job(job)

    job.refresh_from_db()
    submission.refresh_from_db()
    assert result.id == job.id
    assert job.status == JobStatus.FAILED
    assert job.queue_name == "celery"
    assert job.task_id
    assert submission.status == SubmissionStatus.FAILED


@pytest.mark.django_db
def test_dispatch_source_catalog_refresh_returns_failed_state_after_eager_execution_error(monkeypatch, settings):
    settings.CELERY_TASK_ALWAYS_EAGER = True
    state = SourceCatalogRefreshState.objects.create(
        singleton_key="default",
        status=SourceCatalogRefreshStatus.QUEUED,
        task_id="",
        queue_name="",
    )

    def fake_apply_async(*_args, task_id=None, **_kwargs):
        refresh_state = SourceCatalogRefreshState.objects.get(singleton_key="default")
        refresh_state.status = SourceCatalogRefreshStatus.FAILED
        refresh_state.task_id = task_id or refresh_state.task_id
        refresh_state.queue_name = "celery"
        refresh_state.last_error = "eager-refresh-failure"
        refresh_state.finished_at = timezone.now()
        refresh_state.save(update_fields=["status", "task_id", "queue_name", "last_error", "finished_at", "updated_at"])
        raise RuntimeError("eager-refresh-failure")

    monkeypatch.setattr("apps.ingestion.tasks.refresh_source_catalog_task.apply_async", fake_apply_async)
    monkeypatch.setattr(
        "apps.ingestion.services.curation.process_source_catalog_refresh",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("inline fallback should not rerun eager refresh failures")),
    )

    result = dispatch_source_catalog_refresh(state)

    state.refresh_from_db()
    assert result.id == state.id
    assert state.status == SourceCatalogRefreshStatus.FAILED
    assert state.queue_name == "celery"
    assert state.task_id


@pytest.mark.django_db
def test_dispatch_catalog_curation_run_returns_failed_run_after_eager_execution_error(monkeypatch, settings):
    settings.CELERY_TASK_ALWAYS_EAGER = True
    run = CatalogCurationRun.objects.create(status=JobStatus.QUEUED)

    def fake_apply_async(args=None, task_id=None, **_kwargs):
        eager_run = CatalogCurationRun.objects.get(pk=args[0])
        eager_run.status = JobStatus.FAILED
        eager_run.task_id = task_id or eager_run.task_id
        eager_run.queue_name = "celery"
        eager_run.last_error = "eager-run-failure"
        eager_run.finished_at = timezone.now()
        eager_run.save(update_fields=["status", "task_id", "queue_name", "last_error", "finished_at", "updated_at"])
        raise RuntimeError("eager-run-failure")

    monkeypatch.setattr("apps.ingestion.tasks.process_catalog_curation_run_task.apply_async", fake_apply_async)
    monkeypatch.setattr(
        "apps.ingestion.services.curation.process_catalog_curation_run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("inline fallback should not rerun eager curation failures")),
    )

    result = dispatch_catalog_curation_run(run)

    run.refresh_from_db()
    assert result.id == run.id
    assert run.status == JobStatus.FAILED
    assert run.queue_name == "celery"
    assert run.task_id


@pytest.mark.django_db
def test_recover_stale_processing_jobs_requeues_stale_processing_work(monkeypatch):
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/stale-processing/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/stale-processing/"),
        resolved_url="https://www.ebanglalibrary.com/books/stale-processing/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.PROCESSING,
    )
    job = ProcessingJob.objects.create(
        submission=submission,
        status=JobStatus.PROCESSING,
        retry_count=0,
        task_id="stale-task-id",
        queue_name="celery",
        started_at=timezone.now() - timedelta(minutes=45),
    )
    revoked = []
    dispatched = []

    monkeypatch.setattr(
        "apps.ingestion.services.submissions.revoke_processing_task",
        lambda task_id, terminate=False: revoked.append((task_id, terminate)),
    )

    def fake_apply_async(args=None, kwargs=None, task_id=None, **_extra_kwargs):
        dispatched.append(
            {
                "args": args,
                "kwargs": kwargs,
                "task_id": task_id,
            }
        )
        return type("AsyncResult", (), {"id": task_id})()

    monkeypatch.setattr(
        "apps.ingestion.tasks.process_submission_task.apply_async",
        fake_apply_async,
    )

    recovered = recover_stale_processing_jobs(limit=10)

    job.refresh_from_db()
    submission.refresh_from_db()
    assert recovered == 1
    assert revoked == [("stale-task-id", True)]
    assert dispatched == [
        {
            "args": [str(job.id)],
            "kwargs": {"attempt_offset": 1},
            "task_id": job.task_id,
        }
    ]
    assert job.status == JobStatus.QUEUED
    assert job.retry_count == 1
    assert job.queue_name == "celery"
    assert job.task_id
    assert job.last_error
    assert submission.status == SubmissionStatus.QUEUED
    assert submission.error_message == ""


@pytest.mark.django_db
def test_recover_stale_processing_jobs_fails_exhausted_processing_work(monkeypatch):
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/stale-processing-final/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/stale-processing-final/"),
        resolved_url="https://www.ebanglalibrary.com/books/stale-processing-final/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.PROCESSING,
    )
    job = ProcessingJob.objects.create(
        submission=submission,
        status=JobStatus.PROCESSING,
        retry_count=MAX_PROCESSING_JOB_ATTEMPTS - 1,
        task_id="stale-final-task-id",
        queue_name="celery",
        started_at=timezone.now() - timedelta(minutes=45),
    )
    revoked = []

    monkeypatch.setattr(
        "apps.ingestion.services.submissions.revoke_processing_task",
        lambda task_id, terminate=False: revoked.append((task_id, terminate)),
    )
    monkeypatch.setattr(
        "apps.ingestion.tasks.process_submission_task.apply_async",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("exhausted stale jobs must not be re-dispatched")
        ),
    )

    recovered = recover_stale_processing_jobs(limit=10)

    job.refresh_from_db()
    submission.refresh_from_db()
    assert recovered == 0
    assert revoked == [("stale-final-task-id", True)]
    assert job.status == JobStatus.FAILED
    assert job.task_id == ""
    assert job.queue_name == ""
    assert submission.status == SubmissionStatus.FAILED
    assert submission.error_message == job.last_error
