import json
from pathlib import Path

import pytest

from apps.access.models import PreviewAccessSession
from apps.accounts.models import User
from apps.catalog.models import Book, BookSource, Category, Contributor, GeneratedAssetType, Series
from apps.ingestion.models import (
    BookSubmission,
    DuplicateReview,
    DuplicateReviewStatus,
    JobStatus,
    ProcessingJob,
    SourceCatalogEntry,
    SubmissionStatus,
)
from apps.ingestion.services.legacy_adapter import normalize_text
from apps.ingestion.services.submissions import process_submission_job


@pytest.mark.django_db
def test_title_submission_surfaces_exact_match_without_guessing(client, settings, monkeypatch):
    settings.CELERY_TASK_ALWAYS_EAGER = False
    user = User.objects.create_user(email="submitter@example.com", password="strong-password-123")
    client.force_login(user)

    SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/sample-book/",
        title="স্যাম্পল বুক",
        author_line="লেখক",
        normalized_title=normalize_text("স্যাম্পল বুক"),
        normalized_display=normalize_text("স্যাম্পল বুক লেখক"),
    )

    response = client.post(
        "/api/ingestion/submissions/",
        data=json.dumps(
            {
                "input_type": "title",
                "content": "স্যাম্পল বুক",
                "auto_process": False,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 201
    payload = response.json()[0]
    assert payload["resolution_status"] == "exact_match"
    assert payload["status"] == "queued"
    assert payload["resolved_url"] == "https://www.ebanglalibrary.com/books/sample-book/"


@pytest.mark.django_db
def test_confirm_candidate_requires_manual_choice_for_ambiguous_title(client, monkeypatch):
    user = User.objects.create_user(email="reviewer@example.com", password="strong-password-123")
    client.force_login(user)

    SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/sample-book-one/",
        title="স্যাম্পল বুক এক",
        author_line="লেখক",
        normalized_title=normalize_text("স্যাম্পল বুক এক"),
        normalized_display=normalize_text("স্যাম্পল বুক এক লেখক"),
    )
    SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/sample-book-two/",
        title="স্যাম্পল বুক দুই",
        author_line="লেখক",
        normalized_title=normalize_text("স্যাম্পল বুক দুই"),
        normalized_display=normalize_text("স্যাম্পল বুক দুই লেখক"),
    )

    created = client.post(
        "/api/ingestion/submissions/",
        data=json.dumps(
            {
                "input_type": "title",
                "content": "স্যাম্পল বুক",
                "auto_process": False,
            }
        ),
        content_type="application/json",
    )
    assert created.status_code == 201
    payload = created.json()[0]
    assert payload["status"] == "needs_review"
    assert len(payload["candidates"]) == 2

    called = {}

    def fake_queue_submission(submission, actor=None):
        called["submission_id"] = str(submission.id)
        return ProcessingJob.objects.create(submission=submission)

    monkeypatch.setattr("apps.ingestion.views.queue_submission", fake_queue_submission)
    confirm = client.post(
        f"/api/ingestion/submissions/{payload['id']}/confirm-candidate/",
        data=json.dumps({"candidate_id": payload["candidates"][0]["id"]}),
        content_type="application/json",
    )

    assert confirm.status_code == 200
    assert called["submission_id"] == payload["id"]
    submission = BookSubmission.objects.get(pk=payload["id"])
    assert submission.status == SubmissionStatus.QUEUED
    assert submission.resolution_status == "resolved"


@pytest.mark.django_db
def test_process_submission_job_persists_metadata_and_assets(tmp_path, monkeypatch):
    user = User.objects.create_user(email="processor@example.com", password="strong-password-123")
    submission = BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/test-book/",
        normalized_input="test book",
        resolved_url="https://www.ebanglalibrary.com/books/test-book/",
        resolution_status="resolved",
        resolution_confidence=1.0,
        status="queued",
    )
    job = ProcessingJob.objects.create(submission=submission)

    sample = {
        "book_title": "টেস্ট বুক",
        "author": "লেখক এক, লেখক দুই",
        "series": "রহস্য সিরিজ, সংগ্রহ",
        "book_type": "রহস্য, উপন্যাস",
        "cover": "book_cover.jpg",
        "main_content": "<p>মূল অংশ</p>",
        "book_info": "<p>অনুবাদ: অনুবাদক এক</p><p>সম্পাদক: সম্পাদক এক</p>",
        "dedication": "<p>উৎসর্গ</p>",
        "toc": [{"title": "অধ্যায় ১", "type": "lesson", "has_content": True}],
        "content_items": [{"title": "অধ্যায় ১", "content": "<p>বিষয়বস্তু</p>", "type": "lesson", "parent": None}],
        "output_folder": str(tmp_path),
    }

    def fake_scrape_book(url):
        return sample

    def fake_generate_exports(book_data):
        output_dir = Path(book_data["output_folder"])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "book.html").write_text("<html><body>book</body></html>", encoding="utf-8")
        (output_dir / "টেস্ট বুক.epub").write_bytes(b"epub-bytes")
        (output_dir / "book_cover.jpg").write_bytes(b"cover-bytes")

    monkeypatch.setattr("apps.ingestion.services.submissions.scrape_book", fake_scrape_book)
    monkeypatch.setattr("apps.ingestion.services.submissions.generate_exports", fake_generate_exports)

    processed_job = process_submission_job(str(job.id))
    submission.refresh_from_db()

    assert processed_job.status == JobStatus.SUCCEEDED
    assert submission.status == SubmissionStatus.READY
    assert Book.objects.count() == 1

    book = Book.objects.get()
    contributor_roles = {(relation.contributor.name, relation.role) for relation in book.book_contributors.all()}
    assert ("লেখক এক", "author") in contributor_roles
    assert ("লেখক দুই", "author") in contributor_roles
    assert ("অনুবাদক এক", "translator") in contributor_roles
    assert ("সম্পাদক এক", "editor") in contributor_roles
    assert book.generated_assets.filter(asset_type=GeneratedAssetType.HTML).exists()
    assert book.generated_assets.filter(asset_type=GeneratedAssetType.EPUB).exists()
    assert book.generated_assets.filter(asset_type=GeneratedAssetType.COVER).exists()


