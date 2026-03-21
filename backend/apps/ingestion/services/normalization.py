import re

from bs4 import BeautifulSoup

from apps.catalog.models import ContributorRole
from apps.common.text import clean_display_text, normalize_catalog_text


ROLE_PATTERNS = {
    ContributorRole.TRANSLATOR: ["অনুবাদ", "অনুবাদক", "translation", "translator"],
    ContributorRole.EDITOR: ["সম্পাদ", "editor"],
    ContributorRole.COVER_ARTIST: ["প্রচ্ছদ", "cover"],
    ContributorRole.ILLUSTRATOR: ["অলংকরণ", "illustration"],
    ContributorRole.PUBLISHER: ["প্রকাশক", "publisher"],
}


def split_multi_value(value):
    if not value:
        return []
    chunks = re.split(r"[,;|\n]+", value)
    deduped = []
    seen = set()
    for chunk in chunks:
        cleaned = clean_display_text(chunk.strip(" -:"))
        normalized = normalize_catalog_text(cleaned)
        if not cleaned or not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(cleaned)
    return deduped


def plain_text_from_html(html):
    if not html:
        return ""
    soup = BeautifulSoup(html, "html.parser")
    return soup.get_text("\n", strip=True)


def extract_role_contributors(book_info_html):
    extracted = []
    raw_text = plain_text_from_html(book_info_html)
    for line in raw_text.splitlines():
        if ":" not in line:
            continue
        label, value = [part.strip() for part in line.split(":", 1)]
        for role, patterns in ROLE_PATTERNS.items():
            if any(pattern in label.lower() for pattern in patterns):
                for name in split_multi_value(value):
                    extracted.append({"name": name, "role": role, "raw_value": value})
                break
    return extracted


def normalize_scraped_book(book_data):
    contributors = []
    seen_contributors = set()
    for author in split_multi_value(book_data.get("author", "")):
        contributor_key = (ContributorRole.AUTHOR, normalize_catalog_text(author))
        if contributor_key in seen_contributors:
            continue
        seen_contributors.add(contributor_key)
        contributors.append(
            {
                "name": author,
                "role": ContributorRole.AUTHOR,
                "raw_value": book_data.get("author", ""),
            }
        )

    for contributor in extract_role_contributors(book_data.get("book_info", "")):
        contributor_key = (contributor["role"], normalize_catalog_text(contributor["name"]))
        if contributor_key in seen_contributors:
            continue
        seen_contributors.add(contributor_key)
        contributors.append(contributor)

    return {
        "title": clean_display_text(book_data.get("book_title", "")),
        "contributors": contributors,
        "series": split_multi_value(book_data.get("series", "")),
        "categories": split_multi_value(book_data.get("book_type", "")),
        "raw_strings": {
            "author": book_data.get("author", ""),
            "series": book_data.get("series", ""),
            "book_type": book_data.get("book_type", ""),
        },
    }
