import base64
import mimetypes
import os
import re
from html import escape

from apps.ingestion.services.normalization import split_leading_front_sections


def render_preview_single_tab_guard_script():
    return """
    <script>
      (function () {
        var LOCK_PREFIX = "ebook_preview_lock:";
        var HEARTBEAT_MS = 4000;
        var STALE_MS = 15000;
        var lockKey = LOCK_PREFIX + String(window.location.pathname || "");
        var tabId =
          (window.crypto && typeof window.crypto.randomUUID === "function"
            ? window.crypto.randomUUID()
            : String(Date.now()) + ":" + Math.random().toString(16).slice(2));
        var heartbeatId = null;
        var blocked = false;

        function nowMs() {
          return Date.now();
        }

        function parseLock(rawValue) {
          if (!rawValue) {
            return null;
          }
          try {
            return JSON.parse(rawValue);
          } catch (error) {
            return null;
          }
        }

        function readLock() {
          try {
            return parseLock(window.localStorage.getItem(lockKey));
          } catch (error) {
            return null;
          }
        }

        function isActiveLock(lockValue) {
          return Boolean(
            lockValue &&
              lockValue.tabId &&
              typeof lockValue.ts === "number" &&
              nowMs() - lockValue.ts <= STALE_MS,
          );
        }

        function writeOwnLock() {
          try {
            window.localStorage.setItem(
              lockKey,
              JSON.stringify({ tabId: tabId, ts: nowMs() }),
            );
          } catch (error) {
            return;
          }
        }

        function clearOwnLock() {
          var lockValue = readLock();
          if (lockValue && lockValue.tabId === tabId) {
            try {
              window.localStorage.removeItem(lockKey);
            } catch (error) {
              return;
            }
          }
        }

        function showBlockedMessage() {
          if (blocked) {
            return;
          }
          blocked = true;
          if (heartbeatId) {
            window.clearInterval(heartbeatId);
          }
          clearOwnLock();
          try {
            window.stop();
          } catch (error) {
            // no-op
          }
          document.open();
          document.write(
            "<!doctype html><html lang='en'><head><meta charset='utf-8'/><meta name='viewport' content='width=device-width, initial-scale=1'/><title>Preview unavailable</title><style>body{font-family:Arial,sans-serif;margin:0;background:#f7f7f7;color:#222;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}main{max-width:560px;background:#fff;border:1px solid #ddd;border-radius:10px;padding:24px;box-shadow:0 8px 24px rgba(0,0,0,.06)}h1{margin:0 0 12px;font-size:20px}p{margin:0;line-height:1.5}</style></head><body><main><h1>Preview already open</h1><p>This book preview is already open in another tab or window. Close the existing preview and try again.</p></main></body></html>",
          );
          document.close();
        }

        function acquireLock() {
          var currentLock = readLock();
          if (isActiveLock(currentLock) && currentLock.tabId !== tabId) {
            return false;
          }
          writeOwnLock();
          var confirmedLock = readLock();
          return Boolean(confirmedLock && confirmedLock.tabId === tabId);
        }

        if (!acquireLock()) {
          showBlockedMessage();
          return;
        }

        heartbeatId = window.setInterval(function () {
          if (blocked) {
            return;
          }
          var currentLock = readLock();
          if (isActiveLock(currentLock) && currentLock.tabId !== tabId) {
            showBlockedMessage();
            return;
          }
          writeOwnLock();
        }, HEARTBEAT_MS);

        window.addEventListener("storage", function (event) {
          if (blocked || event.key !== lockKey) {
            return;
          }
          var currentLock = readLock();
          if (isActiveLock(currentLock) && currentLock.tabId !== tabId) {
            showBlockedMessage();
          }
        });

        window.addEventListener("beforeunload", clearOwnLock);
        window.addEventListener("pagehide", clearOwnLock);
      })();
    </script>
    """


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

def make_unique_id(name, existing):
    """Generate unique ID for HTML anchors"""
    slug = re.sub(r"\W+", "_", name.lower().strip())
    base = slug
    i = 1
    while slug in existing:
        slug = f"{base}_{i}"
        i += 1
    existing.add(slug)
    return slug


