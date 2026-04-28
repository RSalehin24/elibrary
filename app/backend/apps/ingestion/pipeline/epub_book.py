import os

from .epub_properties.epub_builder import EpubBuilder
from apps.ingestion.services.normalization import (
    dedupe_structured_sections,
    extract_boundary_sections_from_content_items,
    normalize_dedication_heading_and_content,
    split_leading_front_sections,
    split_trailing_front_sections,
)


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
    builder = EpubBuilder(
        book_title=book_data["book_title"],
        author=display_value(book_data["author"]),
        series=display_value(book_data["series"]),
        book_type=display_value(book_data["book_type"]),
        output_folder=book_data["output_folder"]
    )
    
    # Add cover page if available
    if book_data["cover"]:
        cover_path = os.path.join(book_data["output_folder"], book_data["cover"])
        if os.path.exists(cover_path):
            builder.add_cover_page(cover_image_path=cover_path)
    
    # Add standard pages
    builder.add_title_page()
    
    # Add info page with extracted book info if available
    book_info = book_data.get("book_info", "")
    builder.add_info_page(translator="", additional_info="", scraped_book_info=book_info)
    
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
    if content_items:
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
    if not front_sections:
        front_sections, compact_main_content = split_leading_front_sections(main_content)
    if not back_sections:
        back_sections, compact_main_content = split_trailing_front_sections(compact_main_content or "")

    if front_sections:
        builder.add_front_section_pages(front_sections)

    # Add main content if available
    if compact_main_content:
        builder.add_main_content_page(main_content=compact_main_content)

    # Add hierarchical TOC page (if the method exists in your EpubBuilder)
    # Otherwise, fall back to regular TOC
    if (toc or content_items) and hasattr(builder, 'add_hierarchical_toc_page'):
        builder.add_hierarchical_toc_page(
            toc_structure=toc,
            content_items=content_items
        )
    elif content_items:
        # Fallback: Build simple TOC lessons list
        toc_lessons = [
            (title, f"lesson_{i+1}.xhtml")
            for i, title in enumerate(
                item["title"] for item in content_items
            )
        ]
        builder.add_toc_page(lessons=toc_lessons)
    
    # Add lesson pages
    builder.add_lesson_pages(content_items)

    if back_sections:
        builder.add_back_section_pages(back_sections)

    # Build and save EPUB
    epub_filename = f"{book_data['book_title']}.epub"
    builder.build_epub(epub_filename, toc_structure=toc)
