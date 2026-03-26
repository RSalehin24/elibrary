import re
from html import escape

from bs4 import BeautifulSoup

from apps.catalog.models import ContributorRole
from apps.catalog.services import normalize_book_contributors
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

DEDICATION_PATTERNS = [
    "উৎসর্গ",
    "অনুবাদকের উৎসর্গ",
    "লেখকের উৎসর্গ",
    "dedication",
]

DEDICATION_INLINE_PREFIX_PATTERN = re.compile(
    r"^\s*(?:অনুবাদকের\s+উৎসর্গ|লেখকের\s+উৎসর্গ|উৎসর্গ|dedication)\s*[:ঃ\-–—]?\s*",
    re.IGNORECASE,
)

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

FRONT_SECTION_HEADING_PATTERNS = [
    "ভূমিকা",
    "প্রস্তাবনা",
    "লেখকের কথা",
    "অনুবাদকের কথা",
    "প্রকাশকের কথা",
    "সহস্রাব্দ সংস্করণের কথা",
    "প্রারম্ভ কথন",
    "প্রারম্ভকথন",
    "কথন",
    "foreword",
    "introduction",
    "preface",
]

SEPARATOR_PARAGRAPH_VALUES = {".", "।", "..", "..."}
BLOCK_TAG_NAMES = ("h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote")
HEADING_TAG_NAMES = {"h1", "h2", "h3", "h4", "h5", "h6"}
MAX_METADATA_TEXT_LENGTH = 320
MAX_METADATA_VALUE_LENGTH = 180
MAX_TITLE_PREFIX_LENGTH = 140
MAX_DEDICATION_BLOCK_LENGTH = 220
DATE_LINE_PATTERN = re.compile(
    r"^(?:[০-৯]{1,2}|[0-9]{1,2})\s+(?:জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর|january|february|march|april|may|june|july|august|september|october|november|december)\s*,?\s*(?:[০-৯]{4}|[0-9]{4})$",
    re.IGNORECASE,
)
LETTER_SALUTATION_PATTERN = re.compile(r"^(?:প্রিয়|শ্রদ্ধেয়|dear)\b", re.IGNORECASE)
LETTER_EXCERPT_PATTERNS = [
    "চিঠি",
    "চিঠির",
    "চিঠিতে",
    "পাঠানো চিঠি",
    "letter",
]
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


def block_text_lines(block):
    return [
        clean_display_text(line)
        for line in block.get_text("\n", strip=True).splitlines()
        if clean_display_text(line)
    ]


def block_strong_text_lines(block):
    lines = []
    for strong in block.find_all("strong"):
        lines.extend(
            clean_display_text(line)
            for line in strong.get_text("\n", strip=True).splitlines()
            if clean_display_text(line)
        )
    return lines


def join_heading_lines(lines):
    cleaned_lines = [clean_display_text(line) for line in lines if clean_display_text(line)]
    if not cleaned_lines:
        return ""
    if len(cleaned_lines) == 1:
        return cleaned_lines[0]
    return "\n".join(cleaned_lines)


def heading_plain_text(text):
    if not text:
        return ""
    return clean_display_text(str(text).replace("\n", " "))


def block_strong_heading_text(block):
    strong_lines = block_strong_text_lines(block)
    if not strong_lines:
        return ""

    text_lines = block_text_lines(block)
    if not text_lines:
        return ""

    if normalize_catalog_text(" ".join(strong_lines)) != normalize_catalog_text(" ".join(text_lines)):
        return ""

    return join_heading_lines(strong_lines)


def is_likely_section_title_text(text):
    plain_text = heading_plain_text(text)
    if not plain_text or len(plain_text) > 180:
        return False
    if text_matches_patterns(plain_text, DEDICATION_PATTERNS + BODY_SECTION_PATTERNS):
        return False
    if search_front_matter_label_value(plain_text, strong_text=plain_text, has_break="\n" in str(text)):
        return False
    if looks_like_letter_excerpt_marker(plain_text):
        return False
    if len(plain_text.split()) > 18:
        return False
    return count_sentence_markers(plain_text) <= 1


