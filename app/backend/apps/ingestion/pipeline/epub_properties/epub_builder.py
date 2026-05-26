import os
import re
from ebooklib import epub
from jinja2 import Environment, FileSystemLoader

from .labels import detect_book_language, labels_for

# Fonts bundled alongside this file — available in every container without
# any system-level font installation.
_FONTS_DIR = os.path.join(os.path.dirname(__file__), "fonts")
_BUNDLED_FONT_BOLD    = os.path.join(_FONTS_DIR, "NotoSansBengali-Bold.ttf")
_BUNDLED_FONT_REGULAR = os.path.join(_FONTS_DIR, "NotoSansBengali-Regular.ttf")

# Font search paths for cover image generation (bundled path first, then common
# system locations as fallback).
_COVER_FONT_REGULAR = [
    _BUNDLED_FONT_REGULAR,
    "/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/NotoSansBengali-Regular.ttf",
    "/Library/Fonts/NotoSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/NotoSansBengali-Regular.ttf",
]
_COVER_FONT_BOLD = [
    _BUNDLED_FONT_BOLD,
    "/usr/share/fonts/truetype/noto/NotoSansBengali-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/Library/Fonts/NotoSansBengali-Bold.ttf",
    "/System/Library/Fonts/Supplemental/NotoSansBengali-Bold.ttf",
]


def _load_cover_font(paths, size):
    """Return the first loadable ImageFont from *paths* at *size* pt, or None."""
    try:
        from PIL import ImageFont
    except ImportError:
        return None
    for path in paths:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return None


def _cover_wrap_lines(text, font, max_px, draw):
    """Split *text* on whitespace into lines that each fit within *max_px* pixels.

    Measurements pass ``language="bn"`` so Pillow (with libraqm) shapes
    Bengali conjuncts correctly when computing line widths.
    """
    words = text.split()
    lines = []
    current = ""
    for word in words:
        candidate = (current + " " + word).strip()
        try:
            width = draw.textlength(candidate, font=font, language="bn")
        except TypeError:  # older PIL without language kwarg
            width = draw.textlength(candidate, font=font)
        if width <= max_px:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [text]


# Cover-input sanitisation helpers --------------------------------------------

_LEADING_NUMBER_PREFIX = re.compile(r"^[\s\u00a0]*[\u09e6-\u09ef0-9]+[.)\u0964]?[\s\u00a0]+")
_TRAILING_SEPARATOR_TAIL = re.compile(r"[\s\u00a0]*[\u2013\u2014\-–—:][\s\u00a0]*(.+)$")
_WHITESPACE = re.compile(r"\s+")


def _normalize_cover_text(value):
    if not value:
        return ""
    text = _WHITESPACE.sub(" ", str(value)).strip()
    return text


def _strip_leading_index(title):
    """Remove a leading numeric volume prefix like ``৫০. `` or ``50. ``."""
    return _LEADING_NUMBER_PREFIX.sub("", title, count=1).strip()


def _sanitize_cover_inputs(book_title, author, series):
    """Clean and de-duplicate the strings that appear on the generated cover.

    Common artefacts removed:
    - A leading Bengali/Latin numeral prefix on the title (``৫০. ``).
    - A trailing ``" – series-name"`` tail on the title when *series* is set.
    - Series text that is identical to the title or the author.
    - Repetition of the same value across the three fields.
    """
    title  = _normalize_cover_text(book_title)
    author = _normalize_cover_text(author)
    series = _normalize_cover_text(series)

    title = _strip_leading_index(title)

    # If the title ends with " – {series-ish}" or " – {author}", trim that tail.
    # We accept any tail that is a prefix of the series/author or vice-versa,
    # because the title's series-suffix often omits a volume number that the
    # series field carries (e.g. title ends "সাইমুম সিরিজ" while series is
    # "সাইমুম সিরিজ #৫০").
    def _strip_tail(text, tail_candidate):
        if not text or not tail_candidate:
            return text
        # Match only the last " – tail" / " — tail" / " - tail" segment;
        # the colon is excluded because colons commonly appear inside titles.
        m = re.search(
            r"[\s\u00a0]+[\u2013\u2014\-][\s\u00a0]+([^\u2013\u2014\-]+)$",
            text,
        )
        if not m:
            return text
        tail_text = m.group(1).strip()
        tc = tail_candidate.strip()
        if (
            tail_text == tc
            or tail_text in tc
            or tc in tail_text
        ):
            return text[: m.start()].rstrip()
        return text

    title = _strip_tail(title, series)
    title = _strip_tail(title, author)

    # Drop series/author if they duplicate another field.
    if series and (series == title or series == author):
        series = ""
    if author and author == title:
        author = ""

    return title, author, series


