from functools import lru_cache
from urllib.parse import urlparse, urlunparse

from apps.ingestion.legacy import config as legacy_config
from apps.ingestion.legacy import epub_book, html_book, scraper

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

    normalized_path = parsed.path.rstrip("/") + "/"
    return urlunparse(("https", "www.ebanglalibrary.com", normalized_path, "", "", ""))


def validate_source_url(url):
    return normalize_source_url(url)


def normalize_text(value):
    scraper, _, _ = legacy_modules()
    return scraper.normalize_text(value)


def texts_are_similar(left, right):
    scraper, _, _ = legacy_modules()
    return scraper.texts_are_similar(left, right)


def scrape_book(url):
    scraper, _, _ = legacy_modules()
    normalized_url = validate_source_url(url)
    return scraper.scrape_book_data(normalized_url)


def generate_exports(book_data):
    _, html_book, epub_book = legacy_modules()
    html_book.create_html_book(book_data)
    epub_book.create_epub(book_data)
