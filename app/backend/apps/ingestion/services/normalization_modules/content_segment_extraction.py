

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
        if text_matches_patterns(text, INLINE_TOC_HEADING_PATTERNS):
            remove_inline_toc_heading_and_lists(block)
            break

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

    if sections:
        strip_leading_probable_toc_lists(soup)

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
