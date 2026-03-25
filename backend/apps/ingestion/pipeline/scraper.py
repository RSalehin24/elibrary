import requests
from requests.adapters import HTTPAdapter
from urllib.parse import urlparse, urlunparse
from urllib3.util.retry import Retry
import time
import json
import re
import os
import shutil
import unicodedata
from pathlib import Path
from bs4 import BeautifulSoup

from apps.ingestion.services.normalization import extract_main_content_segments

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
        allowed_methods=["HEAD", "GET", "OPTIONS"]
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
        except requests.exceptions.SSLError as e:
            print(f"SSL Error (attempt {attempt + 1}/{max_retries}): {e}")
            if attempt < max_retries - 1:
                wait_time = (attempt + 1) * 5
                print(f"Waiting {wait_time}s before retry...")
                time.sleep(wait_time)
        except requests.exceptions.RequestException as e:
            print(f"Request error (attempt {attempt + 1}/{max_retries}): {e}")
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

def normalize_text(text):
    """
    Normalize text for comparison by removing all symbols and punctuation.
    Only keeps letters, numbers, combining marks, and spaces for matching.
    This allows matching text regardless of punctuation differences.
    """
    if not text:
        return ""
    
    # Unicode normalization - handles invisible characters and different Unicode representations
    text = unicodedata.normalize('NFKC', text)
    
    # Convert to lowercase
    text = text.lower()

    normalized = []
    for char in text:
        if char.isspace():
            normalized.append(" ")
            continue
        category = unicodedata.category(char)
        if category.startswith(("L", "N", "M")):
            normalized.append(char)

    text = "".join(normalized)
    return re.sub(r'\s+', ' ', text).strip()

def normalize_bengali_numbers(text):
    """
    Convert Bengali word numbers to digit format and vice versa for comparison.
    Returns a list of possible normalized versions.
    """
    if not text:
        return [""]
    
    # Bengali word to digit mappings
    word_to_digit = {
        'প্রথম': '১ম', 'প্রথম': '1ম',
        'দ্বিতীয়': '২য়', 'দ্বিতীয়': '2য়',
        'তৃতীয়': '৩য়', 'তৃতীয়': '3য়',
        'চতুর্থ': '৪র্থ', 'চতুর্থ': '4র্থ',
        'পঞ্চম': '৫ম', 'পঞ্চম': '5ম',
        'ষষ্ঠ': '৬ষ্ঠ', 'ষষ্ঠ': '6ষ্ঠ',
        'সপ্তম': '৭ম', 'সপ্তম': '7ম',
        'অষ্টম': '৮ম', 'অষ্টম': '8ম',
        'নবম': '৯ম', 'নবম': '9ম',
        'দশম': '১০ম', 'দশম': '10ম',
    }
    
    # Bengali digit to English digit mappings
    bengali_to_english = {
        '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
        '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
    }
    
    normalized = normalize_text(text)
    versions = [normalized]
    
    # Create version with English digits
    english_version = normalized
    for bn, en in bengali_to_english.items():
        english_version = english_version.replace(bn, en)
    if english_version != normalized:
        versions.append(english_version)
    
    # Create versions with word numbers replaced
    for word, digit in word_to_digit.items():
        word_norm = normalize_text(word)
        digit_norm = normalize_text(digit)
        if word_norm in normalized:
            versions.append(normalized.replace(word_norm, digit_norm))
    
    return versions

def extract_core_title(text):
    """
    Extract the core title by removing common prefixes/suffixes like author info.
    Common patterns:
    - "Title – Author"
    - "Title। লেখক- Author"
    - "Title - লেখক : Author"
    """
    if not text:
        return ""
    
    normalized = normalize_text(text)
    
    # Common words that indicate author/translator info follows
    author_indicators = [
        'লখক', 'অনবদক', 'সমপদক', 'রপনতর', 'মল',  # normalized forms
        'অনবদ', 'রচন', 'সকলন'
    ]
    
    # Split by common separators and take the first meaningful part
    # after normalization these become spaces
    parts = normalized.split()
    
    # Find where author info starts
    core_parts = []
    for i, part in enumerate(parts):
        is_author_indicator = any(ind in part for ind in author_indicators)
        if is_author_indicator and i > 0:
            # Found author indicator, stop here
            break
        core_parts.append(part)
    
    return ' '.join(core_parts)

