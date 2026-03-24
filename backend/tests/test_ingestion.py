import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest
import requests
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
from apps.ingestion.services.legacy_adapter import normalize_text
from apps.ingestion.services.normalization import (
    clean_extracted_dedication_html,
    extract_main_content_segments,
    extract_front_matter_entries,
    normalize_scraped_book,
    promote_leading_front_matter,
)
from apps.ingestion.services.resolution import CATALOG_URL, TitleResolver, get_with_host_fallback
from apps.ingestion.services.submissions import (
    create_submission_records,
    detect_metadata_duplicate,
    process_submission_job,
    queue_submission,
    sync_assets,
)
from apps.ingestion.tasks import process_submission_task
from apps.catalog.services import find_existing_book_by_source_url


def test_legacy_normalize_text_preserves_bengali_combining_marks():
    assert normalize_text("ম্যালিস") == "ম্যালিস"


def test_get_with_host_fallback_uses_direct_ip_when_dns_resolution_fails(monkeypatch):
    class FakeResponse:
        def __init__(self, text):
            self.text = text

    class FakeSession:
        def __init__(self):
            self.headers = {}
            self.calls = []

        def get(self, url, **kwargs):
            self.calls.append((url, kwargs))
            raise requests.exceptions.ConnectionError(
                "HTTPSConnection(host='ebanglalibrary.com'): Failed to resolve host (Name resolution)"
            )

    session = FakeSession()
    direct_calls = []

    monkeypatch.setattr(
        "apps.ingestion.services.resolution.resolve_host_with_dns_fallback",
        lambda host: ["104.21.81.247"] if host == "www.ebanglalibrary.com" else [],
    )

    def fake_direct_ip_request(session_obj, url, host, ip, **kwargs):
        direct_calls.append((url, host, ip, kwargs.get("params")))
        return FakeResponse("ok-from-direct-ip")

    monkeypatch.setattr(
        "apps.ingestion.services.resolution.get_via_direct_ip_https",
        fake_direct_ip_request,
    )

    response = get_with_host_fallback(
        session,
        "https://www.ebanglalibrary.com/books/",
        params={"_a_z": "ম"},
        timeout=30,
    )

    assert response.text == "ok-from-direct-ip"
    assert len(session.calls) >= 1
    assert direct_calls
    assert direct_calls[0][1] == "www.ebanglalibrary.com"
    assert direct_calls[0][2] == "104.21.81.247"


def test_get_with_host_fallback_does_not_mask_non_dns_connection_errors(monkeypatch):
    class FakeSession:
        def __init__(self):
            self.headers = {}

        def get(self, _url, **_kwargs):
            raise requests.exceptions.ConnectionError("Connection reset by peer")

    monkeypatch.setattr(
        "apps.ingestion.services.resolution.get_via_direct_ip_https",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("direct IP fallback should not run")),
    )

    with pytest.raises(requests.exceptions.ConnectionError, match="Connection reset by peer"):
        get_with_host_fallback(FakeSession(), "https://www.ebanglalibrary.com/books/", timeout=30)


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
def test_submission_bulk_status_returns_requested_visible_submissions_in_order(client):
    user = User.objects.create_user(email="bulk-status@example.com", password="strong-password-123")
    other_user = User.objects.create_user(email="bulk-status-other@example.com", password="strong-password-123")
    first = BookSubmission.objects.create(
        submitter=user,
        input_type="title",
        original_input="প্রথম",
        normalized_input="প্রথম",
        status=SubmissionStatus.QUEUED,
    )
    second = BookSubmission.objects.create(
        submitter=user,
        input_type="title",
        original_input="দ্বিতীয়",
        normalized_input="দ্বিতীয়",
        status=SubmissionStatus.PROCESSING,
    )
    hidden = BookSubmission.objects.create(
        submitter=other_user,
        input_type="title",
        original_input="লুকানো",
        normalized_input="লুকানো",
        status=SubmissionStatus.READY,
    )
    client.force_login(user)

    response = client.post(
        "/api/ingestion/submissions/status/",
        data=json.dumps({"ids": [str(second.id), str(hidden.id), str(first.id)]}),
        content_type="application/json",
    )

    assert response.status_code == 200
    assert [entry["id"] for entry in response.json()] == [str(second.id), str(first.id)]


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
def test_source_catalog_refresh_starts_background_sync_and_returns_state(client, monkeypatch):
    admin = User.objects.create_superuser(email="catalog-refresh@example.com", password="strong-password-123")
    client.force_login(admin)

    monkeypatch.setattr("apps.ingestion.services.curation.dispatch_source_catalog_refresh", lambda state: state)

    response = client.post(
        "/api/ingestion/catalog/refresh/",
        data=json.dumps({"max_pages": 3}),
        content_type="application/json",
    )

    assert response.status_code == 202
    payload = response.json()
    assert payload["status"] == "queued"
    assert payload["max_pages"] == 3
    assert payload["requested_by_email"] == admin.email

    sync_state = SourceCatalogRefreshState.objects.get(singleton_key="default")
    assert sync_state.status == SourceCatalogRefreshStatus.QUEUED
    assert sync_state.max_pages == 3
    assert sync_state.requested_by == admin


