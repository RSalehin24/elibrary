

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