def texts_are_similar(text1, text2, debug=False):
    """
    Check if two texts are similar enough to be considered duplicates.
    Uses normalized comparison that ignores all punctuation and symbols.
    Also handles cases where one text has extra words like 'লেখক' (author).
    Handles Bengali number variations (প্রথম vs ১ম).
    """
    norm1 = normalize_text(text1)
    norm2 = normalize_text(text2)
    
    if debug:
        print(f"  Comparing:")
        print(f"    Original 1: '{text1}'")
        print(f"    Original 2: '{text2}'")
        print(f"    Normalized 1: '{norm1}'")
        print(f"    Normalized 2: '{norm2}'")
    
    # Exact match after normalization
    if norm1 == norm2:
        if debug:
            print(f"    Result: EXACT MATCH")
        return True
    
    # Check if one contains the other (for cases where one might have extra info)
    # But only if they're reasonably long to avoid false positives
    if len(norm1) > 10 and len(norm2) > 10:
        if norm1 in norm2 or norm2 in norm1:
            if debug:
                print(f"    Result: SUBSTRING MATCH")
            return True
    
    # Extract core titles (without author info) and compare
    core1 = extract_core_title(text1)
    core2 = extract_core_title(text2)
    
    if core1 and core2 and len(core1) > 5 and len(core2) > 5:
        if core1 == core2:
            if debug:
                print(f"    Result: CORE TITLE MATCH ('{core1}' == '{core2}')")
            return True
        if core1 in core2 or core2 in core1:
            if debug:
                print(f"    Result: CORE TITLE SUBSTRING MATCH")
            return True
    
    # Check with Bengali number normalization
    versions1 = normalize_bengali_numbers(text1)
    versions2 = normalize_bengali_numbers(text2)
    
    for v1 in versions1:
        for v2 in versions2:
            if v1 == v2:
                if debug:
                    print(f"    Result: NUMBER-NORMALIZED MATCH")
                return True
            if len(v1) > 10 and len(v2) > 10:
                if v1 in v2 or v2 in v1:
                    if debug:
                        print(f"    Result: NUMBER-NORMALIZED SUBSTRING MATCH")
                    return True
    
    # Special handling: Remove common prefix words like 'লখক' (lekkhok = author)
    # that might appear in one version but not the other
    common_prefixes = ['লখক', 'অনবদক', 'সমপদক', 'মল']  # author, translator, editor, original
    
    for prefix in common_prefixes:
        # Try removing the prefix from norm1
        if prefix in norm1:
            norm1_without = norm1.replace(prefix, '').strip()
            norm1_without = re.sub(r'\s+', ' ', norm1_without)
            if norm1_without == norm2 or (len(norm1_without) > 10 and norm1_without in norm2):
                if debug:
                    print(f"    Result: MATCH (after removing '{prefix}' from text1)")
                return True
        
        # Try removing the prefix from norm2
        if prefix in norm2:
            norm2_without = norm2.replace(prefix, '').strip()
            norm2_without = re.sub(r'\s+', ' ', norm2_without)
            if norm2_without == norm1 or (len(norm2_without) > 10 and norm2_without in norm1):
                if debug:
                    print(f"    Result: MATCH (after removing '{prefix}' from text2)")
                return True
    
    if debug:
        print(f"    Result: NO MATCH")
    return False

