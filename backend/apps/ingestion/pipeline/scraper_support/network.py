import time
from urllib.parse import urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/144.0.0.0 Safari/537.36"
    )
}

ALLOWED_SOURCE_HOSTS = {"ebanglalibrary.com", "www.ebanglalibrary.com"}


def normalize_source_url(url):
    """Normalize externally supplied ebanglalibrary book URLs."""
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Book URL must start with http:// or https://")
    if parsed.netloc.lower() not in ALLOWED_SOURCE_HOSTS:
        raise ValueError("Only ebanglalibrary.com book URLs are allowed")
    if not parsed.path.startswith("/books/"):
        raise ValueError("Only direct ebanglalibrary book URLs are supported")

    normalized_path = parsed.path.rstrip("/") + "/"
    return urlunparse(("https", "www.ebanglalibrary.com", normalized_path, "", "", ""))


def create_session_with_retries(retries=3, backoff_factor=1):
    """Create a requests session with automatic retry logic."""
    session = requests.Session()
    retry_strategy = Retry(
        total=retries,
        backoff_factor=backoff_factor,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["HEAD", "GET", "OPTIONS"],
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def get_soup(url, max_retries=3):
    """Fetch URL and return BeautifulSoup object with retry logic."""
    session = create_session_with_retries(retries=max_retries)

    for attempt in range(max_retries):
        try:
            response = session.get(url, headers=HEADERS, timeout=30)
            if response.status_code == 200:
                return BeautifulSoup(response.text, "html.parser")
            print(f"Failed to fetch {url} ({response.status_code})")
            return None
        except requests.exceptions.SSLError as error:
            print(f"SSL Error (attempt {attempt + 1}/{max_retries}): {error}")
            if attempt < max_retries - 1:
                wait_time = (attempt + 1) * 5
                print(f"Waiting {wait_time}s before retry...")
                time.sleep(wait_time)
        except requests.exceptions.RequestException as error:
            print(f"Request error (attempt {attempt + 1}/{max_retries}): {error}")
            if attempt < max_retries - 1:
                wait_time = (attempt + 1) * 3
                print(f"Waiting {wait_time}s before retry...")
                time.sleep(wait_time)

    print(f"Failed to fetch {url} after {max_retries} attempts")
    return None


def clean_buttons(soup):
    for button in soup.find_all("button"):
        button.decompose()
    return soup