def is_non_dedication_strong_heading(text, strong_text="", tag_name=""):
    if tag_name in HEADING_TAG_NAMES:
        return False

    cleaned_text = clean_display_text(text)
    cleaned_strong = clean_display_text(strong_text)
    if not cleaned_text or not cleaned_strong or cleaned_text != cleaned_strong:
        return False
    if is_dedication_heading(cleaned_text, strong_text=strong_text, tag_name=tag_name):
        return False
    return is_likely_section_title_text(cleaned_strong)


def resolve_front_section_title(block):
    text = block_text(block)
    if is_front_section_heading(text, tag_name=block.name):
        return text

    strong_heading = block_strong_heading_text(block)
    if strong_heading and is_likely_section_title_text(strong_heading):
        return strong_heading

    return ""


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


def is_plausible_metadata_value(entry, value):
    cleaned_value = clean_display_text(value)
    if not cleaned_value:
        return False

    if entry["role"]:
        return bool(split_contributor_value(cleaned_value))

    sentence_markers = count_sentence_markers(cleaned_value)
    if sentence_markers > 1:
        return False
    if sentence_markers == 1 and len(cleaned_value.split()) > 6:
        return False
    if text_matches_patterns(cleaned_value, BODY_SECTION_PATTERNS) and len(cleaned_value) <= 80:
        return False
    return True


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
            start_index = match.start()
            end_index = start_index + len(alias)
            if start_index > 0 and re.match(r"[A-Za-z0-9_\u0980-\u09FF]", cleaned_text[start_index - 1]):
                continue
            if end_index < len(cleaned_text) and re.match(r"[A-Za-z0-9_\u0980-\u09FF]", cleaned_text[end_index]):
                continue

            prefix = cleaned_text[: match.start()]
            cleaned_prefix = clean_display_text(prefix.strip(" -–—|/"))
            value = clean_display_text(match.group("value").strip(" -:ঃ"))
            if not value or len(value) > MAX_METADATA_VALUE_LENGTH or not is_plausible_metadata_value(entry, value):
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
    if is_non_dedication_strong_heading(cleaned_text, strong_text=strong_text, tag_name=tag_name):
        return False
    if tag_name in HEADING_TAG_NAMES and not is_dedication_heading(
        cleaned_text,
        strong_text=strong_text,
        tag_name=tag_name,
    ):
        return False
    if search_front_matter_label_value(cleaned_text, strong_text=strong_text, has_break=False):
        return False
    if is_dedication_heading(cleaned_text, strong_text=strong_text, tag_name=tag_name):
        return False
    if looks_like_letter_excerpt_marker(cleaned_text):
        return False
    if len(cleaned_text) > MAX_DEDICATION_BLOCK_LENGTH:
        return False
    return count_sentence_markers(cleaned_text) <= 3


def looks_like_letter_excerpt_marker(text):
    cleaned_text = clean_display_text(text)
    if not cleaned_text:
        return False
    normalized = normalize_catalog_text(cleaned_text)

    if DATE_LINE_PATTERN.fullmatch(cleaned_text):
        return True
    if LETTER_SALUTATION_PATTERN.match(cleaned_text):
        return True
    for pattern in LETTER_EXCERPT_PATTERNS:
        if normalize_catalog_text(pattern) in normalized:
            return True
    return False


def is_front_section_heading(text, tag_name=""):
    cleaned_text = clean_display_text(text)
    if not cleaned_text or len(cleaned_text) > 140:
        return False
    if not text_matches_patterns(cleaned_text, FRONT_SECTION_HEADING_PATTERNS):
        return False
    normalized = normalize_catalog_text(cleaned_text)
    if re.search(r"(অধ্যা|পর্ব|chapter)", normalized):
        return False
    return tag_name in HEADING_TAG_NAMES or len(cleaned_text.split()) <= 8


