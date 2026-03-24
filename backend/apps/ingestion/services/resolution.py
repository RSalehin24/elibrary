import re
import socket
import struct
from dataclasses import dataclass
from ipaddress import ip_address
from random import randint
from urllib.parse import urlencode, urljoin, urlparse

import requests
import urllib3
from bs4 import BeautifulSoup
from django.conf import settings
from requests.structures import CaseInsensitiveDict

from apps.ingestion.models import SourceCatalogEntry
from apps.ingestion.services.legacy_adapter import ALLOWED_HOSTS, normalize_source_url, normalize_text, texts_are_similar


SOURCE_SITE_HOST = (getattr(settings, "SOURCE_SITE_HOST", "www.ebanglalibrary.com") or "www.ebanglalibrary.com").strip().lower()
SOURCE_SITE_FALLBACK_HOSTS = tuple(
    host.strip().lower()
    for host in (getattr(settings, "SOURCE_SITE_FALLBACK_HOSTS", []) or [])
    if str(host).strip()
)
CATALOG_URL = f"https://{SOURCE_SITE_HOST}/books/"
ARCHIVE_MAX_PAGES = 80
SEARCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    )
}
SOURCE_SITE_DNS_RESOLVERS = tuple(
    str(resolver).strip()
    for resolver in (getattr(settings, "SOURCE_SITE_DNS_RESOLVERS", None) or ("1.1.1.1", "8.8.8.8"))
    if str(resolver).strip()
)


@dataclass
class ResolutionResult:
    status: str
    confidence: float
    resolved_url: str
    candidates: list
    raw: dict


def source_request_hosts(host=""):
    candidates = [
        str(host or "").strip().lower(),
        SOURCE_SITE_HOST,
        *SOURCE_SITE_FALLBACK_HOSTS,
        "www.ebanglalibrary.com",
        "ebanglalibrary.com",
    ]
    ordered = []
    seen = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        ordered.append(candidate)
    return tuple(ordered)


def replace_url_host(url, host):
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.path:
        return url
    return parsed._replace(netloc=host).geturl()


def is_name_resolution_failure(exc):
    return "name resolution" in str(exc).lower() or "gaierror" in str(exc).lower()