def remove_redundant_headers(html_content, title, debug=False):
    """
    Remove redundant headers that match the title (with fuzzy matching that ignores symbols).
    Checks h1-h6 tags and <p><strong> combinations.
    Also removes duplicate section headers like "প্রথম খণ্ড" when title contains "১ম খণ্ড".
    Handles cases where content has title with extra info like author name.
    """
    if not html_content:
        return html_content
    
    soup = BeautifulSoup(html_content, "html.parser")
    removed_count = 0
    
    # Mapping of Bengali numerals to their word equivalents for section matching
    section_mappings = {
        'প্রথম': ['১ম', 'প্রথম', '1ম'],
        'দ্বিতীয়': ['২য়', 'দ্বিতীয়', '2য়'],
        'তৃতীয়': ['৩য়', 'তৃতীয়', '3য়'],
        'চতুর্থ': ['৪র্থ', 'চতুর্থ', '4র্থ'],
        'পঞ্চম': ['৫ম', 'পঞ্চম', '5ম'],
        'ষষ্ঠ': ['৬ষ্ঠ', 'ষষ্ঠ', '6ষ্ঠ'],
        'সপ্তম': ['৭ম', 'সপ্তম', '7ম'],
        'অষ্টম': ['৮ম', 'অষ্টম', '8ম'],
        'নবম': ['৯ম', 'নবম', '9ম'],
        'দশম': ['১০ম', 'দশম', '10ম'],
    }
    
    def is_section_duplicate(header_text, lesson_title):
        """
        Check if header_text is a duplicate of a section mentioned in lesson_title.
        E.g., "প্রথম খণ্ড" duplicates "১ম খণ্ড" in title
        """
        if not lesson_title:
            return False
            
        header_normalized = normalize_text(header_text)
        title_normalized = normalize_text(lesson_title)
        
        # Check for "খণ্ড" (section/part) duplicates
        if 'খণড' in header_normalized:  # normalized form of খণ্ড
            # Extract the section number/word from header
            for word, variants in section_mappings.items():
                word_normalized = normalize_text(word)
                if word_normalized in header_normalized:
                    # Check if any variant appears in the title
                    for variant in variants:
                        variant_normalized = normalize_text(variant)
                        if variant_normalized in title_normalized and 'খণড' in title_normalized:
                            return True
        
        return False
    
    def is_title_duplicate(header_text, main_title):
        """
        Check if header_text is a duplicate/variant of the main title.
        Handles cases like:
        - Exact match after normalization
        - One contains the other
        - Same core title with different author info
        - Number format variations (প্রথম vs ১ম)
        """
        if not main_title or not header_text:
            return False
        
        # Use the improved texts_are_similar function
        if texts_are_similar(header_text, main_title, debug=debug):
            return True
        
        # Extract core titles and compare
        header_core = extract_core_title(header_text)
        title_core = extract_core_title(main_title)
        
        if header_core and title_core:
            # Check if cores are similar
            if texts_are_similar(header_core, title_core, debug=False):
                return True
            
            # Check if one core contains the other
            if len(header_core) > 5 and len(title_core) > 5:
                if header_core in title_core or title_core in header_core:
                    return True
        
        return False
    
    # Remove headings that match the title (ignoring symbols)
    if title:
        # First, check all heading tags (h1-h6) - especially early ones
        headings = soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
        
        for heading in headings:
            # Skip headings inside lists
            if heading.find_parent(['ol', 'ul']):
                continue
            
            text = heading.get_text(strip=True)
            if not text:
                continue
            
            # Use the improved title duplicate detection
            if is_title_duplicate(text, title):
                if debug:
                    print(f"  ✓ Removed title duplicate ({heading.name}): '{text}'")
                heading.decompose()
                removed_count += 1
            # Also check for section duplicates
            elif is_section_duplicate(text, title):
                if debug:
                    print(f"  ✓ Removed section duplicate ({heading.name}): '{text}'")
                heading.decompose()
                removed_count += 1
        
        # Second, check <p><strong> combinations
        paragraphs = soup.find_all('p')
        
        for p in paragraphs:
            # Skip paragraphs inside lists
            if p.find_parent(['ol', 'ul']):
                continue
            
            # Check if paragraph has a strong tag as direct child or main content
            strong_tags = p.find_all('strong', recursive=False)
            if not strong_tags:
                # Check all strong tags within the paragraph
                strong_tags = p.find_all('strong')
            
            for strong in strong_tags:
                strong_text = strong.get_text(strip=True)
                if not strong_text:
                    continue
                
                # Get paragraph text to see if it's mostly just the strong tag
                p_text = p.get_text(strip=True)
                
                # Check if strong text matches title
                if is_title_duplicate(strong_text, title):
                    # Also verify paragraph is mostly the strong text (not a longer paragraph mentioning the title)
                    p_text_norm = normalize_text(p_text)
                    strong_text_norm = normalize_text(strong_text)
                    # If paragraph is similar in length to strong text, it's likely a standalone title
                    if len(p_text_norm) < len(strong_text_norm) * 1.5:
                        if debug:
                            print(f"  ✓ Removed title duplicate (p>strong): '{p_text}'")
                        p.decompose()
                        removed_count += 1
                        break
                
                # Check if it's a section duplicate (e.g., "প্রথম খণ্ড" when title has "১ম খণ্ড")
                elif is_section_duplicate(strong_text, title):
                    if debug:
                        print(f"  ✓ Removed section duplicate (p>strong): '{p_text}' (matches section in title '{title}')")
                    p.decompose()
                    removed_count += 1
                    break
    
    if debug and removed_count > 0:
        print(f"  Total removed: {removed_count} redundant headers")
    
    return str(soup)


