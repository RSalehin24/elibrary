import json
from pathlib import Path

import pytest

from apps.access.models import PreviewAccessSession
from apps.accounts.models import User
from apps.catalog.models import Book, BookSource, Category, Contributor, GeneratedAsset, GeneratedAssetStatus, GeneratedAssetType, Series
from apps.ingestion.models import (
    BookSubmission,
    DuplicateReview,
    DuplicateReviewStatus,
    JobStatus,
    MatchCandidate,
    ProcessingJob,
    ResolutionStatus,
    SourceCatalogEntry,
    SubmissionStatus,
    TitleResolutionAttempt,
)
from apps.ingestion.services.legacy_adapter import normalize_text
from apps.ingestion.services.resolution import TitleResolver
from apps.ingestion.services.submissions import create_submission_records, process_submission_job, queue_submission


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
def test_title_resolver_crawls_archive_bucket_pages_and_splits_author_from_display_title():
    page_one = """
    <div class="facetwp-template" data-name="books">
      <div class="fwpl-result">
        <div class="fwpl-item el-97dha">
          <a href="https://www.ebanglalibrary.com/books/other-book/">মেঘ - লেখক এক</a>
        </div>
      </div>
    </div>
    """
    page_two = """
    <div class="facetwp-template" data-name="books">
      <div class="fwpl-result">
        <div class="fwpl-item el-97dha">
          <a href="https://www.ebanglalibrary.com/books/malice/">ম্যালিস - সৈকত মুখোপাধ্যায়</a>
        </div>
      </div>
    </div>
    """
    empty_page = '<div class="facetwp-template" data-name="books"></div>'

    class FakeResponse:
        def __init__(self, text):
            self.text = text

        def raise_for_status(self):
            return None

    class FakeSession:
        def __init__(self):
            self.headers = {}
            self.calls = []

        def get(self, url, params=None, timeout=30):
            params = params or {}
            self.calls.append((url, params))
            key = (params.get("_a_z", ""), params.get("_paged", 1))
            mapping = {
                ("ম", 1): page_one,
                ("ম", 2): page_two,
                ("ম", 3): empty_page,
            }
            return FakeResponse(mapping.get(key, empty_page))

    session = FakeSession()
    resolver = TitleResolver(session=session)

    result = resolver.resolve("ম্যালিস")

    assert result.status == "exact_match"
    assert result.resolved_url == "https://www.ebanglalibrary.com/books/malice/"
    entry = SourceCatalogEntry.objects.get(source_url="https://www.ebanglalibrary.com/books/malice/")
    assert entry.title == "ম্যালিস"
    assert entry.author_line == "সৈকত মুখোপাধ্যায়"
    assert ("https://www.ebanglalibrary.com/books/", {"_a_z": "ম"}) in session.calls
    assert ("https://www.ebanglalibrary.com/books/", {"_a_z": "ম", "_paged": 2}) in session.calls


@pytest.mark.django_db
def test_title_resolver_returns_ambiguous_matches_from_archive_bucket():
    page_one = """
    <div class="facetwp-template" data-name="books">
      <div class="fwpl-result">
        <div class="fwpl-item el-97dha">
          <a href="https://www.ebanglalibrary.com/books/malice-one/">ম্যালিস - লেখক এক</a>
        </div>
      </div>
      <div class="fwpl-result">
        <div class="fwpl-item el-97dha">
          <a href="https://www.ebanglalibrary.com/books/malice-two/">ম্যালিস - লেখক দুই</a>
        </div>
      </div>
    </div>
    """
    empty_page = '<div class="facetwp-template" data-name="books"></div>'

    class FakeResponse:
        def __init__(self, text):
            self.text = text

        def raise_for_status(self):
            return None

    class FakeSession:
        def __init__(self):
            self.headers = {}

        def get(self, url, params=None, timeout=30):
            params = params or {}
            key = (params.get("_a_z", ""), params.get("_paged", 1))
            if key == ("ম", 1):
                return FakeResponse(page_one)
            return FakeResponse(empty_page)

    resolver = TitleResolver(session=FakeSession())

    result = resolver.resolve("ম্যালিস")

    assert result.status == "ambiguous"
    assert result.resolved_url == ""
    assert len(result.candidates) == 2
    assert {candidate["url"] for candidate in result.candidates} == {
        "https://www.ebanglalibrary.com/books/malice-one/",
        "https://www.ebanglalibrary.com/books/malice-two/",
    }


