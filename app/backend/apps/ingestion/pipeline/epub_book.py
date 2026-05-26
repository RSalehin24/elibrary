import os
from pathlib import Path

from apps.ingestion.pipeline.curated_export import (
    curated_document_to_legacy_payload,
    is_curated_document,
)
from .epub_properties.epub_builder import EpubBuilder, html_is_blank
from apps.ingestion.services.submissions_support.assets import resolve_generated_cover_path
from apps.ingestion.services.normalization import (
    build_flat_toc_from_content_items,
    dedupe_structured_sections,
    expand_content_items_with_subchapters,
    extract_boundary_sections_from_content_items,
    infer_structured_content_from_main_content,
    normalize_dedication_heading_and_content,
    split_leading_front_sections,
    split_trailing_front_sections,
)


def _drop_blank_content_items(items):
    """Remove content items whose body is whitespace-only so the EPUB does
    not include empty chapters in the spine, NAV, or printed TOC."""
    return [item for item in items if not html_is_blank((item or {}).get("content", ""))]


def display_value(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("display_name", "name", "title"):
            if value.get(key):
                return str(value[key])
        return ", ".join(display_value(item) for item in value.values() if item)
    if isinstance(value, (list, tuple, set)):
        return ", ".join(display_value(item) for item in value if item)
    return str(value)

def create_epub(book_data):
    """
    Generate EPUB book from scraped data with hierarchical TOC.
    
    Expected book_data structure:
    {
        "book_title": str,
        "author": str,
        "series": str,
        "book_type": str,
        "cover": str,
        "main_content": str,
        "toc": list,              # Hierarchical TOC structure
        "content_items": list,     # List of content dictionaries
        "output_folder": str
    }
    """
    if is_curated_document(book_data):
        book_data = curated_document_to_legacy_payload(book_data)
    canonical_payload = bool(book_data.get("canonical_manifest") or book_data.get("canonical_sections"))

    builder = EpubBuilder(
        book_title=book_data["book_title"],
        author=display_value(book_data["author"]),
        series=display_value(book_data["series"]),
        book_type=display_value(book_data["book_type"]),
        output_folder=book_data["output_folder"]
    )
    
    # Add cover page if available — use resolve_generated_cover_path so that
    # a URL in book_data["cover"] (from cover_source_url) or a plain filename
    # both resolve correctly against the local output folder.
    _cover_path = resolve_generated_cover_path(
        Path(book_data["output_folder"]), book_data.get("cover", "")
    )
    if _cover_path and _cover_path.exists():
        builder.add_cover_page(cover_image_path=str(_cover_path))
    else:
        # No real cover image found — generate a dark-mode HTML cover instead.
        builder.add_generated_cover_page()

    # Add standard pages
    builder.add_title_page()
    
    # Book info page is only added when there is actual info to display;
    # an empty page would just add a blank entry to the book.
    book_info = book_data.get("book_info", "")
    if book_info and not html_is_blank(book_info):
        builder.add_info_page(scraped_book_info=book_info)
    
    dedication_title, dedication_html = normalize_dedication_heading_and_content(
        book_data.get("dedication", "")
    )
    if dedication_html:
        builder.add_dedication_page(
            dedication_title=dedication_title,
            dedication_html=dedication_html,
        )
    
    main_content = book_data.get("main_content", "")
    reference_fragments = [book_data.get("book_info", ""), book_data.get("dedication", "")]
    front_sections = dedupe_structured_sections(
        book_data.get("front_sections") or [],
        reference_fragments=reference_fragments,
    )
    back_sections = dedupe_structured_sections(
        book_data.get("back_sections") or [],
        reference_fragments=reference_fragments,
    )
    toc = book_data["toc"]
    content_items = list(book_data["content_items"])
    if content_items and not canonical_payload:
        (
            inferred_front_sections,
            inferred_back_sections,
            toc,
            content_items,
        ) = extract_boundary_sections_from_content_items(content_items, toc)
        front_sections = dedupe_structured_sections(
            [*front_sections, *inferred_front_sections],
            reference_fragments=reference_fragments,
        )
        back_sections = dedupe_structured_sections(
            [*back_sections, *inferred_back_sections],
            reference_fragments=reference_fragments,
        )
    compact_main_content = main_content
    if not front_sections and not canonical_payload:
        front_sections, compact_main_content = split_leading_front_sections(main_content)
    if not back_sections and not canonical_payload:
        back_sections, compact_main_content = split_trailing_front_sections(compact_main_content or "")

    # Drop empty/whitespace-only chapters before TOC + spine generation so
    # the printed Contents page and EPUB NAV stay in sync with the body.
    content_items = _drop_blank_content_items(content_items)

    # --- Single-page book: infer chapter structure from main content ----
    # When the scraped/curated data has no content_items (a single HTML blob),
    # attempt to detect headings and split the content into proper chapters.
    # If inference finds ≥2 sections the book gets a real multi-chapter TOC;
    # any content that comes before the first detected heading is kept as a
    # front section so no text is lost.
    if not content_items and compact_main_content and not html_is_blank(compact_main_content):
        _inferred_toc, _inferred_items, _residual = infer_structured_content_from_main_content(
            compact_main_content, book_title=book_data.get("book_title", "")
        )
        if len(_inferred_items) >= 2:
            toc = _inferred_toc or build_flat_toc_from_content_items(_inferred_items)
            content_items = _inferred_items
            # Any HTML that precedes the first detected heading becomes a front section.
            if _residual and not html_is_blank(_residual):
                front_sections = [*front_sections, {"title": "ভূমিকা", "html": _residual}]
            compact_main_content = ""
        else:
            # Phase B: top-level inference failed. Try synthesising structure
            # from inline h2/h3/h4 headings inside the single content blob by
            # running it through the A.2 sub-chapter splitter as if the whole
            # book were one giant lesson. If at least 2 sub-chapters emerge,
            # promote them to top-level lessons.
            _virtual_title = book_data.get("book_title", "") or "মূল লেখা"
            _virtual_item = {
                "title": _virtual_title,
                "type": "lesson",
                "content": compact_main_content,
                "path": [_virtual_title],
            }
            _b_toc, _b_items = expand_content_items_with_subchapters(
                [{"title": _virtual_title, "type": "lesson", "has_content": True, "path": [_virtual_title]}],
                [_virtual_item],
            )
            _promoted = [it for it in _b_items if it.get("parent") == _virtual_title]
            if len(_promoted) >= 2:
                # Promote sub-chapters to top-level lessons.
                content_items = [
                    {
                        "title": sub["title"],
                        "type": "lesson",
                        "content": sub["content"],
                        "parent": None,
                        "path": [sub["title"]],
                    }
                    for sub in _promoted
                ]
                toc = build_flat_toc_from_content_items(content_items)
                # Preserve any parent intro from the virtual item as ভূমিকা.
                _parent = next((it for it in _b_items if it.get("title") == _virtual_title), None)
                if _parent and _parent.get("content") and not html_is_blank(_parent["content"]):
                    front_sections = [*front_sections, {"title": "ভূমিকা", "html": _parent["content"]}]
                compact_main_content = ""

    # Mis-classification rescue: the dynamic scraper occasionally routes
    # every real chapter into front_sections (e.g. when the canonical TOC
    # only exposes one composite "৬-১০" sub-page). Detect that case — a
    # near-empty content_items list paired with many substantive
    # front_sections — and promote the front sections to content_items so
    # the book remains readable and the EPUB audit's "spine has no content
    # pages" check is satisfied.
    if (
        len(content_items) <= 1
        and not canonical_payload
        and not compact_main_content
        and sum(1 for s in front_sections if not html_is_blank(s.get("html") or "")) >= 3
    ):
        promoted = [
            {
                "title": s.get("title") or "",
                "type": "lesson",
                "content": s.get("html") or "",
                "parent": None,
                "path": [s.get("title") or ""],
            }
            for s in front_sections
            if not html_is_blank(s.get("html") or "")
        ]
        # Merge with any existing single composite content_item so its
        # contents are not lost.
        content_items = [*promoted, *content_items]
        toc = build_flat_toc_from_content_items(content_items)
        front_sections = []

    if front_sections:
        builder.add_front_section_pages(front_sections)

    # Phase A.2: synthesise sub-chapters from in-chapter headings so long
    # lessons get a real nested TOC instead of a single wall of text.
    if content_items:
        toc, content_items = expand_content_items_with_subchapters(toc, content_items)

    # Add TOC page — use hierarchical template only when the curated document
    # actually supplies a toc_structure; otherwise the rendered page is blank.
    # Fall back to a flat list built directly from content_items.
    if toc and content_items:
        builder.add_hierarchical_toc_page(
            toc_structure=toc,
            content_items=content_items
        )
    elif content_items:
        toc_lessons = [
            (item.get("title", ""), f"lesson_{i+1}.xhtml")
            for i, item in enumerate(content_items)
        ]
        builder.add_toc_page(lessons=toc_lessons)

    # Add main content only for single-flow books (no chapter structure).
    # When content_items exist the remaining compact_main_content is either
    # intro text already captured as a front section or leftover scraping
    # noise — adding it as a "প্রারম্ভ" page would be misleading.
    if compact_main_content and not content_items:
        main_content_title = book_data.get("book_title") or "মূল লেখা"
        builder.add_main_content_page(main_content=compact_main_content, title=main_content_title)
    
    # Add lesson pages
    builder.add_lesson_pages(content_items)

    if back_sections:
        builder.add_back_section_pages(back_sections)

    # Build and save EPUB
    epub_filename = f"{book_data['book_title']}.epub"
    builder.build_epub(epub_filename, toc_structure=toc)