FRONT_MATTER_LABEL_PATTERNS = [
    "লেখক",
    "অনুবাদ",
    "অনুবাদক",
    "সম্পাদক",
    "সম্পাদ",
    "প্রকাশক",
    "প্রথম প্রকাশ",
    "প্রকাশকাল",
    "মূল",
    "edition",
    "publisher",
    "published",
    "translator",
    "author",
]

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

SEPARATOR_PARAGRAPH_VALUES = {".", "।", "..", "..."}
BLOCK_TAG_NAMES = ("h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote")
HEADING_TAG_NAMES = {"h1", "h2", "h3", "h4", "h5", "h6"}
MAX_METADATA_TEXT_LENGTH = 320
MAX_METADATA_VALUE_LENGTH = 180
MAX_TITLE_PREFIX_LENGTH = 140
MAX_DEDICATION_BLOCK_LENGTH = 220


def clean_front_matter_label(text):
    return (text or "").strip(" :ঃ-–—").strip()


def is_separator_paragraph(text):
    return clean_front_matter_label(text) in SEPARATOR_PARAGRAPH_VALUES


def text_matches_patterns(text, patterns):
    cleaned = clean_front_matter_label(text).lower()
    normalized = normalize_text(text)
    for pattern in patterns:
        pattern_text = clean_front_matter_label(pattern)
        if not pattern_text:
            continue
        if pattern_text.lower() in cleaned:
            return True
        if normalize_text(pattern_text) in normalized:
            return True
    return False


def looks_like_front_matter_label(label):
    normalized = normalize_text(label)
    return any(normalize_text(pattern) in normalized for pattern in FRONT_MATTER_LABEL_PATTERNS)


def count_sentence_markers(text):
    return len(re.findall(r"[।.!?]", text))


def looks_like_title_prefix(prefix):
    cleaned_prefix = clean_front_matter_label(prefix.strip(" -–—|/"))
    if not cleaned_prefix or len(cleaned_prefix) > MAX_TITLE_PREFIX_LENGTH:
        return False
    if ":" in cleaned_prefix or "ঃ" in cleaned_prefix:
        return False
    if text_matches_patterns(cleaned_prefix, FRONT_MATTER_LABEL_PATTERNS + DEDICATION_PATTERNS + BODY_SECTION_PATTERNS):
        return False
    word_count = len(cleaned_prefix.split())
    return any(separator in prefix for separator in ("-", "–", "—")) or (2 <= word_count <= 10 and len(cleaned_prefix) >= 8)


def search_front_matter_label_value(text, strong_text="", has_break=False):
    cleaned_text = clean_front_matter_label(text)
    cleaned_strong = clean_front_matter_label(strong_text)
    if not cleaned_text or len(cleaned_text) > MAX_METADATA_TEXT_LENGTH:
        return None

    best_candidate = None
    normalized_strong = normalize_text(cleaned_strong)

    for label in sorted(FRONT_MATTER_LABEL_PATTERNS, key=len, reverse=True):
        label_normalized = normalize_text(label)
        pattern = re.compile(
            rf"{re.escape(label)}\s*(?:[:ঃ]\s*|[-–—]\s*|\s+)(?P<value>.+)$",
            re.IGNORECASE,
        )
        for match in pattern.finditer(cleaned_text):
            prefix = cleaned_text[: match.start()]
            cleaned_prefix = clean_front_matter_label(prefix.strip(" -–—|/"))
            value = clean_front_matter_label(match.group("value").strip(" -:ঃ"))
            if not value or len(value) > MAX_METADATA_VALUE_LENGTH:
                continue

            score = 0
            if not cleaned_prefix:
                score += 8
            elif looks_like_title_prefix(prefix):
                score += 6
            elif has_break and len(cleaned_prefix) <= 120:
                score += 5
            elif cleaned_strong and cleaned_prefix and clean_front_matter_label(cleaned_strong) == cleaned_prefix:
                score += 4
            elif cleaned_prefix and len(cleaned_prefix) <= 14:
                score += 1
            else:
                score -= 3

            if normalized_strong and label_normalized in normalized_strong:
                score += 3
            if len(value) <= 80:
                score += 1
            if count_sentence_markers(value) <= 1:
                score += 1
            if score < 5:
                continue

            candidate = {
                "label": cleaned_strong if normalized_strong and label_normalized in normalized_strong else label,
                "value": value,
                "score": score,
                "start": match.start(),
            }
            if best_candidate is None or (candidate["score"], -candidate["start"]) > (
                best_candidate["score"],
                -best_candidate["start"],
            ):
                best_candidate = candidate

    return best_candidate


