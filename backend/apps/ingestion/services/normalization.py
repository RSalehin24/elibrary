import re

from bs4 import BeautifulSoup

from apps.catalog.models import ContributorRole
from apps.catalog.services import normalize_book_contributors
from apps.common.text import clean_display_text, normalize_catalog_text


ROLE_PATTERNS = {
    ContributorRole.TRANSLATOR: ["অনুবাদ", "অনুবাদক", "translation", "translator"],
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

DEDICATION_PATTERNS = [
    "উৎসর্গ",
    "অনুবাদকের উৎসর্গ",
    "লেখকের উৎসর্গ",
    "dedication",
]

BODY_SECTION_PATTERNS = [
    "ভূমিকা",
    "প্রস্তাবনা",
    "লেখকের কথা",
    "অনুবাদকের কথা",
    "প্রকাশকের কথা",
    "সূচিপত্র",
    "অধ্যায়",
    "অধ্যায়",
    "পর্ব",
    "chapter",
    "preface",
    "introduction",
]

SEPARATOR_PARAGRAPH_VALUES = {".", "।", "..", "..."}
BLOCK_TAG_NAMES = ("h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote")
HEADING_TAG_NAMES = {"h1", "h2", "h3", "h4", "h5", "h6"}
MAX_METADATA_TEXT_LENGTH = 320
MAX_METADATA_VALUE_LENGTH = 180
MAX_TITLE_PREFIX_LENGTH = 140
MAX_DEDICATION_BLOCK_LENGTH = 220


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


def plain_text_from_html(html):
    if not html:
        return ""
    soup = BeautifulSoup(html, "html.parser")
    return soup.get_text("\n", strip=True)


def count_sentence_markers(text):
    return len(re.findall(r"[।.!?]", text))


def text_matches_patterns(text, patterns):
    lowered = clean_display_text(text).lower()
    normalized = normalize_catalog_text(text)
    for pattern in patterns:
        cleaned_pattern = clean_display_text(pattern)
        if not cleaned_pattern:
            continue
        if cleaned_pattern.lower() in lowered:
            return True
        if normalize_catalog_text(cleaned_pattern) in normalized:
            return True
    return False


def match_pattern_key(label, pattern_map):
    lowered = clean_display_text(label).lower()
    normalized = normalize_catalog_text(label)
    for key, patterns in pattern_map.items():
        if any(pattern in lowered or normalize_catalog_text(pattern) in normalized for pattern in patterns):
            return key
    return ""


def is_separator_paragraph(text):
    return clean_display_text(text).strip(" :ঃ-–—") in SEPARATOR_PARAGRAPH_VALUES


def block_text(block):
    return clean_display_text(block.get_text(" ", strip=True))


def block_strong_text(block):
    return clean_display_text(" ".join(strong.get_text(" ", strip=True) for strong in block.find_all("strong")))


def block_has_break(block):
    return block.find("br") is not None


def looks_like_title_prefix(prefix):
    cleaned_prefix = clean_display_text(prefix.strip(" -–—|/"))
    if not cleaned_prefix or len(cleaned_prefix) > MAX_TITLE_PREFIX_LENGTH:
        return False
    if ":" in cleaned_prefix or "ঃ" in cleaned_prefix:
        return False
    if text_matches_patterns(cleaned_prefix, ALL_METADATA_LABELS + DEDICATION_PATTERNS + BODY_SECTION_PATTERNS):
        return False
    word_count = len(cleaned_prefix.split())
    return any(separator in prefix for separator in ("-", "–", "—")) or (2 <= word_count <= 10 and len(cleaned_prefix) >= 8)


def search_front_matter_label_value(text, strong_text="", has_break=False):
    cleaned_text = clean_display_text(text)
    cleaned_strong = clean_display_text(strong_text)
    if not cleaned_text or len(cleaned_text) > MAX_METADATA_TEXT_LENGTH:
        return None

    best_candidate = None
    normalized_strong = normalize_catalog_text(cleaned_strong)

    for entry in METADATA_LABEL_ALIASES:
        alias = entry["alias"]
        alias_normalized = normalize_catalog_text(alias)
        pattern = re.compile(
            rf"{re.escape(alias)}\s*(?:[:ঃ]\s*|[-–—]\s*|\s+)(?P<value>.+)$",
            re.IGNORECASE,
        )
        for match in pattern.finditer(cleaned_text):
            prefix = cleaned_text[: match.start()]
            cleaned_prefix = clean_display_text(prefix.strip(" -–—|/"))
            value = clean_display_text(match.group("value").strip(" -:ঃ"))
            if not value or len(value) > MAX_METADATA_VALUE_LENGTH:
                continue

            score = 0
            if not cleaned_prefix:
                score += 8
            elif looks_like_title_prefix(prefix):
                score += 6
            elif has_break and len(cleaned_prefix) <= 120:
                score += 5
            elif cleaned_strong and cleaned_prefix and clean_display_text(cleaned_strong) == cleaned_prefix:
                score += 4
            elif cleaned_prefix and len(cleaned_prefix) <= 14:
                score += 1
            else:
                score -= 3

            if normalized_strong and alias_normalized in normalized_strong:
                score += 3
            if len(value) <= 80:
                score += 1
            if count_sentence_markers(value) <= 1:
                score += 1
            if score < 5:
                continue

            label = cleaned_strong if normalized_strong and alias_normalized in normalized_strong else alias
            candidate = {
                "label": clean_display_text(label),
                "value": value,
                "role": entry["role"],
                "key": entry["key"],
                "score": score,
                "start": match.start(),
            }
            if best_candidate is None or (candidate["score"], -candidate["start"]) > (
                best_candidate["score"],
                -best_candidate["start"],
            ):
                best_candidate = candidate

    return best_candidate


def parse_front_matter_line(text, strong_text="", has_break=False):
    candidate = search_front_matter_label_value(text, strong_text=strong_text, has_break=has_break)
    if not candidate:
        return "", ""
    return candidate["label"], candidate["value"]


def is_dedication_heading(text, strong_text="", tag_name=""):
    heading_text = clean_display_text(strong_text or text)
    if not heading_text or len(heading_text) > 120:
        return False
    if text_matches_patterns(heading_text, BODY_SECTION_PATTERNS):
        return False
    if not text_matches_patterns(heading_text, DEDICATION_PATTERNS):
        return False
    if search_front_matter_label_value(text, strong_text=strong_text, has_break=False):
        return False
    return tag_name in HEADING_TAG_NAMES or bool(strong_text) or len(heading_text.split()) <= 5


def is_body_section_marker(text, tag_name=""):
    cleaned_text = clean_display_text(text)
    if not cleaned_text:
        return False
    if text_matches_patterns(cleaned_text, BODY_SECTION_PATTERNS) and len(cleaned_text) <= 80:
        return True
    normalized = normalize_catalog_text(cleaned_text)
    if tag_name in HEADING_TAG_NAMES and re.search(r"(অধ্যা|পর্ব|chapter)", normalized):
        return True
    return False


def should_continue_dedication_block(text, strong_text="", tag_name=""):
    cleaned_text = clean_display_text(text)
    if not cleaned_text:
        return True
    if is_separator_paragraph(cleaned_text):
        return True
    if is_body_section_marker(cleaned_text, tag_name=tag_name):
        return False
    if search_front_matter_label_value(cleaned_text, strong_text=strong_text, has_break=False):
        return False
    if is_dedication_heading(cleaned_text, strong_text=strong_text, tag_name=tag_name):
        return False
    if len(cleaned_text) > MAX_DEDICATION_BLOCK_LENGTH:
        return False
    return count_sentence_markers(cleaned_text) <= 3


def extract_main_content_segments(main_content_html):
    if not main_content_html:
        return "", "", main_content_html

    soup = BeautifulSoup(main_content_html, "html.parser")
    book_info_parts = []
    dedication_parts = []
    in_dedication = False

    for block in list(soup.find_all(BLOCK_TAG_NAMES)):
        if block.parent is None:
            continue

        text = block_text(block)
        if not text:
            continue

        strong_text = block_strong_text(block)
        has_break = block_has_break(block)

        if in_dedication:
            if should_continue_dedication_block(text, strong_text=strong_text, tag_name=block.name):
                if not is_separator_paragraph(text):
                    dedication_parts.append(str(block))
                block.decompose()
                continue
            in_dedication = False

        metadata_candidate = search_front_matter_label_value(text, strong_text=strong_text, has_break=has_break)
        if metadata_candidate:
            book_info_parts.append(str(block))
            block.decompose()
            continue

        if is_dedication_heading(text, strong_text=strong_text, tag_name=block.name):
            dedication_parts.append(str(block))
            block.decompose()
            in_dedication = True
            continue

        if is_separator_paragraph(text) and (book_info_parts or dedication_parts):
            block.decompose()

    return "\n".join(book_info_parts), "\n".join(dedication_parts), str(soup)


def extract_leading_front_matter_html(html):
    extracted_html, _, _ = extract_main_content_segments(html)
    return extracted_html


def promote_leading_front_matter(book_info_html, main_content_html):
    extracted_html, _, cleaned_main_content = extract_main_content_segments(main_content_html)
    if extracted_html:
        if book_info_html:
            book_info_html = f"{book_info_html}\n{extracted_html}"
        else:
            book_info_html = extracted_html
    return book_info_html or "", cleaned_main_content


def combined_front_matter_html(book_info_html, main_content_html=""):
    extracted_html = extract_leading_front_matter_html(main_content_html)
    if book_info_html and extracted_html:
        return f"{book_info_html}\n{extracted_html}"
    return book_info_html or extracted_html or ""


def iter_front_matter_blocks(book_info_html):
    if not book_info_html:
        return []

    soup = BeautifulSoup(book_info_html, "html.parser")
    blocks = soup.find_all(["p", "li", "blockquote"])
    if blocks:
        return blocks

    fallback_blocks = []
    for line in plain_text_from_html(book_info_html).splitlines():
        cleaned = clean_display_text(line)
        if cleaned:
            fallback_blocks.append(cleaned)
    return fallback_blocks


def extract_front_matter_entries(book_info_html):
    entries = []
    seen = set()

    for block in iter_front_matter_blocks(book_info_html):
        if isinstance(block, str):
            label, value = parse_front_matter_line(block)
        else:
            label, value = parse_front_matter_line(
                block_text(block),
                block_strong_text(block),
                has_break=block_has_break(block),
            )

        if not label or not value:
            continue

        role = match_pattern_key(label, ROLE_PATTERNS)
        key = role or match_pattern_key(label, FRONT_MATTER_PATTERNS) or normalize_catalog_text(label).replace(" ", "_")
        dedupe_key = (normalize_catalog_text(label), normalize_catalog_text(value))
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        entries.append(
            {
                "key": key,
                "label": label,
                "value": value,
                "role": role,
            }
        )

    return entries


def extract_role_contributors(book_info_html):
    extracted = []
    for entry in extract_front_matter_entries(book_info_html):
        if not entry["role"]:
            continue
        for name in split_multi_value(entry["value"]):
            extracted.append({"name": name, "role": entry["role"], "raw_value": entry["value"]})
    return extracted


def normalize_scraped_book(book_data):
    front_matter_html = combined_front_matter_html(
        book_data.get("book_info", ""),
        book_data.get("main_content", ""),
    )
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

    for contributor in extract_role_contributors(front_matter_html):
        contributor_key = (contributor["role"], normalize_catalog_text(contributor["name"]))
        if contributor_key in seen_contributors:
            continue
        seen_contributors.add(contributor_key)
        contributors.append(contributor)

    return {
        "title": clean_display_text(book_data.get("book_title", "")),
        "contributors": normalize_book_contributors(contributors),
        "series": split_multi_value(book_data.get("series", "")),
        "categories": split_multi_value(book_data.get("book_type", "")),
        "raw_strings": {
            "author": book_data.get("author", ""),
            "series": book_data.get("series", ""),
            "book_type": book_data.get("book_type", ""),
        },
    }
