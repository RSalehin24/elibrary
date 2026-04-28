from functools import lru_cache
from urllib.parse import urlparse, urlunparse

from django.conf import settings

from apps.ingestion.pipeline import config as legacy_config
from apps.ingestion.pipeline import epub_book, html_book, scraper

ALLOWED_HOSTS = {"ebanglalibrary.com", "www.ebanglalibrary.com"}


@lru_cache(maxsize=1)
def legacy_modules():
    return scraper, html_book, epub_book


def load_legacy_config_entries():
    return legacy_config.load_book_urls()


def normalize_source_url(url):
    parsed = urlparse(url.strip())
    host = parsed.netloc.lower()
    if host not in ALLOWED_HOSTS:
        raise ValueError("Only ebanglalibrary.com URLs are allowed.")
    if not parsed.path.startswith("/books/"):
        raise ValueError("Only direct ebanglalibrary book URLs are accepted.")

    source_site_host = (getattr(settings, "SOURCE_SITE_HOST", "www.ebanglalibrary.com") or "www.ebanglalibrary.com").strip().lower()
    normalized_path = parsed.path.rstrip("/") + "/"
    return urlunparse(("https", source_site_host, normalized_path, "", "", ""))


def validate_source_url(url):
    return normalize_source_url(url)


def normalize_text(value):
    scraper, _, _ = legacy_modules()
    return scraper.normalize_text(value)


def texts_are_similar(left, right):
    scraper, _, _ = legacy_modules()
    return scraper.texts_are_similar(left, right)


def scrape_book_with_limits(url, content_limits=None):
    scraper, _, _ = legacy_modules()
    normalized_url = validate_source_url(url)
    return scraper.scrape_book_data(normalized_url, content_limits=content_limits)


def high_fidelity_scrape_limits():
    scraper, _, _ = legacy_modules()
    limits = scraper.normalize_scrape_limits(getattr(scraper, "DEFAULT_SCRAPE_LIMITS", {}))
    limits["disable_recursive"] = False
    return limits


def scrape_book(url):
    return scrape_book_with_limits(url)


def scrape_book_high_fidelity(url):
    return scrape_book_with_limits(
        url,
        content_limits=high_fidelity_scrape_limits(),
    )


def generate_exports(book_data):
    _, html_book, epub_book = legacy_modules()
    html_book.create_html_book(book_data)
    epub_book.create_epub(book_data)
