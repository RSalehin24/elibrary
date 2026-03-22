import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from apps.ingestion.models import SourceCatalogEntry
from apps.ingestion.services.legacy_adapter import ALLOWED_HOSTS, normalize_source_url, normalize_text, texts_are_similar


CATALOG_URL = "https://www.ebanglalibrary.com/books/"
ARCHIVE_MAX_PAGES = 80
SEARCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    )
}


@dataclass
class ResolutionResult:
    status: str
    confidence: float
    resolved_url: str
    candidates: list
    raw: dict


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


def parse_source_page_metadata(html, source_url):
    soup = BeautifulSoup(html, "html.parser")
    title_tag = soup.find("title")
    full_title = title_tag.get_text(" ", strip=True) if title_tag else ""
    title = full_title
    title_author = ""
    for separator in (" - ", " – ", " — ", "-", "–", "—"):
        if separator in full_title:
            title, title_author = full_title.split(separator, 1)
            title = title.strip()
            title_author = title_author.strip()
            break

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
    response = session.get(normalized_url, timeout=30)
    response.raise_for_status()
    return parse_source_page_metadata(response.text, normalized_url)


def upsert_source_catalog_entry(metadata):
    entry, _ = SourceCatalogEntry.objects.update_or_create(
        source_url=metadata["source_url"],
        defaults=metadata,
    )
    return entry


class TitleResolver:
    def __init__(self, session=None):
        self.session = session or requests.Session()
        self.session.headers.update(SEARCH_HEADERS)

    def refresh_catalog(self, max_pages=1, bucket=""):
        refreshed = []
        seen = set()
        page_signatures = set()
        for page_number in range(1, max_pages + 1):
            response = self.session.get(
                CATALOG_URL,
                params=self.archive_query_params(page_number=page_number, bucket=bucket),
                timeout=30,
            )
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "html.parser")
            page_entries = self.parse_catalog_page(soup)
            if not page_entries:
                break

            signature = tuple(entry["source_url"] for entry in page_entries[:5])
            if signature in page_signatures:
                break
            page_signatures.add(signature)

            for entry in page_entries:
                if entry["source_url"] in seen:
                    continue
                seen.add(entry["source_url"])
                SourceCatalogEntry.objects.update_or_create(
                    source_url=entry["source_url"],
                    defaults=entry,
                )
                refreshed.append(entry)

        return refreshed

    def archive_query_params(self, page_number=1, bucket=""):
        params = {}
        if bucket:
            params["_a_z"] = bucket
        if page_number > 1:
            params["_paged"] = page_number
        return params

    def derive_bucket(self, query):
        for char in query.strip():
            if char.isalnum() or "\u0980" <= char <= "\u09ff":
                return char.upper() if char.isascii() else char
        return ""

    def split_display_title(self, display_title):
        cleaned = re.sub(r"\s+", " ", display_title).strip()
        for separator in (" - ", " – ", " — "):
            if separator in cleaned:
                title, author_line = cleaned.rsplit(separator, 1)
                return title.strip(), author_line.strip()
        return cleaned, ""

    def score_candidate_fields(self, query, normalized_query, title, author_line=""):
        normalized_title = normalize_text(title)
        normalized_display = normalize_text(f"{title} {author_line}")
        if normalized_title == normalized_query or normalized_display == normalized_query:
            return 1.0
        if texts_are_similar(query, title):
            return 0.88
        if normalized_query and (
            normalized_query in normalized_title or normalized_title in normalized_query
        ):
            return 0.78

        query_tokens = set(normalized_query.split())
        candidate_tokens = set(normalized_display.split())
        if query_tokens and candidate_tokens:
            overlap = len(query_tokens & candidate_tokens) / len(query_tokens | candidate_tokens)
            return round(overlap * 0.75, 3)
        return 0.0

    def parse_catalog_page(self, soup):
        entries = []
        seen = set()
        for result in soup.select(".facetwp-template .fwpl-result"):
            text_anchor = result.select_one(".fwpl-item.el-97dha a[href]")
            anchor = text_anchor or result.select_one("a[href]")
            if anchor is None:
                continue

            href = urljoin(CATALOG_URL, anchor["href"])
            parsed = urlparse(href)
            if parsed.netloc.lower() not in ALLOWED_HOSTS:
                continue
            if not parsed.path.startswith("/books/"):
                continue
            display_title = anchor.get_text(" ", strip=True)
            if not display_title or href in seen:
                continue
            seen.add(href)
            title, author_line = self.split_display_title(display_title)
            entries.append(
                metadata_entry_defaults(
                    source_url=href.rstrip("/") + "/",
                    title=title,
                    author_line=author_line,
                    raw_data={
                        "title": title,
                        "display_title": display_title,
                        "author_line": author_line,
                        "metadata_source": "archive_page",
                    },
                )
            )
        return entries

    def score_entry(self, query, normalized_query, entry):
        return self.score_candidate_fields(query, normalized_query, entry.title, entry.author_line)

    def collect_candidates(self, query, normalized_query):
        candidates = []
        for entry in SourceCatalogEntry.objects.all():
            confidence = self.score_entry(query, normalized_query, entry)
            if confidence <= 0:
                continue
            candidates.append(
                {
                    "title": entry.title,
                    "author": entry.author_line,
                    "url": entry.source_url,
                    "confidence": confidence,
                }
            )

        candidates.sort(key=lambda item: item["confidence"], reverse=True)
        return candidates[:3]

    def enrich_candidates_with_source_metadata(self, query, normalized_query, candidates):
        enriched_candidates = []
        for candidate in candidates:
            next_candidate = dict(candidate)
            try:
                metadata = fetch_source_page_metadata(candidate["url"], session=self.session)
                upsert_source_catalog_entry(metadata)
                next_candidate["title"] = metadata["title"]
                next_candidate["author"] = metadata["author_line"]
                next_candidate["confidence"] = max(
                    candidate["confidence"],
                    self.score_candidate_fields(query, normalized_query, metadata["title"], metadata["author_line"]),
                )
            except Exception:
                pass
            enriched_candidates.append(next_candidate)

        enriched_candidates.sort(key=lambda item: item["confidence"], reverse=True)
        return enriched_candidates[:3]

    def resolve(self, query, refresh_catalog=False):
        normalized_query = normalize_text(query)
        top_candidates = self.collect_candidates(query, normalized_query)

        should_refresh = refresh_catalog or not top_candidates
        if should_refresh:
            bucket = self.derive_bucket(query)
            self.refresh_catalog(
                max_pages=ARCHIVE_MAX_PAGES,
                bucket=bucket,
            )
            top_candidates = self.collect_candidates(query, normalized_query)

        if top_candidates:
            top_candidates = self.enrich_candidates_with_source_metadata(query, normalized_query, top_candidates)

        if top_candidates:
            top = top_candidates[0]
            second = top_candidates[1] if len(top_candidates) > 1 else None
            if top["confidence"] == 1.0 and (second is None or second["confidence"] < 1.0):
                return ResolutionResult(
                    status="exact_match",
                    confidence=top["confidence"],
                    resolved_url=top["url"],
                    candidates=top_candidates,
                    raw={"query": query},
                )

        if top_candidates:
            return ResolutionResult(
                status="ambiguous",
                confidence=top_candidates[0]["confidence"],
                resolved_url="",
                candidates=top_candidates,
                raw={"query": query},
            )

        return ResolutionResult(
            status="unresolved",
            confidence=0.0,
            resolved_url="",
            candidates=[],
            raw={"query": query},
        )
