import re

from apps.catalog.models import ContributorRole
from apps.common.text import clean_display_text, normalize_catalog_text


ROLE_PATTERNS = {
    ContributorRole.TRANSLATOR: ["অনুবাদ", "অনুবাদক", "translation", "translator"],
    ContributorRole.COMPILER: ["সংকলক", "সংকলন", "compiled by", "compiler"],
    ContributorRole.EDITOR: ["সম্পাদক", "সম্পাদ", "editor"],
    ContributorRole.COVER_ARTIST: ["প্রচ্ছদ", "cover"],
    ContributorRole.ILLUSTRATOR: ["অলংকরণ", "illustration"],
    ContributorRole.PUBLISHER: ["প্রকাশক", "publisher"],
}

FRONT_MATTER_PATTERNS = {
    "first_published": ["প্রথম প্রকাশ", "প্রকাশকাল", "প্রকাশিত", "first published", "published", "publication"],
    "original_title": ["মূল", "original title"],
    "edition": ["সংস্করণ", "edition"],
}

MAX_CONTRIBUTOR_NAME_WORDS = 8
MAX_CONTRIBUTOR_NAME_LENGTH = 80
CONTRIBUTOR_CONNECTOR_PATTERN = re.compile(r"\s+(?:ও|and|&)\s+", re.IGNORECASE)
CONTRIBUTOR_INITIAL_TOKEN_PATTERN = re.compile(r"^(?:[A-Za-z\u0980-\u09FF]{1,4}\.)+$")


def build_metadata_label_aliases():
    aliases = []
    for role, patterns in ROLE_PATTERNS.items():
        for pattern in patterns:
            aliases.append({"alias": clean_display_text(pattern), "key": role, "role": role})
    for key, patterns in FRONT_MATTER_PATTERNS.items():
        for pattern in patterns:
            aliases.append({"alias": clean_display_text(pattern), "key": key, "role": ""})
    return sorted(aliases, key=lambda item: len(item["alias"]), reverse=True)


METADATA_LABEL_ALIASES = build_metadata_label_aliases()
ALL_METADATA_LABELS = [entry["alias"] for entry in METADATA_LABEL_ALIASES]


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


def looks_like_contributor_name(value):
    cleaned = clean_display_text(value.strip(" -:()[]{}"))
    if not cleaned:
        return False
    if re.search(r"[।!?]", cleaned):
        return False
    for token in cleaned.split():
        normalized_token = token.strip("()[]{}\"'“”‘’,;:-")
        if "." not in normalized_token:
            continue
        if CONTRIBUTOR_INITIAL_TOKEN_PATTERN.fullmatch(normalized_token):
            continue
        return False
    if len(cleaned) > MAX_CONTRIBUTOR_NAME_LENGTH:
        return False
    if len(cleaned.split()) > MAX_CONTRIBUTOR_NAME_WORDS:
        return False
    return bool(normalize_catalog_text(cleaned))


def split_contributor_chunks(value):
    chunks = []
    seen = set()

    for chunk in split_multi_value(value):
        expanded = [
            clean_display_text(part.strip(" -:"))
            for part in CONTRIBUTOR_CONNECTOR_PATTERN.split(chunk)
            if clean_display_text(part.strip(" -:"))
        ]
        candidates = expanded if len(expanded) > 1 and all(looks_like_contributor_name(part) for part in expanded) else [chunk]

        for candidate in candidates:
            normalized = normalize_catalog_text(candidate)
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            chunks.append(candidate)

    return chunks


def split_contributor_value(value):
    chunks = split_contributor_chunks(value)
    if not chunks:
        return []
    return [chunk for chunk in chunks if looks_like_contributor_name(chunk)]


def match_pattern_key(label, pattern_map):
    lowered = clean_display_text(label).lower()
    normalized = normalize_catalog_text(label)
    for key, patterns in pattern_map.items():
        if any(pattern in lowered or normalize_catalog_text(pattern) in normalized for pattern in patterns):
            return key
    return ""