def extract_front_matter_label_value(paragraph):
    text = clean_front_matter_label(paragraph.get_text(" ", strip=True))
    if not text:
        return "", ""

    strong_text = clean_front_matter_label(" ".join(tag.get_text(" ", strip=True) for tag in paragraph.find_all("strong")))
    candidate = search_front_matter_label_value(text, strong_text=strong_text, has_break=paragraph.find("br") is not None)
    if candidate:
        return candidate["label"], candidate["value"]

    return "", ""


def is_dedication_heading(text, strong_text="", tag_name=""):
    heading_text = clean_front_matter_label(strong_text or text)
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
    cleaned_text = clean_front_matter_label(text)
    if not cleaned_text:
        return False
    if text_matches_patterns(cleaned_text, BODY_SECTION_PATTERNS) and len(cleaned_text) <= 80:
        return True
    normalized = normalize_text(cleaned_text)
    if tag_name in HEADING_TAG_NAMES and re.search(r"(অধ্যা|পর্ব|chapter)", normalized):
        return True
    return False


def should_continue_dedication_block(text, strong_text="", tag_name=""):
    cleaned_text = clean_front_matter_label(text)
    if not cleaned_text:
        return True
    if is_separator_paragraph(cleaned_text):
        return True
    if is_body_section_marker(cleaned_text, tag_name=tag_name):
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
    if len(cleaned_text) > MAX_DEDICATION_BLOCK_LENGTH:
        return False
    return count_sentence_markers(cleaned_text) <= 3


def extract_content_sections(html_content):
    if not html_content:
        return "", "", html_content

    soup = BeautifulSoup(html_content, "html.parser")
    book_info_parts = []
    dedication_parts = []
    in_dedication = False

    for block in list(soup.find_all(BLOCK_TAG_NAMES)):
        if block.parent is None:
            continue

        text = clean_front_matter_label(block.get_text(" ", strip=True))
        if not text:
            continue

        strong_text = clean_front_matter_label(" ".join(tag.get_text(" ", strip=True) for tag in block.find_all("strong")))

        if in_dedication:
            if should_continue_dedication_block(text, strong_text=strong_text, tag_name=block.name):
                if not is_separator_paragraph(text):
                    dedication_parts.append(str(block))
                block.decompose()
                continue
            in_dedication = False

        metadata_candidate = search_front_matter_label_value(
            text,
            strong_text=strong_text,
            has_break=block.find("br") is not None,
        )
        if metadata_candidate:
            book_info_parts.append(str(block))
            block.decompose()
            continue

        if is_dedication_heading(text, strong_text=strong_text, tag_name=block.name):
            inline_text = clean_front_matter_label(DEDICATION_INLINE_PREFIX_PATTERN.sub("", text, count=1))
            if inline_text and inline_text != clean_front_matter_label(text):
                dedication_parts.append(f"<p>{inline_text}</p>")
            block.decompose()
            in_dedication = True
            continue

        if is_separator_paragraph(text) and (book_info_parts or dedication_parts):
            block.decompose()

    return "\n".join(book_info_parts), "\n".join(dedication_parts), str(soup)

def extract_dedication(html_content):
    """
    Extract labeled book metadata blocks and explicit dedication sections
    from the main content without depending on a fixed order.
    """
    return extract_main_content_segments(html_content)

def sanitize_folder_name(name):
    name = name.strip()
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = re.sub(r"\s+", "_", name)
    return name

def create_output_folder(book_title):
    base_folder = Path(__file__).resolve().parents[3] / "outputs"
    if not base_folder.exists():
        base_folder.mkdir(parents=True, exist_ok=True)
        print(f"Created base folder: {base_folder}")

    folder_name = sanitize_folder_name(book_title)
    full_path = base_folder / folder_name

    if not full_path.exists():
        full_path.mkdir(parents=True, exist_ok=True)
        print(f"Created folder: {full_path}")
    else:
        print(f"Folder already exists: {full_path}")

    return str(full_path)