def resolve_cover_path(cover, output_folder):
    if cover and str(cover).startswith(("http://", "https://", "data:")):
        return str(cover)

    if not output_folder or not os.path.isdir(output_folder):
        return ""

    if cover:
        direct_path = cover if os.path.isabs(cover) else os.path.join(output_folder, cover)
        if os.path.exists(direct_path):
            return direct_path

        requested_base = os.path.splitext(os.path.basename(str(cover)))[0]
        if requested_base:
            for filename in sorted(os.listdir(output_folder)):
                if os.path.splitext(filename)[0] == requested_base:
                    candidate_path = os.path.join(output_folder, filename)
                    if os.path.isfile(candidate_path):
                        return candidate_path

    for filename in sorted(os.listdir(output_folder)):
        if os.path.splitext(filename)[0] == "book_cover":
            candidate_path = os.path.join(output_folder, filename)
            if os.path.isfile(candidate_path):
                return candidate_path

    return ""


def html_cover_source(cover, output_folder):
    cover_path = resolve_cover_path(cover, output_folder)
    if not cover_path:
        return ""
    if cover_path.startswith(("http://", "https://", "data:")):
        return cover_path

    mime_type = mimetypes.guess_type(cover_path)[0] or "image/jpeg"
    with open(cover_path, "rb") as handle:
        encoded_image = base64.b64encode(handle.read()).decode("ascii")
    return f"data:{mime_type};base64,{encoded_image}"

def build_hierarchical_toc_html(toc, existing_ids):
    """
    Build HTML for hierarchical table of contents.
    Returns tuple of (html_string, list_of_ids)
    """
    html = ""
    all_ids = []
    
    for entry in toc:
        if entry.get("children"):
            # Lesson with topics
            lesson_title = entry["title"]
            html += f"\n      <li class='toc-lesson'>"
            html += f"\n        <strong>{escape(lesson_title)}</strong>"
            html += "\n        <ul class='toc-topics'>"
            
            for child in entry["children"]:
                child_id = make_unique_id(child["title"], existing_ids)
                all_ids.append(child_id)
                html += f"\n          <li class='toc-topic'><a href='#{child_id}'>{escape(child['title'])}</a></li>"
            
            html += "\n        </ul>"
            html += "\n      </li>"
        else:
            # Standalone lesson (no topics)
            lesson_id = make_unique_id(entry["title"], existing_ids)
            all_ids.append(lesson_id)
            html += f"\n      <li class='toc-standalone'><a href='#{lesson_id}'>{escape(entry['title'])}</a></li>"
    
    return html, all_ids

def generate_content_html(content_items, toc, existing_ids):
    """
    Generate HTML content sections based on content_items and TOC structure.
    Returns HTML string.
    """
    html = ""
    
    # Create a mapping of titles to their IDs
    title_to_id = {}
    
    # First pass: assign IDs based on TOC structure
    for entry in toc:
        if entry.get("children"):
            # Lesson with topics - assign IDs to children
            for child in entry["children"]:
                child_id = make_unique_id(child["title"], existing_ids)
                title_to_id[child["title"]] = child_id
        else:
            # Standalone lesson
            lesson_id = make_unique_id(entry["title"], existing_ids)
            title_to_id[entry["title"]] = lesson_id
    
    # Group content items by parent for nested structure
    parent_groups = {}
    standalone_items = []
    
    for item in content_items:
        if item["parent"]:
            if item["parent"] not in parent_groups:
                parent_groups[item["parent"]] = []
            parent_groups[item["parent"]].append(item)
        else:
            standalone_items.append(item)
    
    # Generate HTML based on TOC structure
    for entry in toc:
        if entry.get("children"):
            # Lesson with topics
            html += f"\n    <div class='lesson-section'>"
            html += f"\n      <hr class='lesson-divider'>"
            html += f"\n      <h2 class='lesson-header'>{escape(entry['title'])}</h2>"
            
            # Add topics for this lesson
            if entry["title"] in parent_groups:
                for item in parent_groups[entry["title"]]:
                    item_id = title_to_id.get(item["title"], make_unique_id(item["title"], existing_ids))
                    html += f"\n      <div class='topic-section'>"
                    html += f"\n        <h3 class='topic-header' id='{item_id}'>{escape(item['title'])}</h3>"
                    html += f"\n        <div class='topic-content'>"
                    if item["content"]:
                        # Indent content properly
                        indented = "\n".join(f"          {line}" for line in item["content"].splitlines())
                        html += f"\n{indented}"
                    html += f"\n        </div>"
                    html += f"\n      </div>"
            html += f"\n    </div>"
        else:
            # Standalone lesson
            item = next((x for x in standalone_items if x["title"] == entry["title"]), None)
            if item:
                item_id = title_to_id.get(item["title"], make_unique_id(item["title"], existing_ids))
                html += f"\n    <div class='standalone-lesson'>"
                html += f"\n      <hr class='lesson-divider'>"
                html += f"\n      <h2 class='lesson-header' id='{item_id}'>{escape(item['title'])}</h2>"
                html += f"\n      <div class='lesson-content'>"
                if item["content"]:
                    # Indent content properly
                    indented = "\n".join(f"        {line}" for line in item["content"].splitlines())
                    html += f"\n{indented}"
                html += f"\n      </div>"
                html += f"\n    </div>"
    
    return html