@pytest.mark.django_db
def test_source_catalog_entries_include_sync_state(client):
    admin = User.objects.create_superuser(email="catalog-sync-state@example.com", password="strong-password-123")
    client.force_login(admin)

    SourceCatalogRefreshState.objects.create(
        singleton_key="default",
        status=SourceCatalogRefreshStatus.PROCESSING,
        max_pages=6,
    )

    response = client.get("/api/ingestion/catalog/entries/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["sync_state"]["status"] == "processing"
    assert payload["sync_state"]["max_pages"] == 6


@pytest.mark.django_db
def test_source_catalog_entries_apply_status_filter_before_pagination_and_return_counts(client):
    admin = User.objects.create_superuser(email="catalog-filter@example.com", password="strong-password-123")
    client.force_login(admin)

    ready_book = Book.objects.create(title="A Ready Book", state=LifecycleState.READY)
    BookSource.objects.create(
        book=ready_book,
        source_url="https://www.ebanglalibrary.com/books/ready-book/",
        normalized_source_url="https://www.ebanglalibrary.com/books/ready-book/",
    )
    GeneratedAsset.objects.create(book=ready_book, asset_type=GeneratedAssetType.HTML, status=GeneratedAssetStatus.READY)
    GeneratedAsset.objects.create(book=ready_book, asset_type=GeneratedAssetType.EPUB, status=GeneratedAssetStatus.READY)

    SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/ready-book/",
        title="A Ready Book",
        author_line="Author",
        normalized_title="a ready book",
        normalized_display="a ready book author",
    )
    SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/new-book/",
        title="Z New Book",
        author_line="Author",
        normalized_title="z new book",
        normalized_display="z new book author",
    )

    response = client.get("/api/ingestion/catalog/entries/?limit=1&status=new")

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["total"] == 1
    assert payload["summary"]["new"] == 1
    assert payload["pagination"]["total_count"] == 1
    assert payload["pagination"]["page_count"] == 1
    assert len(payload["entries"]) == 1
    assert payload["entries"][0]["title"] == "Z New Book"


