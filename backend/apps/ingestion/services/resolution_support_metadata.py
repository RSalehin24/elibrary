import re

import requests
from bs4 import BeautifulSoup

from apps.ingestion.models import SourceCatalogEntry
from apps.ingestion.services.legacy_adapter import normalize_source_url, normalize_text
from apps.ingestion.services.resolution_support_hosts import SEARCH_HEADERS
from apps.ingestion.services.resolution_support_network import get_with_host_fallback


def metadata_entry_defaults(source_url, title, author_line="", raw_data=None):
    normalized_title = normalize_text(title)
    display_parts = [title, author_line]
    return {
        "source_url": source_url,
        "title": title,
        "author_line": author_line,
        "normalized_title": normalized_title,
        "normalized_display": normalize_text(" ".join(part for part in display_parts if part)),
        "raw_data": raw_data or {},
    }


def split_display_title(display_title):
    cleaned = re.sub(r"\s+", " ", display_title).strip()
    for separator in (" - ", " – ", " — "):
        if separator in cleaned:
            title, author_line = cleaned.rsplit(separator, 1)
            return title.strip(), author_line.strip()
    return cleaned, ""


def parse_source_page_metadata(html, source_url):
    soup = BeautifulSoup(html, "html.parser")
    title_tag = soup.find("title")
    full_title = title_tag.get_text(" ", strip=True) if title_tag else ""
    title, title_author = split_display_title(full_title)

    author_line = ""
    series = ""
    category = ""
    meta = soup.find("div", class_="entry-meta entry-meta-after-content")
    if meta:
        def read_terms(class_name):
            span = meta.find("span", class_=class_name)
            if span is None:
                return ""
            links = span.find_all("a")
            if links:
                return ", ".join(link.get_text(" ", strip=True) for link in links)
            return span.get_text(" ", strip=True)

        author_line = read_terms("entry-terms-authors") or title_author
        series = read_terms("entry-terms-series")
        category = read_terms("entry-terms-ld_course_category")
    else:
        author_line = title_author

    canonical = soup.find("link", rel="canonical")
    canonical_url = canonical.get("href", "").strip() if canonical else ""
    normalized_url = normalize_source_url(canonical_url or source_url)
    if not full_title and not author_line and not series and not category:
        raise ValueError("The source page did not contain recognizable metadata.")

    raw_data = {
        "title": title,
        "full_title": full_title,
        "author_line": author_line,
        "series": series,
        "category": category,
        "metadata_source": "book_page",
    }
    return metadata_entry_defaults(
        source_url=normalized_url,
        title=title or normalized_url.rstrip("/").split("/")[-1],
        author_line=author_line,
        raw_data=raw_data,
    )


def fetch_source_page_metadata(source_url, session=None):
    session = session or requests.Session()
    session.headers.update(SEARCH_HEADERS)
    normalized_url = normalize_source_url(source_url)
    response = get_with_host_fallback(session, normalized_url, timeout=30)
    response.raise_for_status()
    return parse_source_page_metadata(response.text, normalized_url)


def upsert_source_catalog_entry(metadata):
    entry, _ = SourceCatalogEntry.objects.update_or_create(
        source_url=metadata["source_url"],
        defaults=metadata,
    )
    return entry

