from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from apps.ingestion.models import SourceCatalogEntry
from apps.ingestion.services.legacy_adapter import ALLOWED_HOSTS, normalize_text, texts_are_similar


CATALOG_URL = "https://www.ebanglalibrary.com/books/"
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


class TitleResolver:
    def __init__(self, session=None):
        self.session = session or requests.Session()
        self.session.headers.update(SEARCH_HEADERS)

    def refresh_catalog(self, max_pages=1):
        next_url = CATALOG_URL
        refreshed = []
        seen = set()
        for _ in range(max_pages):
            if not next_url:
                break

            response = self.session.get(next_url, timeout=30)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "html.parser")
            page_entries = self.parse_catalog_page(soup)
            for entry in page_entries:
                if entry["source_url"] in seen:
                    continue
                seen.add(entry["source_url"])
                SourceCatalogEntry.objects.update_or_create(
                    source_url=entry["source_url"],
                    defaults=entry,
                )
                refreshed.append(entry)
            next_url = self._next_page_url(soup)

        return refreshed

    def parse_catalog_page(self, soup):
        entries = []
        seen = set()
        for anchor in soup.find_all("a", href=True):
            href = urljoin(CATALOG_URL, anchor["href"])
            parsed = urlparse(href)
            if parsed.netloc.lower() not in ALLOWED_HOSTS:
                continue
            if not parsed.path.startswith("/books/"):
                continue
            title = anchor.get_text(" ", strip=True)
            if not title or href in seen:
                continue
            seen.add(href)
            normalized_title = normalize_text(title)
            author_line = ""
            if " - " in title:
                _, author_line = title.rsplit(" - ", 1)
            entries.append(
                {
                    "source_url": href.rstrip("/") + "/",
                    "title": title,
                    "author_line": author_line,
                    "normalized_title": normalized_title,
                    "normalized_display": normalize_text(f"{title} {author_line}"),
                    "raw_data": {"title": title},
                }
            )
        return entries

    def _next_page_url(self, soup):
        link = soup.find("a", rel=lambda value: value and "next" in value)
        if link and link.get("href"):
            return urljoin(CATALOG_URL, link["href"])
        return ""

    def score_entry(self, query, normalized_query, entry):
        if entry.normalized_title == normalized_query or entry.normalized_display == normalized_query:
            return 1.0
        if texts_are_similar(query, entry.title):
            return 0.88
        if normalized_query and (
            normalized_query in entry.normalized_title or entry.normalized_title in normalized_query
        ):
            return 0.78

        query_tokens = set(normalized_query.split())
        candidate_tokens = set(entry.normalized_display.split())
        if query_tokens and candidate_tokens:
            overlap = len(query_tokens & candidate_tokens) / len(query_tokens | candidate_tokens)
            return round(overlap * 0.75, 3)
        return 0.0

    def resolve(self, query, refresh_catalog=False):
        if refresh_catalog or not SourceCatalogEntry.objects.exists():
            self.refresh_catalog()

        normalized_query = normalize_text(query)
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
        top_candidates = candidates[:3]

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