@pytest.mark.django_db
def test_title_resolver_refresh_catalog_accepts_long_source_urls():
    long_slug = "kaliguneen-" + ("rahasya-" * 24)
    long_url = f"https://www.ebanglalibrary.com/books/{long_slug}/"
    page_one = f"""
    <div class="facetwp-template" data-name="books">
      <div class="fwpl-result">
        <div class="fwpl-item el-97dha">
          <a href="{long_url}">কালীগুণীন ও বজ্র-সিন্দুক রহস্য - সৌমিক দে</a>
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
            page_number = (params or {}).get("_paged", 1)
            return FakeResponse(page_one if page_number == 1 else empty_page)

    resolver = TitleResolver(session=FakeSession())

    refreshed = resolver.refresh_catalog(max_pages=2)

    assert len(refreshed) == 1
    entry = SourceCatalogEntry.objects.get(source_url=long_url)
    assert entry.title == "কালীগুণীন ও বজ্র-সিন্দুক রহস্য"
    assert entry.author_line == "সৌমিক দে"


@pytest.mark.django_db
def test_title_resolver_refresh_catalog_stops_when_a_page_adds_no_new_books():
    existing_url = "https://www.ebanglalibrary.com/books/existing-book/"
    new_url = "https://www.ebanglalibrary.com/books/new-book/"
    SourceCatalogEntry.objects.create(
        source_url=existing_url,
        title="Existing Book",
        author_line="Known Author",
        normalized_title=normalize_text("Existing Book"),
        normalized_display=normalize_text("Existing Book Known Author"),
    )

    first_page = f"""
    <div class="facetwp-template" data-name="books">
      <div class="fwpl-result">
        <div class="fwpl-item el-97dha">
          <a href="{existing_url}">Existing Book - Known Author</a>
        </div>
      </div>
    </div>
    """
    second_page = f"""
    <div class="facetwp-template" data-name="books">
      <div class="fwpl-result">
        <div class="fwpl-item el-97dha">
          <a href="{new_url}">New Book - New Author</a>
        </div>
      </div>
    </div>
    """

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
            page_number = params.get("_paged", 1)
            if page_number == 1:
                return FakeResponse(first_page)
            return FakeResponse(second_page)

    session = FakeSession()
    resolver = TitleResolver(session=session)

    refreshed = resolver.refresh_catalog(max_pages=2)

    assert refreshed == []
    assert session.calls == [(CATALOG_URL, {})]
    assert SourceCatalogEntry.objects.filter(source_url=new_url).count() == 0


@pytest.mark.django_db
def test_long_source_urls_can_be_stored_across_ingestion_and_catalog_models():
    long_slug = "source-book-" + ("extended-path-" * 20)
    long_url = f"https://www.ebanglalibrary.com/books/{long_slug}/"
    book = Book.objects.create(title="Long URL Book", state="ready", review_state="pending")

    source_entry = SourceCatalogEntry.objects.create(
        source_url=long_url,
        title="Long URL Book",
        author_line="Writer",
        normalized_title=normalize_text("Long URL Book"),
        normalized_display=normalize_text("Long URL Book Writer"),
    )
    source = BookSource.objects.create(
        book=book,
        source_url=long_url,
        normalized_source_url=long_url,
        source_title="Long URL Book",
    )
    submission = BookSubmission.objects.create(
        input_type="url",
        original_input=long_url,
        normalized_input=normalize_text(long_url),
        resolved_url=long_url,
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )
    attempt = TitleResolutionAttempt.objects.create(
        submission=submission,
        query="Long URL Book",
        normalized_query=normalize_text("Long URL Book"),
        status=ResolutionStatus.RESOLVED,
        resolved_url=long_url,
    )
    candidate = MatchCandidate.objects.create(
        resolution_attempt=attempt,
        rank=1,
        candidate_title="Long URL Book",
        candidate_author="Writer",
        candidate_url=long_url,
        confidence=0.98,
    )

    assert source_entry.source_url == long_url
    assert source.normalized_source_url == long_url
    assert submission.resolved_url == long_url
    assert attempt.resolved_url == long_url
    assert candidate.candidate_url == long_url


@pytest.mark.django_db
def test_source_catalog_entry_snapshots_mark_new_and_ready_books():
    missing_entry = SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/missing-book/",
        title="Missing Book",
        author_line="Writer One",
        raw_data={"category": "Mystery"},
        normalized_title=normalize_text("Missing Book"),
        normalized_display=normalize_text("Missing Book Writer One"),
    )
    ready_entry = SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/ready-book/",
        title="Ready Book",
        author_line="Writer Two",
        normalized_title=normalize_text("Ready Book"),
        normalized_display=normalize_text("Ready Book Writer Two"),
    )
    ready_book = Book.objects.create(title="Ready Book", state="ready", review_state="pending")
    BookSource.objects.create(
        book=ready_book,
        source_url=ready_entry.source_url,
        normalized_source_url=ready_entry.source_url,
        source_title=ready_entry.title,
    )
    GeneratedAsset.objects.create(book=ready_book, asset_type=GeneratedAssetType.HTML, status=GeneratedAssetStatus.READY)
    GeneratedAsset.objects.create(book=ready_book, asset_type=GeneratedAssetType.EPUB, status=GeneratedAssetStatus.READY)
    ready_book.categories.add(Category.objects.create(name="Novel"))

    snapshots, summary = source_catalog_entry_snapshots(SourceCatalogEntry.objects.order_by("title"))
    by_url = {snapshot["source_url"]: snapshot for snapshot in snapshots}

    assert by_url[missing_entry.source_url]["curation_status"] == "new"
    assert by_url[missing_entry.source_url]["categories"] == "Mystery"
    assert by_url[ready_entry.source_url]["curation_status"] == "ready"
    assert by_url[ready_entry.source_url]["categories"] == "Novel"
    assert summary["new"] == 1
    assert summary["ready"] == 1


@pytest.mark.django_db
def test_source_catalog_entry_snapshots_surface_failed_creation_before_local_book_exists():
    entry = SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/failed-book/",
        title="Failed Book",
        author_line="Writer",
        normalized_title=normalize_text("Failed Book"),
        normalized_display=normalize_text("Failed Book Writer"),
    )
    submission = BookSubmission.objects.create(
        input_type="url",
        origin=SubmissionOrigin.CURATION,
        original_input=entry.source_url,
        normalized_input=normalize_text(entry.source_url),
        resolved_url=entry.source_url,
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.FAILED,
        error_message="Missing generated assets: EPUB.",
    )
    ProcessingJob.objects.create(
        submission=submission,
        status=JobStatus.FAILED,
        last_error="Missing generated assets: EPUB.",
    )

    snapshots, summary = source_catalog_entry_snapshots(SourceCatalogEntry.objects.filter(pk=entry.pk))

    assert snapshots[0]["curation_status"] == "failed"
    assert snapshots[0]["latest_submission_status"] == "failed"
    assert snapshots[0]["latest_job_status"] == "failed"
    assert summary["failed"] == 1


@pytest.mark.django_db
def test_processing_manager_can_queue_selected_catalog_entries_for_creation(client, monkeypatch):
    admin = User.objects.create_superuser(email="catalog-create-admin@example.com", password="strong-password-123")
    client.force_login(admin)
    new_entry = SourceCatalogEntry.objects.create(
        source_url="https://www.ebanglalibrary.com/books/new-book/",
        title="New Book",
        author_line="Writer",
        normalized_title=normalize_text("New Book"),
        normalized_display=normalize_text("New Book Writer"),
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
        data=json.dumps({"ids": [str(new_entry.id)]}),
        content_type="application/json",
    )

    assert response.status_code == 202
    assert response.json()["queued_creates"] == 1
    assert queued_entries == [{"kind": "url", "value": new_entry.source_url}]


@pytest.mark.django_db
def test_find_existing_book_by_source_url_ignores_soft_deleted_books():
    book = Book.objects.create(title="Deleted source book", state="soft_deleted", review_state="pending")
    Book.objects.filter(pk=book.pk).update(deleted_at=timezone.now())
    book.refresh_from_db()
    BookSource.objects.create(
        book=book,
        source_url="https://www.ebanglalibrary.com/books/deleted-source-book/",
        normalized_source_url="httpswwwebanglalibrarycombooksdeletedsourcebook",
    )

    existing = find_existing_book_by_source_url("httpswwwebanglalibrarycombooksdeletedsourcebook")

    assert existing is None


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


@pytest.mark.django_db
def test_processing_manager_can_stop_queued_job(client, monkeypatch):
    admin = User.objects.create_superuser(email="stop-job-admin@example.com", password="strong-password-123")
    client.force_login(admin)
    submission = BookSubmission.objects.create(
        input_type="url",
        origin=SubmissionOrigin.USER,
        original_input="https://www.ebanglalibrary.com/books/queued-book/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/queued-book/"),
        resolved_url="https://www.ebanglalibrary.com/books/queued-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.QUEUED,
    )
    job = ProcessingJob.objects.create(
        submission=submission,
        status=JobStatus.QUEUED,
        task_id="queued-task",
        queue_name="celery",
    )

    monkeypatch.setattr("apps.ingestion.services.submissions.revoke_processing_task", lambda task_id: None)

    response = client.post(f"/api/ingestion/jobs/{job.id}/stop/", data=json.dumps({}), content_type="application/json")

    assert response.status_code == 200
    job.refresh_from_db()
    submission.refresh_from_db()
    assert job.status == JobStatus.CANCELLED
    assert submission.status == SubmissionStatus.CANCELLED


@pytest.mark.django_db
def test_processing_manager_can_stop_catalog_curation_run(client, monkeypatch):
    admin = User.objects.create_superuser(email="stop-run-admin@example.com", password="strong-password-123")
    client.force_login(admin)
    run = CatalogCurationRun.objects.create(
        trigger="manual",
        mode="pending",
        status=JobStatus.QUEUED,
        refresh_catalog=True,
        refresh_max_pages=80,
        requested_by=admin,
        task_id="queued-run-task",
        queue_name="celery",
    )

    monkeypatch.setattr("apps.ingestion.services.curation.revoke_curation_task", lambda task_id: None)

    response = client.post(
        f"/api/ingestion/catalog/curation-runs/{run.id}/stop/",
        data=json.dumps({}),
        content_type="application/json",
    )

    assert response.status_code == 200
    run.refresh_from_db()
    assert run.status == JobStatus.CANCELLED


@pytest.mark.django_db
def test_due_catalog_automation_queues_one_scheduled_run_per_day(monkeypatch):
    settings_obj = get_catalog_automation_settings()
    settings_obj.enabled = True
    settings_obj.daily_run_time = timezone.localtime(timezone.now()).replace(hour=1, minute=0, second=0, microsecond=0).time()
    settings_obj.mode = "pending"
    settings_obj.refresh_max_pages = 10
    settings_obj.save()

    def fake_create_catalog_curation_run(**kwargs):
        return CatalogCurationRun.objects.create(
            trigger=kwargs["trigger"],
            mode=kwargs["mode"],
            status="queued",
            refresh_catalog=kwargs["refresh_catalog"],
            refresh_max_pages=kwargs["refresh_max_pages"],
        )

    monkeypatch.setattr("apps.ingestion.services.curation.create_catalog_curation_run", fake_create_catalog_curation_run)

    result = run_due_catalog_automation(now=timezone.now())
    second_result = run_due_catalog_automation(now=timezone.now())

    assert result["ran"] is True
    assert CatalogCurationRun.objects.filter(trigger="scheduled").count() == 1
    assert second_result["ran"] is False
    assert second_result["reason"] == "already_ran"


@pytest.mark.django_db
def test_weekly_catalog_automation_waits_until_the_next_week(monkeypatch):
    now = timezone.localtime(timezone.now()).replace(hour=10, minute=0, second=0, microsecond=0)
    settings_obj = get_catalog_automation_settings()
    settings_obj.enabled = True
    settings_obj.daily_run_time = now.replace(hour=9, minute=0).time()
    settings_obj.frequency = CatalogAutomationFrequency.WEEKLY
    settings_obj.save()
    type(settings_obj).objects.filter(pk=settings_obj.pk).update(updated_at=now - timedelta(days=10))
    settings_obj.refresh_from_db()

    latest_run = CatalogCurationRun.objects.create(
        trigger="scheduled",
        mode="pending",
        status="succeeded",
        refresh_catalog=True,
        refresh_max_pages=10,
    )
    CatalogCurationRun.objects.filter(pk=latest_run.pk).update(created_at=now - timedelta(days=3))

    result = run_due_catalog_automation(now=now)

    assert result["ran"] is False
    assert result["reason"] == "already_ran"


@pytest.mark.django_db
def test_next_catalog_automation_run_at_uses_monthly_frequency_from_latest_run():
    timezone_value = timezone.get_current_timezone()
    now = timezone.make_aware(datetime(2026, 3, 23, 10, 0, 0), timezone_value)
    settings_obj = get_catalog_automation_settings()
    settings_obj.enabled = True
    settings_obj.daily_run_time = now.astimezone(timezone_value).replace(hour=6, minute=30).time()
    settings_obj.frequency = CatalogAutomationFrequency.MONTHLY
    settings_obj.save()
    type(settings_obj).objects.filter(pk=settings_obj.pk).update(updated_at=now - timedelta(days=90))
    settings_obj.refresh_from_db()

    latest_run = CatalogCurationRun.objects.create(
        trigger="scheduled",
        mode="pending",
        status="succeeded",
        refresh_catalog=True,
        refresh_max_pages=10,
    )
    CatalogCurationRun.objects.filter(pk=latest_run.pk).update(
        created_at=timezone.make_aware(datetime(2026, 1, 31, 6, 30, 0), timezone_value)
    )
    latest_run.refresh_from_db()

    next_run_at = next_catalog_automation_run_at(settings_obj, now=now)

    assert timezone.localtime(next_run_at).month == 2
    assert timezone.localtime(next_run_at).day in {28, 29}


def test_front_matter_extraction_handles_inline_labels_and_role_detection():
    book_info_html = """
    <p><strong>অনুবাদ</strong>: অনুবাদক এক, অনুবাদক দুই</p>
    <p><strong>প্রথম প্রকাশ</strong>: জানুয়ারি ২০০১</p>
    <p><strong>প্রকাশক</strong> : প্রকাশনী</p>
    """

    entries = extract_front_matter_entries(book_info_html)
    normalized = normalize_scraped_book(
        {
            "book_title": "উদাহরণ",
            "author": "লেখক এক",
            "series": "",
            "book_type": "",
            "book_info": book_info_html,
        }
    )

    assert [entry["key"] for entry in entries] == ["translator", "first_published", "publisher"]
    assert any(
        contributor["name"] == "অনুবাদক এক" and contributor["role"] == "translator"
        for contributor in normalized["contributors"]
    )
    assert any(
        contributor["name"] == "অনুবাদক দুই" and contributor["role"] == "translator"
        for contributor in normalized["contributors"]
    )
    assert any(
        contributor["name"] == "প্রকাশনী" and contributor["role"] == "publisher"
        for contributor in normalized["contributors"]
    )


def test_front_matter_promotion_extracts_title_prefixed_translator_and_publication_from_main_content():
    main_content_html = """
    <div>
      <h2 class="wp-block-heading">ম্যালিস – কিয়েগো হিগাশিনো</h2>
      <p><strong>ম্যালিস – কিয়েগো হিগাশিনো</strong><br/>অনুবাদ: সালমান হক, ইশরাক অর্ণব</p>
      <p>প্রথম প্রকাশ: মার্চ ২০২৩</p>
      <p><strong>ভূমিকা</strong></p>
      <p>এটাই মূল কনটেন্ট।</p>
    </div>
    """

    book_info_html, cleaned_main_content = promote_leading_front_matter("", main_content_html)
    entries = extract_front_matter_entries(book_info_html)
    normalized = normalize_scraped_book(
        {
            "book_title": "ম্যালিস",
            "author": "কেইগো হিগাশিনো",
            "series": "",
            "book_type": "",
            "book_info": "",
            "main_content": main_content_html,
        }
    )

    assert any(entry["role"] == "translator" and "সালমান হক" in entry["value"] for entry in entries)
    assert any(entry["key"] == "first_published" and entry["value"] == "মার্চ ২০২৩" for entry in entries)
    assert "অনুবাদ: সালমান হক, ইশরাক অর্ণব" not in cleaned_main_content
    assert "প্রথম প্রকাশ: মার্চ ২০২৩" not in cleaned_main_content
    assert "এটাই মূল কনটেন্ট।" in cleaned_main_content
    assert any(
        contributor["name"] == "সালমান হক" and contributor["role"] == "translator"
        for contributor in normalized["contributors"]
    )
    assert any(
        contributor["name"] == "ইশরাক অর্ণব" and contributor["role"] == "translator"
        for contributor in normalized["contributors"]
    )


def test_normalize_scraped_book_ignores_translator_biography_and_keeps_only_name():
    normalized = normalize_scraped_book(
        {
            "book_title": "উদাহরণ",
            "author": "লেখক এক",
            "series": "",
            "book_type": "",
            "book_info": """
            <p><strong>অনুবাদক</strong>: মাকসুদুজ্জামান খান বায়োটেকনোলজি এন্ড জেনেটিক ইঞ্জিনিয়ারিং এ পড়ালেখা করছেন।
            তিনি আর্থার সি ক্লার্ক ও আইজাক আসিমভের বেশ কিছু লেখা ভাষান্তর করেছেন।, মাকসুদুজ্জামান খান</p>
            """,
        }
    )

    translators = [entry["name"] for entry in normalized["contributors"] if entry["role"] == "translator"]

    assert translators == ["মাকসুদুজ্জামান খান"]


def test_normalize_scraped_book_splits_multiple_translators_joined_with_connector():
    normalized = normalize_scraped_book(
        {
            "book_title": "উদাহরণ",
            "author": "লেখক এক",
            "series": "",
            "book_type": "",
            "book_info": """
            <p><strong>অনুবাদ</strong>: সালমান হক ও ইশরাক অর্ণব</p>
            """,
        }
    )

    translators = [entry["name"] for entry in normalized["contributors"] if entry["role"] == "translator"]

    assert translators == ["সালমান হক", "ইশরাক অর্ণব"]


def test_front_matter_extraction_rejects_translator_prose_without_name_like_values():
    book_info_html = """
    <p><strong>অনুবাদক</strong>: তিনি আর্থার সি ক্লার্ক ও আইজাক আসিমভের বেশ কিছু লেখা ভাষান্তর করেছেন।</p>
    """

    entries = extract_front_matter_entries(book_info_html)
    normalized = normalize_scraped_book(
        {
            "book_title": "উদাহরণ",
            "author": "লেখক এক",
            "series": "",
            "book_type": "",
            "book_info": book_info_html,
        }
    )

    assert not any(entry["role"] == "translator" for entry in entries)
    assert not any(contributor["role"] == "translator" for contributor in normalized["contributors"])


def test_clean_extracted_dedication_html_removes_repeated_dedication_heading():
    dedication_html = clean_extracted_dedication_html(
        """
        <p>উৎসর্গ</p>
        <p><strong>উৎসর্গ</strong></p>
        <p>আহমেদ নাফিস শাহরিয়ারকে</p>
        <p>২২ আগস্ট, ১৯৯৪</p>
        """
    )

    assert "আহমেদ নাফিস শাহরিয়ারকে" in dedication_html
    assert "২২ আগস্ট, ১৯৯৪" in dedication_html
    assert "উৎসর্গ" not in dedication_html


def test_clean_extracted_dedication_html_keeps_inline_content_after_label():
    dedication_html = clean_extracted_dedication_html(
        """
        <p>উৎসর্গ :<br/>পাঠক, আপনাকে…</p>
        """
    )

    assert "পাঠক, আপনাকে…" in dedication_html
    assert "উৎসর্গ" not in dedication_html


def test_extract_main_content_segments_omits_dedication_heading_from_extracted_dedication():
    _, dedication_html, cleaned_main_content = extract_main_content_segments(
        """
        <div>
          <p>উৎসর্গ</p>
          <p><strong>উৎসর্গ</strong></p>
          <p>আহমেদ নাফিস শাহরিয়ারকে</p>
          <p>২২ আগস্ট, ১৯৯৪</p>
          <p><strong>ভূমিকা</strong></p>
          <p>এটাই মূল কনটেন্ট।</p>
        </div>
        """
    )

    assert "আহমেদ নাফিস শাহরিয়ারকে" in dedication_html
    assert "উৎসর্গ" not in dedication_html
    assert "এটাই মূল কনটেন্ট।" in cleaned_main_content


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
def test_new_url_submission_does_not_reuse_deleted_ready_submission(monkeypatch):
    user = User.objects.create_user(email="deleted-reuse@example.com", password="strong-password-123")
    deleted_book = Book.objects.create(title="মুছে ফেলা বই", state="soft_deleted", review_state="approved")
    Book.objects.filter(pk=deleted_book.pk).update(deleted_at=timezone.now())
    deleted_book.refresh_from_db()
    BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/deleted-book/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/deleted-book/"),
        resolved_url="https://www.ebanglalibrary.com/books/deleted-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.READY,
        linked_book=deleted_book,
    )

    monkeypatch.setattr("apps.ingestion.services.submissions.capture_source_page_metadata", lambda url: None)

    recreated_submission = create_submission_records(
        submitter=user,
        parsed_entries=[{"kind": "url", "value": "https://www.ebanglalibrary.com/books/deleted-book/"}],
        auto_process=False,
    )[0]

    assert recreated_submission.linked_book_id is None
    assert recreated_submission.canonical_submission_id is None
    assert recreated_submission.status == SubmissionStatus.QUEUED
    assert recreated_submission.resolved_url == "https://www.ebanglalibrary.com/books/deleted-book/"


@pytest.mark.django_db
def test_new_url_submission_does_not_reuse_failed_request(monkeypatch):
    user = User.objects.create_user(email="failed-reuse@example.com", password="strong-password-123")
    failed_submission = BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/failed-book/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/failed-book/"),
        resolved_url="https://www.ebanglalibrary.com/books/failed-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.FAILED,
        error_message="Processing failed.",
    )

    monkeypatch.setattr("apps.ingestion.services.submissions.capture_source_page_metadata", lambda url: None)

    recreated_submission = create_submission_records(
        submitter=user,
        parsed_entries=[{"kind": "url", "value": "https://www.ebanglalibrary.com/books/failed-book/"}],
        auto_process=False,
    )[0]

    assert recreated_submission.id != failed_submission.id
    assert recreated_submission.canonical_submission_id is None
    assert recreated_submission.status == SubmissionStatus.QUEUED


@pytest.mark.django_db
def test_retrying_deleted_submission_clears_reused_state_and_queues_recreation(client, monkeypatch):
    user = User.objects.create_user(email="retry-deleted@example.com", password="strong-password-123")
    url = (
        "https://www.ebanglalibrary.com/books/"
        "%E0%A7%A8%E0%A7%A6%E0%A7%A6%E0%A7%A7-%E0%A6%86-%E0%A6%B8%E0%A7%8D%E0%A6%AA%E0%A7%87%E0%A6%B8-"
        "%E0%A6%93%E0%A6%A1%E0%A6%BF%E0%A6%B8%E0%A6%BF-%E0%A6%86%E0%A6%B0%E0%A7%8D%E0%A6%A5%E0%A6%BE%E0%A6%B0/"
    )
    deleted_book = Book.objects.create(title="২০০১ : আ স্পেস ওডিসি", state="soft_deleted", review_state="approved")
    Book.objects.filter(pk=deleted_book.pk).update(deleted_at=timezone.now())
    deleted_book.refresh_from_db()
    submission = BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input=url,
        normalized_input=normalize_text(url),
        resolved_url=url,
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.READY,
        review_state=ReviewState.APPROVED,
        linked_book=deleted_book,
        duplicate_of_book=deleted_book,
        raw_payload={
            "served_from_database": True,
            "existing_book_source": "source_url",
            "linked_book_slug": deleted_book.slug,
        },
    )
    monkeypatch.setattr("apps.ingestion.services.submissions.dispatch_processing_job", lambda job, force=False: job)
    client.force_login(user)

    response = client.post(
        f"/api/ingestion/submissions/{submission.id}/retry/",
        data=json.dumps({}),
        content_type="application/json",
    )

    assert response.status_code == 202
    submission.refresh_from_db()
    assert submission.status == SubmissionStatus.QUEUED
    assert submission.review_state == ReviewState.PENDING
    assert submission.linked_book_id is None
    assert submission.duplicate_of_book_id is None
    assert submission.raw_payload.get("served_from_database") is None
    assert submission.raw_payload.get("existing_book_source") is None
    assert submission.raw_payload.get("linked_book_slug") is None
    assert ProcessingJob.objects.filter(submission=submission, status=JobStatus.QUEUED).count() == 1


@pytest.mark.django_db
def test_detect_metadata_duplicate_ignores_deleted_books():
    deleted_book = Book.objects.create(title="ম্যালিস", state="soft_deleted", review_state="approved")
    contributor = Contributor.objects.create(name="সৈকত মুখোপাধ্যায়")
    BookContributor.objects.create(book=deleted_book, contributor=contributor, role="author")
    Book.objects.filter(pk=deleted_book.pk).update(deleted_at=timezone.now())

    duplicate = detect_metadata_duplicate({"book_title": "ম্যালিস", "author": "সৈকত মুখোপাধ্যায়"})

    assert duplicate is None


@pytest.mark.django_db
def test_successful_deleted_book_recreation_is_not_reprocessed_again(tmp_path, monkeypatch):
    user = User.objects.create_user(email="recreate-2001@example.com", password="strong-password-123")
    url = (
        "https://www.ebanglalibrary.com/books/"
        "%E0%A7%A8%E0%A7%A6%E0%A7%A6%E0%A7%A7-%E0%A6%86-%E0%A6%B8%E0%A7%8D%E0%A6%AA%E0%A7%87%E0%A6%B8-"
        "%E0%A6%93%E0%A6%A1%E0%A6%BF%E0%A6%B8%E0%A6%BF-%E0%A6%86%E0%A6%B0%E0%A7%8D%E0%A6%A5%E0%A6%BE%E0%A6%B0/"
    )
    deleted_book = Book.objects.create(title="২০০১ : আ স্পেস ওডিসি", state="soft_deleted", review_state=ReviewState.APPROVED)
    Book.objects.filter(pk=deleted_book.pk).update(deleted_at=timezone.now())
    deleted_book.refresh_from_db()
    BookSource.objects.create(
        book=deleted_book,
        source_url=url,
        normalized_source_url=url,
        source_title=deleted_book.title,
    )
    submission = BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input=url,
        normalized_input=normalize_text(url),
        resolved_url=url,
        resolution_status=ResolutionStatus.RESOLVED,
        resolution_confidence=1.0,
        status=SubmissionStatus.QUEUED,
        review_state=ReviewState.PENDING,
    )
    job = ProcessingJob.objects.create(submission=submission)

    sample = {
        "book_title": "২০০১ : আ স্পেস ওডিসি",
        "author": "আর্থার সি ক্লার্ক",
        "series": "",
        "book_type": "",
        "cover": "book_cover.jpg",
        "main_content": "<p>মূল অংশ</p>",
        "book_info": "",
        "dedication": "",
        "toc": [{"title": "অধ্যায় ১", "type": "lesson", "has_content": True}],
        "content_items": [{"title": "অধ্যায় ১", "content": "<p>বিষয়বস্তু</p>", "type": "lesson", "parent": None}],
        "output_folder": str(tmp_path),
    }

    monkeypatch.setattr("apps.ingestion.services.submissions.capture_source_page_metadata", lambda url: None)
    monkeypatch.setattr("apps.ingestion.services.submissions.scrape_book", lambda url: sample)

    def fake_generate_exports(book_data):
        output_dir = Path(book_data["output_folder"])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "book.html").write_text("<html><body>book</body></html>", encoding="utf-8")
        (output_dir / "২০০১ : আ স্পেস ওডিসি.epub").write_bytes(b"epub-bytes")
        (output_dir / "book_cover.jpg").write_bytes(b"cover-bytes")

    monkeypatch.setattr("apps.ingestion.services.submissions.generate_exports", fake_generate_exports)

    process_submission_job(str(job.id))
    submission.refresh_from_db()
    assert submission.status == SubmissionStatus.READY
    assert submission.raw_payload["served_from_database"] is False
    first_linked_book_id = submission.linked_book_id
    assert first_linked_book_id == deleted_book.id
    assert submission.linked_book.deleted_at is None

    repeated_job = process_submission_job(str(job.id))
    submission.refresh_from_db()

    assert repeated_job.id == job.id
    assert submission.status == SubmissionStatus.READY
    assert submission.raw_payload["served_from_database"] is False
    assert submission.linked_book_id == first_linked_book_id
    assert submission.linked_book.deleted_at is None
    assert BookSource.objects.get(normalized_source_url=url).book_id == first_linked_book_id


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
def test_submission_detail_marks_soft_deleted_linked_book_as_deleted(client):
    user = User.objects.create_user(email="deleted-submission@example.com", password="strong-password-123")
    book = Book.objects.create(title="মুছে ফেলা বই", state="soft_deleted", review_state="approved")
    Book.objects.filter(pk=book.pk).update(deleted_at=timezone.now())
    book.refresh_from_db()
    submission = BookSubmission.objects.create(
        submitter=user,
        input_type="title",
        original_input="মুছে ফেলা বই",
        normalized_input=normalize_text("মুছে ফেলা বই"),
        linked_book=book,
        resolved_url="https://www.ebanglalibrary.com/books/deleted-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        resolution_confidence=1.0,
        status=SubmissionStatus.READY,
    )
    client.force_login(user)

    response = client.get(f"/api/ingestion/submissions/{submission.id}/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "deleted"
    assert payload["linked_book_deleted"] is True
    assert payload["linked_book_slug"] == ""
    assert payload["linked_book"]["title"] == "মুছে ফেলা বই"


@pytest.mark.django_db
def test_submission_action_links_reject_soft_deleted_linked_book(client):
    user = User.objects.create_user(email="deleted-action-links@example.com", password="strong-password-123")
    book = Book.objects.create(title="মুছে ফেলা বই", state="soft_deleted", review_state="approved")
    Book.objects.filter(pk=book.pk).update(deleted_at=timezone.now())
    book.refresh_from_db()
    submission = BookSubmission.objects.create(
        submitter=user,
        input_type="title",
        original_input="মুছে ফেলা বই",
        normalized_input=normalize_text("মুছে ফেলা বই"),
        linked_book=book,
        resolved_url="https://www.ebanglalibrary.com/books/deleted-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        resolution_confidence=1.0,
        status=SubmissionStatus.READY,
    )
    client.force_login(user)

    response = client.post(
        f"/api/ingestion/submissions/{submission.id}/action-links/",
        data=json.dumps({}),
        content_type="application/json",
    )

    assert response.status_code == 410
    assert response.json()["detail"] == "This book was deleted."


@pytest.mark.django_db
def test_duplicate_review_keep_new_queues_recreate_for_deleted_existing_book(client, settings, monkeypatch):
    settings.CELERY_TASK_ALWAYS_EAGER = False
    admin = User.objects.create_superuser(email="deleted-review-admin@example.com", password="strong-password-123")
    deleted_book = Book.objects.create(title="মুছে ফেলা বই", state="soft_deleted", review_state="approved")
    Book.objects.filter(pk=deleted_book.pk).update(deleted_at=timezone.now())
    deleted_book.refresh_from_db()
    submission = BookSubmission.objects.create(
        submitter=admin,
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/deleted-book/",
        normalized_input=normalize_text("https://www.ebanglalibrary.com/books/deleted-book/"),
        resolved_url="https://www.ebanglalibrary.com/books/deleted-book/",
        resolution_status=ResolutionStatus.RESOLVED,
        status=SubmissionStatus.DUPLICATE,
        review_state="needs_review",
        linked_book=deleted_book,
        duplicate_of_book=deleted_book,
        raw_payload={"served_from_database": True, "linked_book_slug": deleted_book.slug},
    )
    review = DuplicateReview.objects.create(
        submission=submission,
        existing_book=deleted_book,
        detected_by="normalized_metadata",
        status=DuplicateReviewStatus.PENDING,
    )
    monkeypatch.setattr("apps.ingestion.services.submissions.dispatch_processing_job", lambda job, force=False: job)
    client.force_login(admin)

    response = client.post(
        f"/api/ingestion/duplicate-reviews/{review.id}/resolve/",
        data=json.dumps({"decision": "dismiss"}),
        content_type="application/json",
    )

    assert response.status_code == 200
    review.refresh_from_db()
    submission.refresh_from_db()
    assert review.status == DuplicateReviewStatus.DISMISSED
    assert submission.status == SubmissionStatus.QUEUED
    assert submission.review_state == "pending"
    assert submission.linked_book_id is None
    assert submission.duplicate_of_book_id is None
    assert submission.raw_payload.get("served_from_database") is None
    assert ProcessingJob.objects.filter(submission=submission, status=JobStatus.QUEUED).count() == 1


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
    generated_payload = {}

    def fake_scrape_book(url):
        return sample

    def fake_generate_exports(book_data):
        generated_payload.update(book_data)
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
    assert book.dedication_html == ""
    assert book.content_items == sample["content_items"]
    assert generated_payload["book_title"] == book.title
    assert generated_payload["dedication"] == book.dedication_html
    assert generated_payload["content_items"] == book.content_items
    assert book.generated_assets.filter(asset_type=GeneratedAssetType.HTML).exists()
    assert book.generated_assets.filter(asset_type=GeneratedAssetType.EPUB).exists()
    assert book.generated_assets.filter(asset_type=GeneratedAssetType.COVER).exists()


@pytest.mark.django_db
def test_process_submission_job_resolves_cover_asset_when_scraped_extension_is_wrong(tmp_path, monkeypatch):
    user = User.objects.create_user(email="processor-cover@example.com", password="strong-password-123")
    submission = BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/test-cover-book/",
        normalized_input="test cover book",
        resolved_url="https://www.ebanglalibrary.com/books/test-cover-book/",
        resolution_status="resolved",
        resolution_confidence=1.0,
        status="queued",
    )
    job = ProcessingJob.objects.create(submission=submission)

    sample = {
        "book_title": "কভার টেস্ট বুক",
        "author": "লেখক এক",
        "series": "",
        "book_type": "",
        "cover": "book_image.hpg",
        "main_content": "<p>মূল অংশ</p>",
        "book_info": "",
        "dedication": "",
        "toc": [{"title": "অধ্যায় ১", "type": "lesson", "has_content": True}],
        "content_items": [{"title": "অধ্যায় ১", "content": "<p>বিষয়বস্তু</p>", "type": "lesson", "parent": None}],
        "output_folder": str(tmp_path),
    }

    def fake_scrape_book(url):
        return sample

    def fake_generate_exports(book_data):
        output_dir = Path(book_data["output_folder"])
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "book.html").write_text(
            "<html><body><img src='book_image.hpg' alt='Book Cover'></body></html>",
            encoding="utf-8",
        )
        (output_dir / "কভার টেস্ট বুক.epub").write_bytes(b"epub-bytes")
        (output_dir / "book_cover.jpg").write_bytes(b"cover-bytes")

    monkeypatch.setattr("apps.ingestion.services.submissions.scrape_book", fake_scrape_book)
    monkeypatch.setattr("apps.ingestion.services.submissions.generate_exports", fake_generate_exports)

    process_submission_job(str(job.id))

    cover_asset = GeneratedAsset.objects.get(asset_type=GeneratedAssetType.COVER)
    assert cover_asset.status == GeneratedAssetStatus.READY
    assert cover_asset.legacy_path == ""


@pytest.mark.django_db
def test_process_submission_job_keeps_only_media_copies_of_generated_assets(tmp_path, settings, monkeypatch):
    settings.MEDIA_ROOT = tmp_path / "media"

    user = User.objects.create_user(email="single-copy@example.com", password="strong-password-123")
    submission = BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/single-copy-book/",
        normalized_input="single copy book",
        resolved_url="https://www.ebanglalibrary.com/books/single-copy-book/",
        resolution_status="resolved",
        resolution_confidence=1.0,
        status="queued",
    )
    job = ProcessingJob.objects.create(submission=submission)
    output_dir = tmp_path / "legacy-output"

    sample = {
        "book_title": "একক কপি বই",
        "author": "লেখক এক",
        "series": "",
        "book_type": "",
        "cover": "book_cover.jpg",
        "main_content": "<p>মূল অংশ</p>",
        "book_info": "",
        "dedication": "",
        "toc": [{"title": "অধ্যায় ১", "type": "lesson", "has_content": True}],
        "content_items": [{"title": "অধ্যায় ১", "content": "<p>বিষয়বস্তু</p>", "type": "lesson", "parent": None}],
        "output_folder": str(output_dir),
    }

    def fake_scrape_book(url):
        return sample

    def fake_generate_exports(book_data):
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "book.html").write_text("<html><body>book</body></html>", encoding="utf-8")
        (output_dir / "একক কপি বই.epub").write_bytes(b"epub-bytes")
        (output_dir / "book_cover.jpg").write_bytes(b"cover-bytes")

    monkeypatch.setattr("apps.ingestion.services.submissions.scrape_book", fake_scrape_book)
    monkeypatch.setattr("apps.ingestion.services.submissions.generate_exports", fake_generate_exports)

    process_submission_job(str(job.id))

    book = Book.objects.get()
    media_dir = Path(settings.MEDIA_ROOT) / "generated" / book.slug
    saved_names = sorted(path.name for path in media_dir.iterdir())
    assert "book.html" in saved_names
    assert "book_cover.jpg" in saved_names
    assert len([name for name in saved_names if name.endswith(".epub")]) == 1
    assert len(saved_names) == 3
    assert not output_dir.exists()

    for asset in book.generated_assets.order_by("asset_type"):
        assert asset.legacy_path == ""
        assert asset.file


@pytest.mark.django_db
def test_process_submission_job_replaces_existing_media_assets_instead_of_creating_duplicates(tmp_path, settings, monkeypatch):
    settings.MEDIA_ROOT = tmp_path / "media"

    user = User.objects.create_user(email="replace-assets@example.com", password="strong-password-123")
    output_dir = tmp_path / "legacy-output"

    submission_one = BookSubmission.objects.create(
        submitter=user,
        input_type="url",
        original_input="https://www.ebanglalibrary.com/books/reprocess-book/",
        normalized_input="reprocess book",
        resolved_url="https://www.ebanglalibrary.com/books/reprocess-book/",
        resolution_status="resolved",
        resolution_confidence=1.0,
        status="queued",
    )
    first_job = ProcessingJob.objects.create(submission=submission_one)

    first_scraped = {
        "book_title": "পুনরায় বই",
        "author": "লেখক এক",
        "series": "",
        "book_type": "",
        "cover": "book_cover.jpg",
        "main_content": "<p>মূল অংশ</p>",
        "book_info": "",
        "dedication": "",
        "toc": [{"title": "অধ্যায় ১", "type": "lesson", "has_content": True}],
        "content_items": [{"title": "অধ্যায় ১", "content": "<p>বিষয়বস্তু</p>", "type": "lesson", "parent": None}],
        "output_folder": str(output_dir),
    }

    def fake_scrape_book(url):
        return first_scraped

    def fake_generate_exports(book_data):
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "book.html").write_text("<html><body>first</body></html>", encoding="utf-8")
        (output_dir / "পুনরায় বই.epub").write_bytes(b"first")
        (output_dir / "book_cover.jpg").write_bytes(b"first")

    monkeypatch.setattr("apps.ingestion.services.submissions.scrape_book", fake_scrape_book)
    monkeypatch.setattr("apps.ingestion.services.submissions.generate_exports", fake_generate_exports)

    process_submission_job(str(first_job.id))

    book = Book.objects.get()
    second_job = ProcessingJob.objects.create(submission=submission_one, job_type="ingestion")
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "book.html").write_text("<html><body>second</body></html>", encoding="utf-8")
    (output_dir / "পুনরায় বই.epub").write_bytes(b"second")
    (output_dir / "book_cover.jpg").write_bytes(b"second")

    sync_assets(
        book,
        second_job,
        {
            **first_scraped,
            "output_folder": str(output_dir),
        },
    )

    media_dir = Path(settings.MEDIA_ROOT) / "generated" / book.slug
    saved_paths = sorted(media_dir.iterdir())
    saved_names = [path.name for path in saved_paths]
    assert "book.html" in saved_names
    assert "book_cover.jpg" in saved_names
    assert len([name for name in saved_names if name.endswith(".epub")]) == 1
    assert len(saved_names) == 3
    assert (media_dir / "book.html").read_text(encoding="utf-8") == "<html><body>second</body></html>"
    cover_path = media_dir / "book_cover.jpg"
    assert cover_path.read_bytes() == b"second"
    assert not output_dir.exists()


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