@pytest.mark.django_db
def test_url_submission_checks_database_first_and_returns_existing_book(client):
    user = User.objects.create_user(email="existing-url@example.com", password="strong-password-123")
    existing_book = Book.objects.create(title="সংরক্ষিত বই", state="ready", review_state="approved")
    BookSource.objects.create(
        book=existing_book,
        source_url="https://www.ebanglalibrary.com/books/existing-book/",
        normalized_source_url="https://www.ebanglalibrary.com/books/existing-book/",
        source_title="সংরক্ষিত বই",
    )
    client.force_login(user)

    response = client.post(
        "/api/ingestion/submissions/",
        data=json.dumps(
            {
                "input_type": "url",
                "content": "https://www.ebanglalibrary.com/books/existing-book/",
                "auto_process": True,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 201
    payload = response.json()[0]
    assert payload["status"] == "ready"
    assert payload["served_from_database"] is True
    assert payload["linked_book_slug"] == existing_book.slug
    assert ProcessingJob.objects.count() == 0
    assert PreviewAccessSession.objects.filter(user=user, book=existing_book).exists()


@pytest.mark.django_db
def test_title_submission_checks_database_first_and_returns_existing_book(client):
    user = User.objects.create_user(email="existing-title@example.com", password="strong-password-123")
    existing_book = Book.objects.create(title="একই বই", state="ready", review_state="approved")
    client.force_login(user)

    response = client.post(
        "/api/ingestion/submissions/",
        data=json.dumps(
            {
                "input_type": "title",
                "content": "একই বই",
                "auto_process": True,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 201
    payload = response.json()[0]
    assert payload["status"] == "ready"
    assert payload["served_from_database"] is True
    assert payload["linked_book_slug"] == existing_book.slug
    assert ProcessingJob.objects.count() == 0


@pytest.mark.django_db
def test_processing_reuses_canonical_author_series_and_category_names(tmp_path, monkeypatch):
    user = User.objects.create_user(email="canonical@example.com", password="strong-password-123")
    submission = BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/canonical-book/",
        normalized_input="canonical book",
        resolved_url="https://www.ebanglalibrary.com/books/canonical-book/",
        resolution_status="resolved",
        resolution_confidence=1.0,
        status="queued",
    )
    job = ProcessingJob.objects.create(submission=submission)

    sample = {
        "book_title": "ক্যানোনিক্যাল বই",
        "author": "লেখক এক, লেখক-এক, লেখক এক",
        "series": "রহস্য সিরিজ, রহস্য-সিরিজ",
        "book_type": "উপন্যাস, উপন্যাস",
        "cover": "book_cover.jpg",
        "main_content": "<p>মূল অংশ</p>",
        "book_info": "<p>অনুবাদ: অনুবাদক এক, অনুবাদক-এক</p>",
        "dedication": "<p>উৎসর্গ</p>",
        "toc": [{"title": "অধ্যায় ১", "type": "lesson", "has_content": True}],
        "content_items": [{"title": "অধ্যায় ১", "content": "<p>বিষয়বস্তু</p>", "type": "lesson", "parent": None}],
        "output_folder": str(tmp_path),
    }

    def fake_scrape_book(url):
        return sample

    def fake_generate_exports(book_data):
        output_dir = Path(book_data["output_folder"])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "book.html").write_text("<html><body>book</body></html>", encoding="utf-8")
        (output_dir / "ক্যানোনিক্যাল বই.epub").write_bytes(b"epub-bytes")
        (output_dir / "book_cover.jpg").write_bytes(b"cover-bytes")

    monkeypatch.setattr("apps.ingestion.services.submissions.scrape_book", fake_scrape_book)
    monkeypatch.setattr("apps.ingestion.services.submissions.generate_exports", fake_generate_exports)

    process_submission_job(str(job.id))

    assert Contributor.objects.filter(normalized_name=normalize_text("লেখক এক")).count() == 1
    assert Contributor.objects.filter(normalized_name=normalize_text("অনুবাদক এক")).count() == 1
    assert Series.objects.filter(normalized_name=normalize_text("রহস্য সিরিজ")).count() == 1
    assert Category.objects.filter(normalized_name=normalize_text("উপন্যাস")).count() == 1
