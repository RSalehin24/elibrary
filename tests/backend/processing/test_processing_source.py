from apps.ingestion.pipeline.scraper_support import network
from apps.processing import source


def test_processing_source_helpers_bypass_legacy_adapter(monkeypatch):
    adapter_failure = AssertionError("legacy adapter should not be used by processing source helpers")

    monkeypatch.setattr(
        "apps.ingestion.services.legacy_adapter.normalize_source_url",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(adapter_failure),
        raising=False,
    )
    monkeypatch.setattr(
        "apps.ingestion.services.legacy_adapter.scrape_book",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(adapter_failure),
        raising=False,
    )
    monkeypatch.setattr(
        "apps.ingestion.services.legacy_adapter.generate_exports",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(adapter_failure),
        raising=False,
    )

    scrape_calls = []
    html_calls = []
    epub_calls = []

    monkeypatch.setattr(
        "apps.processing.source.scraper.scrape_book_data",
        lambda url: scrape_calls.append(url) or {"resolved_url": url},
    )
    monkeypatch.setattr(
        "apps.processing.source.html_book.create_html_book",
        lambda book_data: html_calls.append(book_data),
    )
    monkeypatch.setattr(
        "apps.processing.source.epub_book.create_epub",
        lambda book_data: epub_calls.append(book_data),
    )

    normalized_url = source.normalize_source_url(
        "https://ebanglalibrary.com/books/example-book"
    )
    assert normalized_url == "https://www.ebanglalibrary.com/books/example-book/"

    scraped = source.scrape_book("https://ebanglalibrary.com/books/example-book")
    assert scraped == {"resolved_url": normalized_url}
    assert scrape_calls == [normalized_url]

    payload = {"book_title": "Example Book", "output_folder": "/tmp/example"}
    source.generate_exports(payload)
    assert html_calls == [payload]
    assert epub_calls == [payload]


def test_get_soup_uses_host_fallback_and_decodes_bangla_html(monkeypatch):
    class FakeSession:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

    class FakeResponse:
        status_code = 200
        headers = {}
        encoding = None
        apparent_encoding = None
        content = (
            "<html><body><h1>অ-আ-ক-খুনের কাঁটা – নারায়ণ সান্যাল</h1></body></html>"
        ).encode("utf-8")

    session = FakeSession()
    calls = []

    monkeypatch.setattr(
        "apps.ingestion.pipeline.scraper_support.network.create_session_with_retries",
        lambda retries=3, backoff_factor=1: session,
    )
    monkeypatch.setattr(
        "apps.ingestion.services.resolution_support_network.get_with_host_fallback",
        lambda session_obj, url, **kwargs: calls.append((session_obj, url, kwargs))
        or FakeResponse(),
    )

    soup = network.get_soup("https://www.ebanglalibrary.com/books/bangla-book/")

    assert soup is not None
    assert soup.find("h1").get_text(strip=True) == "অ-আ-ক-খুনের কাঁটা – নারায়ণ সান্যাল"
    assert calls == [
        (
            session,
            "https://www.ebanglalibrary.com/books/bangla-book/",
            {"headers": network.HEADERS, "timeout": 30},
        )
    ]
    assert session.closed is True
