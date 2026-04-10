import os
from html import escape

from apps.ingestion.services.normalization import (
    normalize_dedication_heading_and_content,
    split_leading_front_sections,
)
from .html_book_support.preview import render_preview_single_tab_guard_script
from .html_book_support.styles import generate_css
from .html_book_support.toc import (
    build_hierarchical_toc_html,
    build_toc_id_map,
    display_value,
    generate_content_html,
    html_cover_source,
)

def save_html(book_title, author, series, book_type, cover, main_content, book_info, dedication, toc, content_items, output_folder):
    front_sections, compact_main_content = split_leading_front_sections(main_content or "")

    """Generate and save HTML book with hierarchical TOC, book info and dedication section"""
    existing_ids = set()

    # Start HTML document
    html = f"""<!DOCTYPE html>
<html lang='bn'>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{escape(book_title)}</title>
    <style>{generate_css()}</style>{render_preview_single_tab_guard_script()}
  </head>
  <body>
    <div class="container">
      <!-- Book Header -->
      <div class="book-header">
        <h1>{escape(book_title)}</h1>
        <div class="author">{escape(author)}</div>"""

    if series:
        html += f"\n        <div class='series'>সিরিজ: {escape(series)}</div>"
    if book_type:
        html += f"\n        <div class='book-type'>{escape(book_type)}</div>"

    html += "\n      </div>"

    # Cover Image
    cover_src = html_cover_source(cover, output_folder)
    if cover_src:
        html += f"\n      <img src='{cover_src}' alt='Book Cover' class='cover-image'>"
    else:
        html += "\n      <div class='cover-placeholder-card'>"
        html += "\n        <span class='cover-placeholder-kicker'>Book</span>"
        html += f"\n        <div><h2 class='cover-placeholder-title'>{escape(book_title)}</h2><p class='cover-placeholder-author'>{escape(author)}</p></div>"
        html += "\n      </div>"

    # Book Info Section (extracted from main content, before dedication)
    if book_info:
        html += "\n      <div class='book-info-section'>"
        html += "\n        <h2 class='book-info-title'>বই তথ্য</h2>"
        html += "\n        <div class='book-info-content'>"
        indented_info = "\n".join(f"          {line}" for line in book_info.splitlines())
        html += f"\n{indented_info}"
        html += "\n        </div>"
        html += "\n      </div>"

    dedication_title, normalized_dedication_html = normalize_dedication_heading_and_content(dedication or "")

    # Dedication Section (if present)
    if normalized_dedication_html:
        html += "\n      <div class='dedication-section'>"
        html += f"\n        <h2 class='dedication-title'>{escape(dedication_title)}</h2>"
        html += "\n        <div class='dedication-content'>"
        # Insert dedication HTML directly (already contains <p> tags)
        indented_dedication = "\n".join(f"          {line}" for line in normalized_dedication_html.splitlines())
        html += f"\n{indented_dedication}"
        html += "\n        </div>"
        html += "\n      </div>"

    if front_sections:
      for section in front_sections:
        html += "\n      <div class='front-section'>"
        html += f"\n        <h2 class='front-section-title'>{escape(section['title'])}</h2>"
        html += "\n        <div class='front-section-content'>"
        indented_section = "\n".join(f"          {line}" for line in section["html"].splitlines())
        html += f"\n{indented_section}"
        html += "\n        </div>"
        html += "\n      </div>"

    # Main Content
    if compact_main_content:
      html += "\n      <div class='main-content'>"
      indented_content = "\n".join(f"        {line}" for line in compact_main_content.splitlines())
      html += f"\n{indented_content}"
      html += "\n      </div>"

    # Table of Contents
    html += "\n      <div class='toc-section'>"
    html += "\n        <h2 class='toc-title'>সূচিপত্র</h2>"
    html += "\n        <ul class='toc-list'>"
    toc_id_map = build_toc_id_map(toc, existing_ids)
    toc_html = build_hierarchical_toc_html(toc, toc_id_map)
    html += toc_html
    html += "\n        </ul>"
    html += "\n      </div>"

    # Content Sections
    html += "\n      <!-- Content Sections -->"
    content_html = generate_content_html(content_items, toc, toc_id_map)
    html += content_html

    # Close HTML
    html += "\n    </div>"
    html += "\n  </body>"
    html += "\n</html>"

    # Save file
    html_file = os.path.join(output_folder, "book.html")
    if os.path.exists(html_file):
        print(f"Replacing existing HTML file: {html_file}")
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"HTML saved at {html_file}")

def create_html_book(book_data):
    """
    Create HTML book from scraped book data.
    
    Expected book_data structure:
    {
        "book_title": str,
        "author": str,
        "series": str,
        "book_type": str,
        "cover": str,
        "main_content": str,
        "book_info": str,           # Book info extracted before dedication
        "dedication": str,          # Dedication text
        "toc": list,              # Hierarchical TOC structure
        "content_items": list,     # List of content dictionaries
        "output_folder": str
    }
    """
    save_html(
        book_title=book_data["book_title"],
        author=display_value(book_data["author"]),
        series=display_value(book_data["series"]),
        book_type=display_value(book_data["book_type"]),
        cover=book_data["cover"],
        main_content=book_data["main_content"],
        book_info=book_data.get("book_info", ""),
        dedication=book_data.get("dedication", ""),
        toc=book_data["toc"],
        content_items=book_data["content_items"],
        output_folder=book_data["output_folder"]
    )
