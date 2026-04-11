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

    def fail_delay(job_id):
        raise RuntimeError("Error 111 connecting to redis")

    def fake_process(job_id, retry_count=0, task_id=""):
        job = ProcessingJob.objects.get(pk=job_id)
        job.status = JobStatus.SUCCEEDED
        job.save(update_fields=["status", "updated_at"])
        job.submission.status = SubmissionStatus.READY
        job.submission.save(update_fields=["status", "updated_at"])
        return job

    monkeypatch.setattr("apps.ingestion.tasks.process_submission_task.delay", fail_delay)
    monkeypatch.setattr("apps.ingestion.services.submissions.process_submission_job", fake_process)

    job = queue_submission(submission)

    assert job.queue_name == "inline-fallback"
    assert "Celery dispatch failed" in job.last_error
    submission.refresh_from_db()
    assert submission.status == SubmissionStatus.READY


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