def split_leading_front_sections(main_content_html):
    if not main_content_html:
        return [], main_content_html

    soup = BeautifulSoup(main_content_html, "html.parser")
    sections = []
    current_section = None
    extraction_started = False

    for block in list(soup.find_all(BLOCK_TAG_NAMES)):
        if block.parent is None:
            continue

        text = block_text(block)
        if not text:
            continue

        strong_text = block_strong_text(block)
        has_break = block_has_break(block)

        section_title = resolve_front_section_title(block)
        if section_title:
            extraction_started = True
            if current_section and plain_text_from_html("\n".join(current_section["html_parts"])):
                sections.append(
                    {
                        "title": current_section["title"],
                        "html": "\n".join(current_section["html_parts"]),
                    }
                )
            current_section = {"title": section_title, "html_parts": []}
            block.decompose()
            continue

        if not extraction_started:
            continue

        if is_separator_paragraph(text):
            block.decompose()
            continue

        if is_dedication_heading(text, strong_text=strong_text, tag_name=block.name):
            break
        if search_front_matter_label_value(text, strong_text=strong_text, has_break=has_break):
            break
        if is_body_section_marker(text, tag_name=block.name):
            break
        if block.name in HEADING_TAG_NAMES and not is_front_section_heading(text, tag_name=block.name):
            break

        if current_section is None:
            break

        current_section["html_parts"].append(str(block))
        block.decompose()

    if current_section and plain_text_from_html("\n".join(current_section["html_parts"])):
        sections.append(
            {
                "title": current_section["title"],
                "html": "\n".join(current_section["html_parts"]),
            }
        )

    return sections, str(soup)


def strip_leading_dedication_label(text):
    cleaned_text = clean_display_text(text)
    if not cleaned_text:
        return ""
    stripped = DEDICATION_INLINE_PREFIX_PATTERN.sub("", cleaned_text, count=1)
    return clean_display_text(stripped)


def lines_to_paragraphs_html(lines):
    cleaned_lines = [clean_display_text(line) for line in lines if clean_display_text(line)]
    if not cleaned_lines:
        return ""
    return "".join(f"<p>{escape(line)}</p>" for line in cleaned_lines)


def split_block_on_inline_dedication(block):
    if block.name not in {"p", "li", "blockquote"}:
        return None

    raw_text = block.get_text("\n", strip=True)
    if not raw_text:
        return None

    lines = [clean_display_text(line) for line in raw_text.splitlines() if clean_display_text(line)]
    if not lines:
        return None

    dedication_index = -1
    for index, line in enumerate(lines):
        if DEDICATION_INLINE_PREFIX_PATTERN.match(line):
            dedication_index = index
            break

    if dedication_index < 0:
        return None

    before_lines = lines[:dedication_index]
    dedication_lines = []

    first_dedication_line = strip_leading_dedication_label(lines[dedication_index])
    if first_dedication_line:
        dedication_lines.append(first_dedication_line)

    dedication_lines.extend(lines[dedication_index + 1 :])

    return {
        "before_html": lines_to_paragraphs_html(before_lines),
        "dedication_html": lines_to_paragraphs_html(dedication_lines),
    }


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
            if is_separator_paragraph(text):
                in_dedication = False
                block.decompose()
                continue
            if should_continue_dedication_block(text, strong_text=strong_text, tag_name=block.name):
                dedication_parts.append(str(block))
                block.decompose()
                continue
            in_dedication = False

        inline_dedication_split = split_block_on_inline_dedication(block)
        if inline_dedication_split is not None:
            before_html = inline_dedication_split["before_html"]
            dedication_html = inline_dedication_split["dedication_html"]

            if before_html:
                replacement_soup = BeautifulSoup(before_html, "html.parser")
                block.clear()
                for child in list(replacement_soup.contents):
                    block.append(child)
            else:
                block.decompose()

            if dedication_html:
                dedication_parts.append(dedication_html)

            in_dedication = True
            continue

        metadata_candidate = search_front_matter_label_value(text, strong_text=strong_text, has_break=has_break)
        if metadata_candidate:
            book_info_parts.append(str(block))
            block.decompose()
            continue

        if is_dedication_heading(text, strong_text=strong_text, tag_name=block.name):
            block.decompose()
            in_dedication = True
            continue

        if is_separator_paragraph(text) and (book_info_parts or dedication_parts):
            block.decompose()

    return "\n".join(book_info_parts), clean_extracted_dedication_html("\n".join(dedication_parts)), str(soup)