def extract_title_and_author(soup):
    title_tag = soup.find("title")
    if not title_tag:
        return "Book Title", ""

    full_title = title_tag.get_text(strip=True)
    for sep in ["–", "-"]:
        if sep in full_title:
            return map(str.strip, full_title.split(sep, 1))
    return full_title, ""

def scrape_book_meta(soup):
    author = series = book_type = ""

    meta = soup.find("div", class_="entry-meta entry-meta-after-content")
    if not meta:
        return author, series, book_type

    def get_text(cls):
        span = meta.find("span", class_=cls)
        if not span:
            return ""
        # Get all <a> tags to handle multiple items
        links = span.find_all("a")
        if links:
            return ", ".join(link.get_text(strip=True) for link in links)
        return ""

    author = get_text("entry-terms-authors")
    series = get_text("entry-terms-series")
    book_type = get_text("entry-terms-ld_course_category")

    return author, series, book_type

def download_cover_image(soup, output_folder):
    figure = soup.find("figure", class_="entry-image-link entry-image-single")
    if not figure:
        return None

    img = figure.find("img")
    img_url = img.get("data-src") or img.get("src") if img else None

    if not img_url:
        source = figure.find("source")
        img_url = source.get("srcset").split()[0] if source else None

    if not img_url:
        return None

    response = requests.get(img_url, headers=HEADERS)
    if response.status_code != 200:
        return None

    ext = ".webp" if ".webp" in img_url else ".jpg"
    filename = f"book_cover{ext}"
    
    with open(os.path.join(output_folder, filename), "wb") as f:
        f.write(response.content)

    return filename

def scrape_main_content(soup):
    div = soup.find("div", class_="ld-tab-content ld-visible entry-content")
    if div:
        div = clean_buttons(div)
        content = div.decode_contents()
        # Remove redundant headers
        content = remove_redundant_headers(content, "")
        return content
    return ""

def get_total_pages(soup):
    pager = soup.find("div", class_="ld-pagination ld-pagination-page-course_content_shortcode")
    if pager and pager.has_attr("data-pager-results"):
        try:
            data = json.loads(pager["data-pager-results"].replace("&quot;", '"'))
            return int(data.get("total_pages", 1))
        except Exception:
            pass
    return 1

def scrape_nested_topics(lesson_item):
    """
    Recursively scrape topics from a lesson item's expanded content.
    Returns a list of (title, url) tuples for topics.
    """
    topics = []
    seen_urls = set()  # Track URLs to avoid duplicates
    
    # Find the expanded container for this lesson
    expand_id = lesson_item.get("data-ld-expand-id")
    if not expand_id:
        return topics
    
    # Find the corresponding expanded container
    expanded_container = lesson_item.find("div", id=f"{expand_id}-container")
    if not expanded_container:
        return topics
    
    # Find all topic items within this container
    topic_items = expanded_container.find_all(
        "div",
        class_=lambda c: c and "ld-table-list-item" in c,
        recursive=True
    )
    
    for topic_item in topic_items:
        # Find the link to the topic
        a = topic_item.find("a", class_=lambda c: c and "ld-table-list-item-preview" in c)
        if not a or not a.get("href"):
            continue
        
        url = a["href"]
        
        # Skip if we've already seen this URL
        if url in seen_urls:
            continue
        seen_urls.add(url)
            
        # Get the topic title
        title_span = a.find("span", class_="ld-topic-title")
        if title_span:
            title = title_span.get_text(strip=True)
            topics.append((title, url))
    
    return topics