@pytest.mark.django_db
def test_title_resolver_enriches_candidates_from_book_page_metadata():
    archive_page = """
    <div class="facetwp-template" data-name="books">
      <div class="fwpl-result">
        <div class="fwpl-item el-97dha">
          <a href="https://www.ebanglalibrary.com/books/malice/">ম্যালিস উপন্যাস - সৈকত মুখোপাধ্যায়</a>
        </div>
      </div>
    </div>
    """
    book_page = """
    <html>
      <head><title>ম্যালিস - সৈকত মুখোপাধ্যায়</title></head>
      <body>
        <div class="entry-meta entry-meta-after-content">
          <span class="entry-terms-authors"><a>সৈকত মুখোপাধ্যায়</a></span>
          <span class="entry-terms-series"><a>থ্রিলার</a></span>
        </div>
      </body>
    </html>
    """
    empty_page = '<div class="facetwp-template" data-name="books"></div>'

    class FakeResponse:
        def __init__(self, text):
            self.text = text

        def raise_for_status(self):
            return None

    class FakeSession:
        def __init__(self):
            self.headers = {}

        def get(self, url, params=None, timeout=30):
            params = params or {}
            if url == "https://www.ebanglalibrary.com/books/malice/":
                return FakeResponse(book_page)
            key = (params.get("_a_z", ""), params.get("_paged", 1))
            if key == ("ম", 1):
                return FakeResponse(archive_page)
            return FakeResponse(empty_page)

    resolver = TitleResolver(session=FakeSession())

    result = resolver.resolve("ম্যালিস")

    assert result.status == "exact_match"
    assert result.resolved_url == "https://www.ebanglalibrary.com/books/malice/"
    entry = SourceCatalogEntry.objects.get(source_url="https://www.ebanglalibrary.com/books/malice/")
    assert entry.title == "ম্যালিস"
    assert entry.raw_data["metadata_source"] == "book_page"


@pytest.mark.django_db
def test_direct_url_submission_stores_source_page_metadata(monkeypatch):
    fake_metadata = {
        "source_url": "https://www.ebanglalibrary.com/books/source-book/",
        "title": "সোর্স বুক",
        "author_line": "লেখক",
        "normalized_title": normalize_text("সোর্স বুক"),
        "normalized_display": normalize_text("সোর্স বুক লেখক"),
        "raw_data": {
            "title": "সোর্স বুক",
            "author_line": "লেখক",
            "metadata_source": "book_page",
        },
    }

    monkeypatch.setattr(
        "apps.ingestion.services.submissions.capture_source_page_metadata",
        lambda url: fake_metadata,
    )

    submissions = create_submission_records(
        submitter=None,
        parsed_entries=[{"kind": "url", "value": "https://www.ebanglalibrary.com/books/source-book/"}],
        auto_process=False,
    )

    assert submissions[0].raw_payload["source_page_metadata"]["title"] == "সোর্স বুক"


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
def test_repeated_requests_reuse_canonical_submission_and_existing_job(monkeypatch):
    user = User.objects.create_user(email="repeat@example.com", password="strong-password-123")
    canonical_submission = BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/repeat-book/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/repeat-book/"),
        resolved_url="https://www.ebanglalibrary.com/books/repeat-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.PROCESSING,
    )
    existing_job = ProcessingJob.objects.create(
        submission=canonical_submission,
        status=JobStatus.PROCESSING,
        queue_name="celery",
    )

    monkeypatch.setattr("apps.ingestion.services.submissions.capture_source_page_metadata", lambda url: None)

    duplicate_submission = create_submission_records(
        submitter=user,
        parsed_entries=[{"kind": "url", "value": "https://www.ebanglalibrary.com/books/repeat-book/"}],
        auto_process=False,
    )[0]

    assert duplicate_submission.canonical_submission_id == canonical_submission.id
    assert duplicate_submission.status == SubmissionStatus.PROCESSING
    assert duplicate_submission.raw_payload["deduplicated"] is True

    returned_job = queue_submission(duplicate_submission)

    assert returned_job.id == existing_job.id
    assert ProcessingJob.objects.count() == 1