def _generate_cover_png(book_title, author, series, output_folder):
    """Generate a PNG cover image with deep-green palette and Bengali text.

    Produces a 1200×1800 image (standard ebook cover ratio) styled to match
    the ebanglalibrary.com site's dark-mode look: a deep forest-green
    background, soft cream/gold typography and a thin gold divider:

      [top accent bar]
      [gap]
      [title  – bold, large, wrapped if necessary]
      [series – optional, smaller]
      [horizontal divider]
      [author]
      [gap]
      [bottom accent bar]

    Bengali shaping is delegated to libraqm (HarfBuzz) via the ``language="bn"``
    parameter on every ``ImageDraw`` call, which fixes conjunct ordering and
    vowel-sign placement.

    Returns the absolute path to the saved PNG, or None if generation fails
    (e.g. Pillow not installed or no writable output folder).
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None

    title, author, series = _sanitize_cover_inputs(book_title, author, series)

    W, H = 1200, 1800
    PAD = 100
    MAX_W = W - 2 * PAD

    # Deep-green palette mirroring ebanglalibrary.com's dark mode.
    BG_TOP        = (15,  36,  25)   # #0f2419  – forest-green top
    BG_MID        = (29,  60,  52)   # #1d3c34  – richer green centre
    BG_BOT        = (15,  36,  25)   # #0f2419  – forest-green bottom
    ACCENT        = (201, 169, 110)  # #c9a96e  – warm gold accent
    TITLE_COLOR   = (245, 241, 232)  # #f5f1e8  – cream
    AUTHOR_COLOR  = (232, 227, 214)  # #e8e3d6  – soft cream
    SERIES_COLOR  = (196, 207, 191)  # #c4cfbf  – pale sage
    DIVIDER_COLOR = (201, 169, 110)  # gold

    # --- background: smooth vertical gradient (top → mid → bottom) ---
    GRAD_H = 64
    grad_pixels = []
    for row in range(GRAD_H):
        t = row / (GRAD_H - 1)              # 0.0 (top) → 1.0 (bottom)
        if t < 0.5:
            local = t * 2                  # 0..1 within top half
            r = int(BG_TOP[0] + (BG_MID[0] - BG_TOP[0]) * local)
            g = int(BG_TOP[1] + (BG_MID[1] - BG_TOP[1]) * local)
            b = int(BG_TOP[2] + (BG_MID[2] - BG_TOP[2]) * local)
        else:
            local = (t - 0.5) * 2          # 0..1 within bottom half
            r = int(BG_MID[0] + (BG_BOT[0] - BG_MID[0]) * local)
            g = int(BG_MID[1] + (BG_BOT[1] - BG_MID[1]) * local)
            b = int(BG_MID[2] + (BG_BOT[2] - BG_MID[2]) * local)
        grad_pixels.extend([(r, g, b)] * 2)
    grad_img = Image.new("RGB", (2, GRAD_H))
    grad_img.putdata(grad_pixels)
    img = grad_img.resize((W, H), Image.BILINEAR)
    draw = ImageDraw.Draw(img)

    def _draw_text(xy, text, font, fill):
        """Draw Bengali-shaped text using libraqm when available."""
        try:
            draw.text(xy, text, font=font, fill=fill, language="bn")
        except TypeError:  # older PIL without language kwarg
            draw.text(xy, text, font=font, fill=fill)

    title_font  = _load_cover_font(_COVER_FONT_BOLD,    84) or _load_cover_font(_COVER_FONT_REGULAR, 84)
    author_font = _load_cover_font(_COVER_FONT_REGULAR, 52)
    series_font = _load_cover_font(_COVER_FONT_REGULAR, 40)

    TITLE_LINE_H = 128   # pixels per title line (84 pt + leading)

    title_lines = _cover_wrap_lines(title, title_font, MAX_W, draw) if title_font and title else []

    # --- measure the full content block height ---
    BAR_W,   BAR_H,  BAR_GAP  = 120, 5, 72
    DIV_W,   DIV_H            = 160, 2
    DIV_GAP_ABOVE, DIV_GAP_BELOW = 32, 28

    title_h  = len(title_lines) * TITLE_LINE_H
    series_h = (16 + 56 + 16) if (series and series_font) else 0
    div_h    = DIV_GAP_ABOVE + DIV_H + DIV_GAP_BELOW
    author_h = 72 if (author and author_font) else 0

    block_h = BAR_H + BAR_GAP + title_h + series_h + div_h + author_h + BAR_GAP + BAR_H

    y = (H - block_h) // 2   # top of the vertically-centred block

    # --- top accent bar ---
    draw.rectangle(
        [(W // 2 - BAR_W // 2, y), (W // 2 + BAR_W // 2, y + BAR_H)],
        fill=ACCENT,
    )
    y += BAR_H + BAR_GAP

    # --- title ---
    for line in title_lines:
        try:
            w = draw.textlength(line, font=title_font, language="bn")
        except TypeError:
            w = draw.textlength(line, font=title_font)
        _draw_text(((W - w) // 2, y), line, title_font, TITLE_COLOR)
        y += TITLE_LINE_H

    # --- series (optional) ---
    if series and series_font:
        y += 16
        try:
            w = draw.textlength(series, font=series_font, language="bn")
        except TypeError:
            w = draw.textlength(series, font=series_font)
        _draw_text(((W - w) // 2, y), series, series_font, SERIES_COLOR)
        y += 56 + 16

    # --- horizontal divider ---
    y += DIV_GAP_ABOVE
    draw.rectangle(
        [(W // 2 - DIV_W // 2, y), (W // 2 + DIV_W // 2, y + DIV_H)],
        fill=DIVIDER_COLOR,
    )
    y += DIV_H + DIV_GAP_BELOW

    # --- author ---
    if author and author_font:
        try:
            w = draw.textlength(author, font=author_font, language="bn")
        except TypeError:
            w = draw.textlength(author, font=author_font)
        _draw_text(((W - w) // 2, y), author, author_font, AUTHOR_COLOR)
        y += author_h

    # --- bottom accent bar ---
    y += BAR_GAP
    draw.rectangle(
        [(W // 2 - BAR_W // 2, y), (W // 2 + BAR_W // 2, y + BAR_H)],
        fill=ACCENT,
    )

    cover_path = os.path.join(output_folder, "_generated_cover.png")
    try:
        img.save(cover_path, "PNG")
    except Exception:
        return None
    return cover_path


def content_path_tuple(path_value):
    if isinstance(path_value, (list, tuple)):
        return tuple(part for part in path_value if part)
    return ()


def resolve_entry_path(entry, parent_path=()):
    explicit_path = content_path_tuple(entry.get("path"))
    if explicit_path:
        return explicit_path
    return tuple(parent_path) + (entry.get("title", ""),)


_HTML_TAG_PATTERN = re.compile(r"<[^>]+>")
_HTML_WHITESPACE_ENTITIES = ("&nbsp;", "&#160;", "&#xa0;", "&zwnj;", "&#8204;", "&#x200c;")


def html_is_blank(content):
    """Return True if HTML content has no visible text once tags and
    whitespace entities are stripped. Used to skip empty pages."""
    if not content:
        return True
    text = str(content)
    for entity in _HTML_WHITESPACE_ENTITIES:
        text = text.replace(entity, " ")
    text = _HTML_TAG_PATTERN.sub(" ", text)
    return not text.strip()


def safe_epub_filename(filename):
    base_name = str(filename or "book.epub").replace("/", "_").replace("\\", "_")
    base_name = os.path.basename(base_name)
    stem, ext = os.path.splitext(base_name)
    cleaned_stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", stem)
    cleaned_stem = re.sub(r"\s+", " ", cleaned_stem).strip(" ._") or "book"
    return f"{cleaned_stem}{ext or '.epub'}"


class EpubContentMissingError(ValueError):
    """Raised when EPUB build is attempted with no content chapters and no
    main-content page — i.e. the resulting book would have nothing to read."""


class EpubBuilder:
    def __init__(self, book_title, author, series="", book_type="", output_folder="", language=None):
        self.book_title = book_title
        self.author = author
        self.series = series
        self.book_type = book_type
        self.output_folder = output_folder
        self.language = language or detect_book_language(book_title, author)
        self.labels = labels_for(self.language)
        self.env = Environment(
            loader=FileSystemLoader(os.path.join(os.path.dirname(__file__), "page_templates"))
        )
        self.book = epub.EpubBook()
        self.book.set_title(book_title)
        self.book.set_language(self.labels["epub_lang"])
        self.book.add_author(author)
        self.chapters = []
        self.lesson_chapters = []
        self.front_matter_pages = []
        self.back_matter_pages = []
        self.content_pages_by_path = {}
        self.fallback_title_to_page = {}
        # Printed toc.xhtml is registered eagerly (to lock spine position) but
        # its body is rendered lazily in build_epub so it can list both the
        # content chapters AND any back-section pages added after the call to
        # add_*_toc_page. _toc_hint records how the printed TOC was requested
        # so build_epub can fall back when no explicit toc_structure is given.
        self._toc_chapter = None
        self._toc_hint = None  # ("hierarchical", toc_structure, content_items) | ("flat", lessons)
        # Back-section entries collected during add_back_section_pages — used
        # so both the printed toc.xhtml and nav.xhtml list end-matter pages.
        self._back_section_entries = []
        # Whether a main-content page was registered (single-flow books).
        self._has_main_content_page = False
        # Front-section pages that contain real readable content. Used as a
        # last-resort fallback when the scraper mis-classifies every chapter
        # as front matter and leaves no content / main-content body.
        self._front_section_entries = []

    def render_template(self, template_name, **context):
        template = self.env.get_template(template_name)
        return template.render(**context)

    def register_chapter(self, chapter, *, include_in_nav=False, insert_front=False, append_back=False):
        self.book.add_item(chapter)
        if insert_front:
            self.chapters.insert(0, chapter)
        else:
            self.chapters.append(chapter)
        if include_in_nav:
            if insert_front:
                self.front_matter_pages.insert(0, chapter)
            elif append_back:
                self.back_matter_pages.append(chapter)
            else:
                self.front_matter_pages.append(chapter)
        return chapter

    def add_cover_page(self, cover_image_path):
        image_name = os.path.basename(cover_image_path)
        # create_page=False prevents ebooklib from generating its own cover.xhtml
        # so the EPUB does not end up with two cover pages.
        self.book.set_cover(
            image_name,
            open(cover_image_path, "rb").read(),
            create_page=False,
        )

        html_content = self.render_template(
            "cover_page.html",
            cover_image=image_name,
            html_lang=self.labels["html_lang"],
        )

        cover_page = epub.EpubHtml(
            title=self.labels["cover"],
            file_name="cover_page.xhtml",
            content=html_content,
        )

        self.register_chapter(cover_page, insert_front=True)

    def add_generated_cover_page(self):
        """Generate a dark-mode PNG cover image when no real cover is available.

        Uses Pillow to produce a 600×900 PNG with the book title and author
        rendered in Bengali-capable fonts, then calls add_cover_page() so the
        image is properly registered in the EPUB manifest as the cover image.

        Falls back to the HTML template if Pillow is unavailable or image
        generation fails for any reason.
        """
        cover_path = _generate_cover_png(
            book_title=self.book_title,
            author=self.author,
            series=self.series,
            output_folder=self.output_folder,
        )
        if cover_path:
            self.add_cover_page(cover_image_path=cover_path)
            return

        # Fallback: HTML cover page (CSS dark-mode styling)
        html_content = self.render_template(
            "generated_cover.html",
            book_title=self.book_title,
            author=self.author,
            series=self.series,
            html_lang=self.labels["html_lang"],
            cover_label=self.labels["cover"],
        )
        cover_page = epub.EpubHtml(
            title=self.labels["cover"],
            file_name="cover_page.xhtml",
            content=html_content,
        )
        self.register_chapter(cover_page, insert_front=True)

    def add_title_page(self):
        html_content = self.render_template(
            "title_page.html",
            book_title=self.book_title,
            author=self.author,
            html_lang=self.labels["html_lang"],
        )
        chapter = epub.EpubHtml(
            title=self.labels["title_page"],
            file_name="title.xhtml",
            content=html_content,
        )
        self.register_chapter(chapter)

    def add_info_page(self, translator="", additional_info="", scraped_book_info=""):
        html_content = self.render_template(
            "info_page.html",
            book_title=self.book_title,
            author=self.author,
            translator=translator,
            series=self.series,
            book_type=self.book_type,
            additional_info=additional_info,
            scraped_book_info=scraped_book_info,
            scrapped_data=not scraped_book_info,
            html_lang=self.labels["html_lang"],
        )
        chapter = epub.EpubHtml(
            title=self.labels["info_page"],
            file_name="info.xhtml",
            content=html_content,
        )
        self.register_chapter(chapter)

    def add_dedication_page(self, dedication_title=None, dedication_html=""):
        title = dedication_title or self.labels["dedication"]
        html_content = self.render_template(
            "dedication.html",
            dedication_title=title,
            dedication_html=dedication_html,
            html_lang=self.labels["html_lang"],
        )
        chapter = epub.EpubHtml(
            title=self.labels["dedication"],
            file_name="dedication.xhtml",
            content=html_content,
        )
        self.register_chapter(chapter)

    def add_main_content_page(self, main_content, title=None):
        if html_is_blank(main_content):
            return
        html_content = self.render_template(
            "main_content.html",
            main_content=main_content,
            html_lang=self.labels["html_lang"],
        )
        chapter = epub.EpubHtml(
            title=title or self.labels["main_content"],
            file_name="main_content.xhtml",
            content=html_content,
        )
        self.register_chapter(chapter)
        self._has_main_content_page = True

    def add_front_section_pages(self, sections):
        for idx, section in enumerate(sections, start=1):
            # nav_title: used in the navigation sidebar when the section has
            # no explicit page heading (unnamed prose → "পূর্বকথা" / "Preliminary Note").
            # page_title: rendered as the visible <h2> on the page — empty
            # means "no heading" per spec.
            explicit_title = (section.get("title") or "").strip()
            nav_title = explicit_title or section.get("nav_title") or f"{self.labels['front_section_prefix']} {idx}"
            page_title = explicit_title  # empty → lesson.html suppresses heading
            content = section.get("html") or ""
            if html_is_blank(content):
                continue
            html_content = self.render_template(
                "lesson.html",
                lesson_title=page_title,
                lesson_content=content,
                html_lang=self.labels["html_lang"],
            )
            file_name = f"front_section_{idx}.xhtml"
            page = epub.EpubHtml(
                title=nav_title,
                file_name=file_name,
                content=html_content,
            )
            self.register_chapter(page)
            self._front_section_entries.append(
                {"title": nav_title, "file_name": file_name, "children": []}
            )

    def add_back_section_pages(self, sections):
        registered_index = len(self._back_section_entries)
        for raw_idx, section in enumerate(sections, start=1):
            title = section.get("title") or f"{self.labels['back_section_prefix']} {raw_idx}"
            content = section.get("html") or ""
            if html_is_blank(content):
                continue
            html_content = self.render_template(
                "lesson.html",
                lesson_title=title,
                lesson_content=content,
                html_lang=self.labels["html_lang"],
            )
            registered_index += 1
            file_name = f"back_section_{registered_index}.xhtml"
            page = epub.EpubHtml(
                title=title,
                file_name=file_name,
                content=html_content,
            )
            self.register_chapter(page)
            self._back_section_entries.append(
                {"title": title, "file_name": file_name, "children": []}
            )

    def add_toc_page(self, lessons):
        # Defer body rendering to build_epub so the printed page can include
        # back-section entries registered after this call. The chapter is
        # placed in the spine immediately to lock the structural position
        # (cover → title → info → dedication → front sections → toc.xhtml).
        chapter = epub.EpubHtml(
            title=self.labels["toc"],
            file_name="toc.xhtml",
            content="",
        )
        self._toc_chapter = chapter
        self._toc_hint = ("flat", list(lessons))
        self.register_chapter(chapter)

    def add_hierarchical_toc_page(self, toc_structure, content_items):
        # Body rendered lazily in build_epub so the printed page lists the
        # final set of content chapters AND any back-section pages registered
        # after this call. The actual entries are built by _build_content_entries
        # which uses content_pages_by_path / fallback_title_to_page populated
        # during add_lesson_pages.
        chapter = epub.EpubHtml(
            title=self.labels["toc"],
            file_name="toc.xhtml",
            content="",
        )
        self._toc_chapter = chapter
        self._toc_hint = ("hierarchical", list(toc_structure), list(content_items))
        self.register_chapter(chapter)

    def add_lesson_pages(self, lessons):
        for idx, lesson in enumerate(lessons, start=1):
            if isinstance(lesson, dict):
                title = lesson.get("title", "")
                content = lesson.get("content", "")
                path = content_path_tuple(lesson.get("path"))
            else:
                title, content = lesson
                path = ()

            html_content = self.render_template(
                "lesson.html",
                lesson_title=title,
                lesson_content=content,
                html_lang=self.labels["html_lang"],
            )
            file_name = f"lesson_{idx}.xhtml"
            chapter = epub.EpubHtml(
                title=title,
                file_name=file_name,
                content=html_content,
            )
            self.register_chapter(chapter)
            self.lesson_chapters.append(chapter)
            if path:
                self.content_pages_by_path[path] = chapter
            self.fallback_title_to_page.setdefault(title, chapter)

    def _build_content_entries(self, toc_structure):
        """Walk toc_structure → nested entries [{title, file_name|None, children}]
        using the chapter file names registered during add_lesson_pages.

        Entries without a resolvable chapter (TOC nodes that have no matching
        content_item) are emitted as container entries (file_name=None) so
        their children remain navigable while the parent renders as a label.
        """
        def walk(entries, parent_path=()):
            built = []
            for entry in entries:
                path = resolve_entry_path(entry, parent_path)
                title = entry.get("title", "")
                chapter = self.content_pages_by_path.get(path) or self.fallback_title_to_page.get(title)
                children = walk(entry.get("children", []), path)
                # When a TOC entry has no direct content page but has
                # children, point it at the first child's page so the nav
                # entry is still clickable rather than a dead Section label.
                file_name = (
                    chapter.file_name
                    if chapter
                    else (children[0]["file_name"] if children else None)
                )
                built.append(
                    {
                        "title": title,
                        "file_name": file_name,
                        "children": children,
                    }
                )
            return built

        return walk(toc_structure)

    def _entries_to_nav_nodes(self, entries):
        """Convert unified entries → the nested ebooklib structure consumed
        by self.book.toc. Container entries (no file_name) become Sections."""
        nav = []
        file_to_chapter = {ch.file_name: ch for ch in self.chapters}
        for entry in entries:
            children = self._entries_to_nav_nodes(entry["children"]) if entry.get("children") else []
            chapter = file_to_chapter.get(entry.get("file_name")) if entry.get("file_name") else None
            if chapter and children:
                nav.append((chapter, tuple(children)))
            elif chapter:
                nav.append(chapter)
            elif children:
                nav.append((epub.Section(entry.get("title", "")), tuple(children)))
            # else: drop empty entry (no chapter, no children)
        return nav

    # Kept as a thin backwards-compatible wrapper; callers that produced an
    # ebooklib navigation tree directly can still use this. New callers should
    # rely on the unified entries produced inside build_epub.
    def build_navigation_entries(self, toc_structure, parent_path=()):
        return self._entries_to_nav_nodes(
            self._build_content_entries(toc_structure)
            if not parent_path
            else self._build_content_entries(toc_structure)
        )

    def _resolve_content_entries(self, toc_structure):
        """Pick the best available content-entry source, in priority order:

        1. Explicit toc_structure passed to build_epub.
        2. Hierarchical hint captured at add_hierarchical_toc_page time.
        3. Flat hint captured at add_toc_page time.
        4. content_pages_by_path (path-indexed lessons).
        5. lesson_chapters (insertion order).
        """
        if toc_structure:
            return self._build_content_entries(toc_structure)
        if self._toc_hint and self._toc_hint[0] == "hierarchical":
            return self._build_content_entries(self._toc_hint[1])
        if self._toc_hint and self._toc_hint[0] == "flat":
            file_to_chapter = {ch.file_name: ch for ch in self.chapters}
            return [
                {
                    "title": title or (file_to_chapter[file_name].title if file_to_chapter.get(file_name) else ""),
                    "file_name": file_name,
                    "children": [],
                }
                for (title, file_name) in self._toc_hint[1]
            ]
        if self.content_pages_by_path:
            return [
                {"title": ch.title, "file_name": ch.file_name, "children": []}
                for ch in self.content_pages_by_path.values()
            ]
        return [
            {"title": ch.title, "file_name": ch.file_name, "children": []}
            for ch in self.lesson_chapters
        ]

    def build_epub(self, filename="book.epub", toc_structure=None):
        filename = safe_epub_filename(filename)

        content_entries = self._resolve_content_entries(toc_structure)

        # A book without content chapters AND without a main-content fallback
        # has nothing to read — refuse rather than emitting a hollow EPUB.
        # The dynamic scraper occasionally mis-classifies every real chapter
        # as a front-section (e.g. when only one composite TOC entry exists
        # at the canonical depth). In that case the front sections ARE the
        # readable body — allow the build to proceed; the nav-building loop
        # below will list each front_section page individually so readers
        # can still reach every chapter.
        has_any_readable_section = bool(
            self._front_section_entries or self._back_section_entries
        )
        if (
            not content_entries
            and not self._has_main_content_page
            and not has_any_readable_section
        ):
            raise EpubContentMissingError(
                f"Cannot build EPUB {filename!r}: no content chapters and no main-content page were registered."
            )

        # Single-page books fall back to a `main_content.xhtml` body with no
        # lessons / hierarchical TOC. Without an explicit entry the printed
        # toc.xhtml and nav.xhtml would silently drop the only readable page,
        # so synthesize one from the registered main-content chapter.
        if not content_entries and self._has_main_content_page:
            main_chapter = next(
                (ch for ch in self.chapters if ch.file_name == "main_content.xhtml"),
                None,
            )
            if main_chapter is not None:
                content_entries = [
                    {
                        "title": main_chapter.title,
                        "file_name": "main_content.xhtml",
                        "children": [],
                    }
                ]

        # Printed toc.xhtml is the in-book "Table of Contents" page and
        # lists only the readable body of the book: content chapters plus
        # any back-matter sections. Front matter (cover/title/info/
        # dedication/front sections) is intentionally NOT here — those
        # pages come before the printed TOC in the spine and are reached
        # by sequential reading.
        toc_xhtml_entries = [*content_entries, *self._back_section_entries]
        # Fallback for mis-classified single-flow books: if neither content
        # nor main-content was registered but front sections exist, surface
        # those in the printed TOC so the page isn't blank. Nav.xhtml still
        # lists each front_section individually via the chapter walk below.
        if not content_entries and not self._has_main_content_page and self._front_section_entries:
            toc_xhtml_entries = [
                *self._front_section_entries,
                *self._back_section_entries,
            ]

        if self._toc_chapter is not None:
            self._toc_chapter.content = self.render_template(
                "toc_hierarchical.html",
                lessons=toc_xhtml_entries,
                html_lang=self.labels["html_lang"],
                toc_heading=self.labels["toc"],
            )

        # Comprehensive nav.xhtml — every page in the book, in spine order:
        # cover → title → info → dedication → front_section_* → toc →
        # <content tree> → back_section_*. Individual lesson chapters are
        # spliced as the hierarchical content tree at the position of the
        # first lesson; subsequent lessons are skipped (already nested).
        lesson_files = {ch.file_name for ch in self.lesson_chapters}
        main_content_files = (
            {"main_content.xhtml"} if self._has_main_content_page else set()
        )
        nav_entries = []
        content_emitted = False
        for chapter in self.chapters:
            file_name = chapter.file_name
            if file_name in lesson_files or file_name in main_content_files:
                if not content_emitted:
                    nav_entries.extend(content_entries)
                    content_emitted = True
                continue
            nav_entries.append(
                {
                    "title": chapter.title,
                    "file_name": file_name,
                    "children": [],
                }
            )
        if not content_emitted and content_entries:
            nav_entries.extend(content_entries)

        # Backstop: when TOC resolution is ambiguous (duplicate titles or
        # path collisions) `_build_content_entries` can return entries that
        # share a file_name and silently orphan lesson chapters. Append any
        # spine lesson that wasn't represented in the spliced tree so the
        # nav document covers every readable chapter on disk.
        def _collect_file_names(entries):
            files = set()
            for entry in entries:
                fn = entry.get("file_name")
                if fn:
                    files.add(fn)
                files.update(_collect_file_names(entry.get("children") or []))
            return files

        covered_files = _collect_file_names(nav_entries)
        for chapter in self.lesson_chapters:
            if chapter.file_name in covered_files:
                continue
            nav_entries.append(
                {
                    "title": chapter.title,
                    "file_name": chapter.file_name,
                    "children": [],
                }
            )
            covered_files.add(chapter.file_name)

        self.book.toc = tuple(self._entries_to_nav_nodes(nav_entries))
        self.book.spine = [*self.chapters, ("nav", "no")]
        self.book.add_item(epub.EpubNcx())
        self.book.add_item(epub.EpubNav())
        epub.write_epub(os.path.join(self.output_folder, filename), self.book)
        print(f"EPUB saved at {os.path.join(self.output_folder, filename)}")
