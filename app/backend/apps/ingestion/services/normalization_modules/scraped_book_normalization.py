

def extract_dedication_title_and_content(dedication_html, default_title="উৎসর্গ"):
    cleaned_html = dedupe_html_fragment_blocks(
        clean_extracted_dedication_html(dedication_html)
    )
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
    cleaned_html = dedupe_html_fragment_blocks(
        clean_extracted_dedication_html(dedication_html)
    )
    return heading, cleaned_html


def extract_leading_front_matter_html(html):
    extracted_html, _, _ = extract_main_content_segments(html)
    return extracted_html


def promote_leading_front_matter(book_info_html, main_content_html):
    extracted_html, _, cleaned_main_content = extract_main_content_segments(main_content_html)
    book_info_html = merge_front_matter_html_parts(book_info_html, extracted_html)
    return book_info_html or "", cleaned_main_content


def combined_front_matter_html(book_info_html, main_content_html=""):
    extracted_html = extract_leading_front_matter_html(main_content_html)
    return merge_front_matter_html_parts(book_info_html, extracted_html)


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
    block_variants = []

    for block in iter_front_matter_blocks(book_info_html):
        if isinstance(block, str):
            block_variants.append((block, "", False))
            continue

        if block_has_break(block):
            text_lines = block_text_lines(block)
            strong_lines = block_strong_text_lines(block)
            for index, block_line in enumerate(text_lines):
                strong_line = ""
                if len(strong_lines) == len(text_lines):
                    strong_line = strong_lines[index]
                elif len(strong_lines) == 1:
                    strong_line = strong_lines[0]
                block_variants.append((block_line, strong_line, False))
            continue

        block_variants.append(
            (
                block_text(block),
                block_strong_text(block),
                False,
            )
        )

    consumed_indices = set()

    for index, (block_label, strong_text, has_break) in enumerate(block_variants):
        if index in consumed_indices:
            continue

        for fragment in split_metadata_fragments(block_label):
            label, value = parse_front_matter_line(
                fragment,
                strong_text=strong_text,
                has_break=has_break,
            )

            if label and value:
                roles = roles_in_text(label)
                role = roles[0] if roles else ""
                key = (
                    role
                    or match_pattern_key(label, FRONT_MATTER_PATTERNS)
                    or normalize_catalog_text(label).replace(" ", "_")
                )
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
                        "roles": roles,
                    }
                )
                continue

            evidence = extract_contributor_evidence(fragment, raw_value=fragment)
            if not evidence["contributors"]:
                if not is_role_label_text(fragment):
                    continue
                if index + 1 >= len(block_variants):
                    continue
                next_label, _, _ = block_variants[index + 1]
                if roles_in_text(next_label):
                    continue
                carried_roles = roles_in_text(fragment)
                if not carried_roles:
                    continue
                evidence = extract_contributor_evidence(
                    next_label,
                    default_roles=carried_roles,
                    raw_value=next_label,
                )
                if not evidence["contributors"]:
                    continue
                consumed_indices.add(index + 1)

            grouped = {}
            for contributor in evidence["contributors"]:
                grouped.setdefault(contributor["role"], [])
                grouped[contributor["role"]].append(contributor["name"])

            for role, names in grouped.items():
                value = ", ".join(names)
                dedupe_key = (normalize_catalog_text(fragment), normalize_catalog_text(value))
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                entries.append(
                    {
                        "key": role,
                        "label": fragment,
                        "value": value,
                        "role": role,
                        "roles": [role],
                    }
                )

    return entries


def extract_role_contributors(book_info_html):
    extracted = []
    for entry in extract_front_matter_entries(book_info_html):
        entry_roles = entry.get("roles") or ([entry["role"]] if entry["role"] else [])
        if not entry_roles:
            continue
        evidence = extract_contributor_evidence(
            entry["value"],
            default_roles=entry_roles,
            raw_value=entry["value"],
        )
        extracted.extend(evidence["contributors"])
    return extracted


def normalize_scraped_book(book_data):
    front_matter_html = combined_front_matter_html(
        book_data.get("book_info", ""),
        book_data.get("main_content", ""),
    )
    contributors = []
    seen_contributors = set()

    def append_contributor(contributor):
        contributor_key = (
            contributor["role"],
            normalize_catalog_text(contributor["name"]),
        )
        if contributor_key in seen_contributors:
            return
        seen_contributors.add(contributor_key)
        contributors.append(contributor)

    for contributor in extract_role_contributors(front_matter_html):
        append_contributor(contributor)

    weak_author_evidence = extract_contributor_evidence(
        book_data.get("author", ""),
        raw_value=book_data.get("author", ""),
    )
    for contributor in weak_author_evidence["contributors"]:
        append_contributor(contributor)

    claimed_names = {
        normalize_catalog_text(contributor["name"])
        for contributor in contributors
        if contributor["role"] != ContributorRole.AUTHOR
    }
    for author in weak_author_evidence["authors"]:
        normalized_name = normalize_catalog_text(author)
        if not normalized_name or normalized_name in claimed_names:
            continue
        append_contributor(
            {
                "name": author,
                "role": ContributorRole.AUTHOR,
                "raw_value": book_data.get("author", ""),
            }
        )

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