def clean_extracted_dedication_html(dedication_html):
    if not dedication_html:
        return ""

    soup = BeautifulSoup(dedication_html, "html.parser")
    seen_heading = False

    for block in list(soup.find_all(BLOCK_TAG_NAMES)):
        if block.parent is None:
            continue

        text = block_text(block)
        if not text:
            block.decompose()
            continue

        strong_text = block_strong_text(block)
        is_heading = is_dedication_heading(text, strong_text=strong_text, tag_name=block.name)
        if is_heading:
            inline_dedication_text = strip_leading_dedication_label(text)
            if inline_dedication_text and inline_dedication_text != clean_display_text(text):
                block.clear()
                block.append(inline_dedication_text)
                text = block_text(block)
                strong_text = block_strong_text(block)
                is_heading = is_dedication_heading(text, strong_text=strong_text, tag_name=block.name)
        is_duplicate_heading = seen_heading and text_matches_patterns(text, DEDICATION_PATTERNS) and len(text) <= 40

        if is_separator_paragraph(text) or is_heading or is_duplicate_heading:
            seen_heading = seen_heading or is_heading
            block.decompose()
            continue

        break

    cleaned_html = str(soup).strip()
    return cleaned_html if plain_text_from_html(cleaned_html) else ""


def extract_dedication_title_and_content(dedication_html, default_title="উৎসর্গ"):
    cleaned_html = clean_extracted_dedication_html(dedication_html)
    if not cleaned_html:
        return default_title, ""

    soup = BeautifulSoup(cleaned_html, "html.parser")
    blocks = [
        block
        for block in soup.find_all(BLOCK_TAG_NAMES)
        if block.parent is not None and block_text(block)
    ]

    title = default_title
    if blocks:
        first_block = blocks[0]
        first_text = block_text(first_block)
        first_strong = block_strong_text(first_block)
        likely_title = (
            len(first_text) <= 90
            and count_sentence_markers(first_text) <= 1
            and not text_matches_patterns(first_text, BODY_SECTION_PATTERNS)
            and not search_front_matter_label_value(
                first_text,
                strong_text=first_strong,
                has_break=block_has_break(first_block),
            )
        )
        if likely_title:
            title = first_text
            if len(blocks) > 1:
                first_block.decompose()

    content_html = str(soup).strip()
    if not plain_text_from_html(content_html):
        content_html = cleaned_html

    return title, content_html


def resolve_dedication_heading(dedication_html, default_title="উৎসর্গ"):
    plain_text = plain_text_from_html(dedication_html)
    lines = [clean_display_text(line) for line in plain_text.splitlines() if clean_display_text(line)]
    if not lines:
        return default_title

    first_line = lines[0]
    if re.match(r"^dedication(?:\b|\s)", first_line, re.IGNORECASE):
        return "Dedication"

    return default_title


def normalize_dedication_heading_and_content(dedication_html, default_title="উৎসর্গ"):
    heading = resolve_dedication_heading(dedication_html, default_title=default_title)
    cleaned_html = clean_extracted_dedication_html(dedication_html)
    return heading, cleaned_html


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
        for name in split_contributor_value(entry["value"]):
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