def scrape_lesson_list(soup):
    """
    Scrape lessons and their nested topics from the page.
    Returns a list of dictionaries with lesson info and nested topics.
    """
    lessons = []
    
    # Find all lesson items
    lesson_items = soup.find_all(
        "div",
        class_=lambda c: c and "ld-item-lesson-item" in c
    )

    for lesson_item in lesson_items:
        # Find the lesson link
        a = lesson_item.find("a", class_="ld-item-name")
        if not a:
            continue
            
        # Get lesson title
        title_div = a.find("div", class_="ld-item-title")
        if not title_div:
            continue
            
        lesson_title = title_div.get_text(strip=True)
        # Remove the topic count text (e.g., "14 Topics" or "12 Topics" without space)
        lesson_title = re.sub(r'\d+\s*Topics.*$', '', lesson_title, flags=re.IGNORECASE)
        lesson_title = lesson_title.strip()
        
        lesson_url = a.get("href")
        
        # Check if this lesson has nested topics
        topics = scrape_nested_topics(lesson_item)
        
        lesson_data = {
            "title": lesson_title,
            "url": lesson_url,
            "topics": topics,
            "has_topics": len(topics) > 0
        }
        
        lessons.append(lesson_data)

    return lessons

def scrape_all_lessons(book_url):
    """
    Scrape all lessons across all pages.
    Returns a list of lesson dictionaries.
    """
    lessons = []
    page = 1

    while True:
        soup = get_soup(f"{book_url}?ld-courseinfo-lesson-page={page}")
        if not soup:
            break

        lessons.extend(scrape_lesson_list(soup))
        if page >= get_total_pages(soup):
            break

        page += 1
        time.sleep(1)

    return lessons

def scrape_lesson_content(url, title=""):
    """Scrape content from a lesson or topic URL."""
    soup = get_soup(url)
    if not soup:
        return ""

    div = soup.find("div", class_="ld-tab-content ld-visible entry-content")
    if div:
        div = clean_buttons(div)
        content = div.decode_contents()
        # Remove redundant headers (debug=True to see what's happening)
        content = remove_redundant_headers(content, title, debug=True)
        return content
    return ""

def build_toc_structure(lessons_data):
    """
    Build a hierarchical table of contents structure.
    Returns a list representing the TOC.
    """
    toc = []
    
    for lesson in lessons_data:
        lesson_entry = {
            "title": lesson["title"],
            "type": "lesson",
            "has_content": True
        }
        
        if lesson["has_topics"]:
            # This lesson has topics
            lesson_entry["children"] = []
            for topic_title, topic_url in lesson["topics"]:
                lesson_entry["children"].append({
                    "title": topic_title,
                    "type": "topic",
                    "has_content": True
                })
        
        toc.append(lesson_entry)
    
    return toc

def scrape_book_data(book_url):
    book_url = normalize_source_url(book_url)
    soup = get_soup(book_url)
    if not soup:
        print("Failed to fetch the book page.")
        return None

    book_title, title_author = extract_title_and_author(soup)
    meta_author, series, book_type = scrape_book_meta(soup)
    author = meta_author or title_author
    output_folder = create_output_folder(book_title)

    cover = download_cover_image(soup, output_folder)
    main_content = scrape_main_content(soup)
    
    # Extract book info and dedication from main content
    book_info, dedication, main_content = extract_dedication(main_content)

    # Get all lessons with their nested structure
    print("Fetching lesson structure...")
    all_lessons = scrape_all_lessons(book_url)
    
    # Build TOC
    toc = build_toc_structure(all_lessons)
    
    # Scrape content
    content_items = []
    
    for lesson_data in all_lessons:
        if lesson_data["has_topics"]:
            # If lesson has topics, scrape each topic
            print(f"\nLesson: {lesson_data['title']}")
            print(f"  → {len(lesson_data['topics'])} topics")
            
            for topic_title, topic_url in lesson_data["topics"]:
                print(f"  Scraping topic: {topic_title}")
                content = scrape_lesson_content(topic_url, topic_title)
                content_items.append({
                    "title": topic_title,
                    "content": content,
                    "type": "topic",
                    "parent": lesson_data["title"]
                })
                time.sleep(1)
        else:
            # If lesson has no topics, scrape the lesson itself
            print(f"\nScraping lesson: {lesson_data['title']}")
            content = scrape_lesson_content(lesson_data["url"], lesson_data["title"])
            content_items.append({
                "title": lesson_data["title"],
                "content": content,
                "type": "lesson",
                "parent": None
            })
            time.sleep(1)

    return {
        "book_title": book_title,
        "author": author,
        "series": series,
        "book_type": book_type,
        "cover": cover,
        "main_content": main_content,
        "book_info": book_info,  # Extracted book info before dedication
        "dedication": dedication,  # Extracted dedication
        "toc": toc,
        "content_items": content_items,
        "output_folder": output_folder
    }