def generate_css():
    """Generate comprehensive CSS for the HTML book"""
    return """
      /* Base Styles */
      body {
        font-family: 'Kalpurush', 'SolaimanLipi', Arial, sans-serif;
        line-height: 1.8;
        margin: 0;
        padding: 20px;
        background-color: #f5f5f5;
        color: #333;
      }
      
      /* Container */
      .container {
        max-width: 900px;
        margin: 0 auto;
        background-color: white;
        padding: 40px;
        box-shadow: 0 0 10px rgba(0,0,0,0.1);
      }
      
      /* Header Section */
      .book-header {
        text-align: center;
        margin-bottom: 40px;
        padding-bottom: 30px;
        border-bottom: 3px solid #3498db;
      }
      
      h1 {
        font-size: 2.5em;
        color: #2c3e50;
        margin-bottom: 10px;
      }
      
      .author {
        font-size: 1.5em;
        color: #7f8c8d;
        margin: 10px 0;
      }
      
      .series {
        font-size: 1.2em;
        color: #95a5a6;
        margin: 5px 0;
      }
      
      .book-type {
        font-size: 1em;
        color: #bdc3c7;
        margin: 5px 0;
      }
      
      /* Cover Image */
      .cover-image {
        max-width: 400px;
        height: auto;
        margin: 20px auto;
        display: block;
        box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        border-radius: 5px;
      }

      .cover-placeholder-card {
        max-width: 400px;
        min-height: 520px;
        margin: 20px auto;
        padding: 28px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        border-radius: 16px;
        background:
          radial-gradient(circle at 18% 12%, rgba(238, 211, 121, 0.35), transparent 34%),
          radial-gradient(circle at 100% 100%, rgba(15, 75, 56, 0.22), transparent 42%),
          linear-gradient(145deg, #f9f2df 0%, #e6f1eb 100%);
        box-shadow: 0 10px 24px rgba(0,0,0,0.14);
        color: #0b3d2e;
        text-align: left;
      }

      .cover-placeholder-kicker {
        display: inline-block;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(255,255,255,0.72);
        font-size: 0.72em;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .cover-placeholder-title {
        font-size: 2.1em;
        line-height: 1.2;
        margin: 24px 0 12px;
        color: #17392f;
      }

      .cover-placeholder-author {
        font-size: 1.1em;
        margin: 0;
        color: rgba(11, 61, 46, 0.78);
      }
      
      /* Book Info Section */
      .book-info-section {
        background-color: #e8f4f8;
        padding: 30px;
        margin: 40px 0;
        border-radius: 8px;
        border-left: 5px solid #3498db;
        text-align: center;
      }
      
      .book-info-title {
        font-size: 1.8em;
        color: #2c3e50;
        margin-bottom: 20px;
        font-weight: bold;
      }
      
      .book-info-content {
        font-size: 1.1em;
        color: #555;
        line-height: 1.8;
      }
      
      .book-info-content p {
        margin: 8px 0;
      }
      
      /* Dedication Section */
      .dedication-section {
        background-color: #fef9e7;
        padding: 30px;
        margin: 40px 0;
        border-radius: 8px;
        border-left: 5px solid #f39c12;
        text-align: center;
      }
      
      .dedication-title {
        font-size: 1.8em;
        color: #d68910;
        margin-bottom: 20px;
        font-weight: bold;
      }
      
      .dedication-content {
        font-size: 1.2em;
        color: #555;
        line-height: 1.8;
      }
      
      .dedication-content p {
        margin: 10px 0;
      }
      
      .dedication-content strong {
        font-size: 1.1em;
        color: #d68910;
      }

      .front-section {
        background-color: #eef4f1;
        padding: 24px;
        margin: 32px 0;
        border-radius: 8px;
        border-left: 5px solid #0b3d2e;
      }

      .front-section-title {
        font-size: 1.6em;
        color: #0b3d2e;
        margin-bottom: 14px;
        font-weight: bold;
      }

      .front-section-content p {
        margin: 10px 0;
      }
      
      /* Table of Contents */
      .toc-section {
        background-color: #ecf0f1;
        padding: 30px;
        margin: 40px 0;
        border-radius: 8px;
      }
      
      .toc-title {
        font-size: 2em;
        color: #2c3e50;
        text-align: center;
        margin-bottom: 20px;
        border-bottom: 2px solid #3498db;
        padding-bottom: 10px;
      }
      
      .toc-list {
        list-style-type: none;
        padding-left: 0;
      }
      
      .toc-lesson {
        margin: 15px 0;
        padding: 10px;
        background-color: white;
        border-radius: 5px;
      }
      
      .toc-lesson strong {
        font-size: 1.2em;
        color: #34495e;
        display: block;
        margin-bottom: 8px;
      }
      
      .toc-topics {
        list-style-type: none;
        padding-left: 20px;
        margin-top: 8px;
      }
      
      .toc-topic {
        margin: 6px 0;
        padding: 5px 0;
      }
      
      .toc-topic a {
        color: #3498db;
        text-decoration: none;
        transition: color 0.3s;
      }
      
      .toc-topic a:hover {
        color: #2980b9;
        text-decoration: underline;
      }
      
      .toc-standalone {
        margin: 10px 0;
        padding: 10px;
        background-color: white;
        border-radius: 5px;
      }
      
      .toc-standalone a {
        color: #2c3e50;
        text-decoration: none;
        font-weight: 500;
        font-size: 1.1em;
        transition: color 0.3s;
      }
      
      .toc-standalone a:hover {
        color: #3498db;
        text-decoration: underline;
      }
      
      /* Content Sections */
      .lesson-divider {
        border: none;
        border-top: 2px solid #e0e0e0;
        margin: 40px 0 30px 0;
      }
      
      .lesson-section,
      .standalone-lesson {
        margin-bottom: 40px;
      }
      
      .lesson-header {
        font-size: 2em;
        color: #2c3e50;
        margin-top: 30px;
        margin-bottom: 20px;
        padding-bottom: 10px;
        border-bottom: 2px solid #3498db;
      }
      
      .topic-section {
        margin: 30px 0;
        padding-left: 20px;
        border-left: 3px solid #e0e0e0;
      }
      
      .topic-header {
        font-size: 1.5em;
        color: #34495e;
        margin-top: 20px;
        margin-bottom: 15px;
        padding-left: 15px;
      }
      
      .topic-content,
      .lesson-content {
        line-height: 1.8;
        color: #2c3e50;
        padding: 15px;
        background-color: #fafafa;
        border-radius: 5px;
      }
      
      /* Content Typography */
      .topic-content p,
      .lesson-content p {
        margin: 15px 0;
      }
      
      .topic-content img,
      .lesson-content img {
        max-width: 100%;
        height: auto;
        margin: 20px 0;
        border-radius: 5px;
      }
      
      .topic-content ul,
      .lesson-content ul {
        margin: 15px 0;
        padding-left: 30px;
      }
      
      .topic-content li,
      .lesson-content li {
        margin: 8px 0;
      }
      
      /* Responsive Design */
      @media (max-width: 768px) {
        body {
          padding: 10px;
        }
        
        .container {
          padding: 20px;
        }
        
        h1 {
          font-size: 2em;
        }
        
        .author {
          font-size: 1.2em;
        }
        
        .lesson-header {
          font-size: 1.5em;
        }
        
        .topic-header {
          font-size: 1.2em;
        }
        
        .topic-section {
          padding-left: 10px;
        }
      }
      
      /* Print Styles */
      @media print {
        body {
          background-color: white;
          padding: 0;
        }
        
        .container {
          box-shadow: none;
        }
        
        .toc-section {
          background-color: white;
          border: 1px solid #ccc;
        }
        
        .dedication-section {
          background-color: white;
          border: 1px solid #f39c12;
        }
        
        .lesson-divider {
          page-break-before: always;
        }
      }
"""

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

    # Dedication Section (if present)
    if dedication:
        html += "\n      <div class='dedication-section'>"
        html += "\n        <h2 class='dedication-title'>উৎসর্গ</h2>"
        html += "\n        <div class='dedication-content'>"
        # Insert dedication HTML directly (already contains <p> tags)
        indented_dedication = "\n".join(f"          {line}" for line in dedication.splitlines())
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
    toc_html, _ = build_hierarchical_toc_html(toc, existing_ids)
    html += toc_html
    html += "\n        </ul>"
    html += "\n      </div>"

    # Content Sections
    html += "\n      <!-- Content Sections -->"
    content_html = generate_content_html(content_items, toc, existing_ids)
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