def collect_system_dns_ips(host):
    ips = []
    try:
        addr_info = socket.getaddrinfo(host, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except OSError:
        return ips

    seen = set()
    for family, _socktype, _proto, _canon, sockaddr in addr_info:
        if family not in (socket.AF_INET, socket.AF_INET6) or not sockaddr:
            continue
        candidate = str(sockaddr[0]).strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        ips.append(candidate)
    return ips


def encode_dns_name(name):
    labels = [label for label in name.split(".") if label]
    wire = b""
    for label in labels:
        encoded = label.encode("idna")
        wire += bytes((len(encoded),)) + encoded
    return wire + b"\x00"


def skip_dns_name(packet, offset):
    while offset < len(packet):
        length = packet[offset]
        if length == 0:
            return offset + 1
        if (length & 0xC0) == 0xC0:
            return offset + 2
        offset += 1 + length
    return offset


def resolve_a_records_via_udp(host, resolver, timeout=3):
    transaction_id = randint(0, 0xFFFF)
    header = struct.pack("!HHHHHH", transaction_id, 0x0100, 1, 0, 0, 0)
    question = encode_dns_name(host) + struct.pack("!HH", 1, 1)
    query = header + question

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        sock.sendto(query, (resolver, 53))
        packet, _ = sock.recvfrom(2048)

    if len(packet) < 12:
        return []

    resp_tx_id, _flags, qdcount, ancount, _nscount, _arcount = struct.unpack("!HHHHHH", packet[:12])
    if resp_tx_id != transaction_id:
        return []

    offset = 12
    for _ in range(qdcount):
        offset = skip_dns_name(packet, offset)
        offset += 4

    ips = []
    seen = set()
    for _ in range(ancount):
        offset = skip_dns_name(packet, offset)
        if offset + 10 > len(packet):
            break

        rtype, _rclass, _ttl, rdlength = struct.unpack("!HHIH", packet[offset : offset + 10])
        offset += 10
        if offset + rdlength > len(packet):
            break

        rdata = packet[offset : offset + rdlength]
        offset += rdlength

        if rtype != 1 or rdlength != 4:
            continue
        try:
            ip_value = socket.inet_ntoa(rdata)
            ip_address(ip_value)
        except ValueError:
            continue

        if ip_value in seen:
            continue
        seen.add(ip_value)
        ips.append(ip_value)

    return ips


def resolve_a_records_via_doh(host, timeout=5):
    try:
        response = requests.get(
            "https://1.1.1.1/dns-query",
            params={"name": host, "type": "A"},
            headers={
                "Accept": "application/dns-json",
                "Host": "cloudflare-dns.com",
                "User-Agent": SEARCH_HEADERS["User-Agent"],
            },
            timeout=timeout,
            verify=False,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception:
        return []

    answers = payload.get("Answer", []) if isinstance(payload, dict) else []
    ips = []
    seen = set()
    for answer in answers:
        if not isinstance(answer, dict) or answer.get("type") != 1:
            continue
        value = str(answer.get("data", "")).strip()
        if not value:
            continue
        try:
            ip_address(value)
        except ValueError:
            continue
        if value in seen:
            continue
        seen.add(value)
        ips.append(value)

    return ips


def resolve_host_with_dns_fallback(host):
    collected = []
    seen = set()

    for candidate in collect_system_dns_ips(host):
        if candidate in seen:
            continue
        seen.add(candidate)
        collected.append(candidate)

    for resolver in SOURCE_SITE_DNS_RESOLVERS:
        try:
            udp_ips = resolve_a_records_via_udp(host, resolver)
        except Exception:
            udp_ips = []
        for candidate in udp_ips:
            if candidate in seen:
                continue
            seen.add(candidate)
            collected.append(candidate)

    if collected:
        return collected

    for candidate in resolve_a_records_via_doh(host):
        if candidate in seen:
            continue
        seen.add(candidate)
        collected.append(candidate)

    return collected


def build_response_from_urllib3(url, method, headers, raw_response):
    response = requests.Response()
    response.status_code = raw_response.status
    response.headers = CaseInsensitiveDict(raw_response.headers)
    response._content = raw_response.data
    response.url = url
    response.reason = getattr(raw_response, "reason", "")
    response.encoding = requests.utils.get_encoding_from_headers(response.headers)
    response.request = requests.Request(method=method, url=url, headers=headers).prepare()
    return response


def get_via_direct_ip_https(session, url, host, ip, **kwargs):
    parsed = urlparse(url)
    if parsed.scheme.lower() != "https":
        raise requests.exceptions.ConnectionError(f"Direct-IP fallback requires HTTPS URL: {url}")

    params = kwargs.get("params")
    timeout = kwargs.get("timeout", 30)
    method = kwargs.get("method", "GET").upper()
    allow_redirects = kwargs.get("allow_redirects", True)
    provided_headers = kwargs.get("headers") or {}

    base_path = parsed.path or "/"
    query = parsed.query
    if params:
        params_query = urlencode(params, doseq=True)
        if params_query:
            query = f"{query}&{params_query}" if query else params_query
    request_target = f"{base_path}?{query}" if query else base_path

    merged_headers = {}
    merged_headers.update(getattr(session, "headers", {}) or {})
    merged_headers.update(provided_headers)
    merged_headers["Host"] = host

    pool = urllib3.HTTPSConnectionPool(
        host=ip,
        port=parsed.port or 443,
        assert_hostname=host,
        server_hostname=host,
        cert_reqs="CERT_REQUIRED",
        ca_certs=requests.certs.where(),
        retries=False,
        timeout=timeout,
    )
    raw_response = pool.request(method, request_target, headers=merged_headers, redirect=allow_redirects)
    return build_response_from_urllib3(url, method, merged_headers, raw_response)


def get_with_host_fallback(session, url, **kwargs):
    parsed = urlparse(url)
    candidate_hosts = source_request_hosts(parsed.netloc)
    candidate_urls = [replace_url_host(url, host) for host in candidate_hosts]
    fallback_errors = []

    for candidate_url in candidate_urls:
        try:
            return session.get(candidate_url, **kwargs)
        except requests.exceptions.ConnectionError as exc:
            if not is_name_resolution_failure(exc):
                raise
            fallback_errors.append(exc)

    direct_ip_errors = []
    for host in candidate_hosts:
        candidate_url = replace_url_host(url, host)
        for resolved_ip in resolve_host_with_dns_fallback(host):
            try:
                return get_via_direct_ip_https(session, candidate_url, host, resolved_ip, **kwargs)
            except requests.exceptions.RequestException as exc:
                direct_ip_errors.append(exc)

    if direct_ip_errors:
        raise direct_ip_errors[-1]
    if fallback_errors:
        raise fallback_errors[-1]
    return session.get(url, **kwargs)


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
    response = get_with_host_fallback(session, normalized_url, timeout=30)
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
            response = get_with_host_fallback(
                self.session,
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

            page_added_count = 0
            for entry in page_entries:
                if entry["source_url"] in seen:
                    continue
                seen.add(entry["source_url"])
                _, created = SourceCatalogEntry.objects.update_or_create(
                    source_url=entry["source_url"],
                    defaults=entry,
                )
                if created:
                    refreshed.append(entry)
                    page_added_count += 1

            if page_added_count == 0:
                break

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
