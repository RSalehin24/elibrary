import importlib
import importlib.util
import sys
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse, urlunparse


LEGACY_CODE_DIR = Path(__file__).resolve().parents[4] / "code"
ALLOWED_HOSTS = {"ebanglalibrary.com", "www.ebanglalibrary.com"}


@contextmanager
def legacy_code_path():
    path_str = str(LEGACY_CODE_DIR)
    if path_str not in sys.path:
        sys.path.insert(0, path_str)
        inserted = True
    else:
        inserted = False

    try:
        yield
    finally:
        if inserted and path_str in sys.path:
            sys.path.remove(path_str)


@lru_cache(maxsize=1)
def legacy_modules():
    with legacy_code_path():
        scraper = importlib.import_module("scraper")
        html_book = importlib.import_module("html_book")
        epub_book = importlib.import_module("epub_book")
    return scraper, html_book, epub_book


def load_legacy_config_entries():
    config_path = LEGACY_CODE_DIR / "config.py"
    if not config_path.exists():
        return []

    spec = importlib.util.spec_from_file_location("legacy_code_config", config_path)
    module = importlib.util.module_from_spec(spec)
    if spec.loader is None:
        return []
    spec.loader.exec_module(module)
    return getattr(module, "BOOK_URLS", [])


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