@pytest.mark.django_db
def test_public_submission_detail_and_confirm_candidate_are_available_without_login(client, monkeypatch):
    submission = BookSubmission.objects.create(
        input_type="title",
        original_input="ম্যালিস",
        normalized_input=normalize_text("ম্যালিস"),
        resolution_status=ResolutionStatus.AMBIGUOUS,
        status=SubmissionStatus.NEEDS_REVIEW,
        review_state="needs_review",
        raw_payload={"submitted_publicly": True},
    )
    attempt = TitleResolutionAttempt.objects.create(
        submission=submission,
        query="ম্যালিস",
        normalized_query=normalize_text("ম্যালিস"),
        status=ResolutionStatus.AMBIGUOUS,
        confidence=0.92,
    )
    first_candidate = MatchCandidate.objects.create(
        resolution_attempt=attempt,
        rank=1,
        candidate_title="ম্যালিস",
        candidate_author="সৈকত মুখোপাধ্যায়",
        candidate_url="https://www.ebanglalibrary.com/books/malice/",
        confidence=0.92,
    )
    MatchCandidate.objects.create(
        resolution_attempt=attempt,
        rank=2,
        candidate_title="ম্যালিস রিটার্নস",
        candidate_author="অন্য লেখক",
        candidate_url="https://www.ebanglalibrary.com/books/malice-returns/",
        confidence=0.61,
    )

    detail = client.get(f"/api/ingestion/submissions/{submission.id}/")
    assert detail.status_code == 200
    assert len(detail.json()["candidates"]) == 2

    called = {}

    def fake_queue_submission(target_submission, actor=None):
        called["submission_id"] = str(target_submission.id)
        called["actor"] = actor
        return ProcessingJob.objects.create(submission=target_submission)

    monkeypatch.setattr("apps.ingestion.views.queue_submission", fake_queue_submission)
    confirm = client.post(
        f"/api/ingestion/submissions/{submission.id}/confirm-candidate/",
        data=json.dumps({"candidate_id": str(first_candidate.id)}),
        content_type="application/json",
    )

    assert confirm.status_code == 200
    assert called["submission_id"] == str(submission.id)
    assert called["actor"] is None
    submission.refresh_from_db()
    assert submission.resolved_url == "https://www.ebanglalibrary.com/books/malice/"
    assert submission.resolution_status == ResolutionStatus.RESOLVED
    assert submission.status == SubmissionStatus.QUEUED


@pytest.mark.django_db
def test_public_submission_action_links_create_guest_preview_session(tmp_path, client):
    book = Book.objects.create(title="গেস্ট বুক", state="ready", review_state="approved")
    epub_path = Path(tmp_path) / "guest-book.epub"
    html_path = Path(tmp_path) / "guest-book.html"
    epub_path.write_bytes(b"epub")
    html_path.write_text("<html></html>", encoding="utf-8")
    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.EPUB,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(epub_path),
        content_type="application/epub+zip",
        file_size=epub_path.stat().st_size,
    )
    GeneratedAsset.objects.create(
        book=book,
        asset_type=GeneratedAssetType.HTML,
        status=GeneratedAssetStatus.READY,
        legacy_path=str(html_path),
        content_type="text/html",
        file_size=html_path.stat().st_size,
    )
    submission = BookSubmission.objects.create(
        input_type="title",
        original_input="গেস্ট বুক",
        normalized_input=normalize_text("গেস্ট বুক"),
        linked_book=book,
        resolved_url="https://www.ebanglalibrary.com/books/guest-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        resolution_confidence=1.0,
        status=SubmissionStatus.READY,
        raw_payload={"submitted_publicly": True},
    )

    response = client.post(
        f"/api/ingestion/submissions/{submission.id}/action-links/",
        data=json.dumps({}),
        content_type="application/json",
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["launch_url"]
    assert payload["epub_download_url"]
    assert payload["html_preview_url"]
    preview_session = PreviewAccessSession.objects.get(source_submission=submission)
    assert preview_session.user is None

    manifest = client.get(payload["manifest_url"].replace("http://testserver", ""))
    assert manifest.status_code == 200
    manifest_payload = manifest.json()
    assert manifest_payload["reading_session_url"] == ""
    assert manifest_payload["bookmarks_url"] == ""
    assert manifest_payload["reading_session"] is None
    assert manifest_payload["bookmarks"] == []

    guest_session_state = client.get(f"/api/access/reader/{preview_session.token}/session/")
    guest_bookmarks = client.get(f"/api/access/reader/{preview_session.token}/bookmarks/")
    assert guest_session_state.status_code == 403
    assert guest_bookmarks.status_code == 403


@pytest.mark.django_db
def test_public_submission_accepts_mixed_entries_and_reuses_existing_books(client):
    existing_book = Book.objects.create(title="সংরক্ষিত বই", state="ready", review_state="approved")
    BookSource.objects.create(
        book=existing_book,
        source_url="https://www.ebanglalibrary.com/books/existing-book/",
        normalized_source_url="https://www.ebanglalibrary.com/books/existing-book/",
        source_title="সংরক্ষিত বই",
    )

    response = client.post(
        "/api/ingestion/submissions/",
        data=json.dumps(
            {
                "entries": [
                    "https://www.ebanglalibrary.com/books/existing-book/",
                    "সংরক্ষিত বই",
                ],
                "auto_process": True,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 201
    payload = response.json()
    assert len(payload) == 2
    assert all(entry["served_from_database"] is True for entry in payload)
    assert all(entry["linked_book_slug"] == existing_book.slug for entry in payload)
    assert PreviewAccessSession.objects.count() == 0


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
