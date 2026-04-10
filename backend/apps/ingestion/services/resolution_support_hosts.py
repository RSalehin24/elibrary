from urllib.parse import urlparse

from django.conf import settings


SOURCE_SITE_HOST = (
    getattr(settings, "SOURCE_SITE_HOST", "www.ebanglalibrary.com")
    or "www.ebanglalibrary.com"
).strip().lower()
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
    for resolver in (
        getattr(settings, "SOURCE_SITE_DNS_RESOLVERS", None)
        or ("1.1.1.1", "8.8.8.8")
    )
    if str(resolver).strip()
)


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

