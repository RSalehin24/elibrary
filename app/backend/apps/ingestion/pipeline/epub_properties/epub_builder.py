import os
import re
from ebooklib import epub
from jinja2 import Environment, FileSystemLoader


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


class EpubBuilder:
    def __init__(self, book_title, author, series="", book_type="", output_folder=""):
        self.book_title = book_title
        self.author = author
        self.series = series
        self.book_type = book_type
        self.output_folder = output_folder
        self.env = Environment(
            loader=FileSystemLoader(os.path.join(os.path.dirname(__file__), "page_templates"))
        )
        self.book = epub.EpubBook()
        self.book.set_title(book_title)
        self.book.set_language("bn")
        self.book.add_author(author)
        self.chapters = []
        self.front_matter_pages = []
        self.back_matter_pages = []
        self.content_pages_by_path = {}
        self.fallback_title_to_page = {}

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
        )

        cover_page = epub.EpubHtml(
            title="কভার",
            file_name="cover_page.xhtml",
            content=html_content,
        )

        self.register_chapter(cover_page, include_in_nav=True, insert_front=True)

    def add_title_page(self):
        html_content = self.render_template(
            "title_page.html",
            book_title=self.book_title,
            author=self.author,
        )
        chapter = epub.EpubHtml(
            title="শিরোনাম পৃষ্ঠা",
            file_name="title.xhtml",
            content=html_content,
        )
        self.register_chapter(chapter, include_in_nav=True)

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
        )
        chapter = epub.EpubHtml(
            title="বই বিষয়ক তথ্য",
            file_name="info.xhtml",
            content=html_content,
        )
        self.register_chapter(chapter, include_in_nav=True)

    def add_dedication_page(self, dedication_title="উৎসর্গ", dedication_html=""):
        html_content = self.render_template(
            "dedication.html",
            dedication_title=dedication_title,
            dedication_html=dedication_html,
        )
        chapter = epub.EpubHtml(
            title="উৎসর্গ",
            file_name="dedication.xhtml",
            content=html_content,
        )
        self.register_chapter(chapter, include_in_nav=True)

    def add_main_content_page(self, main_content):
        if html_is_blank(main_content):
            return
        html_content = self.render_template(
            "main_content.html",
            main_content=main_content,
        )
        chapter = epub.EpubHtml(
            title="প্রস্তাবনা",
            file_name="main_content.xhtml",
            content=html_content,
        )
        self.register_chapter(chapter, include_in_nav=True)

    def add_front_section_pages(self, sections):
        for idx, section in enumerate(sections, start=1):
            title = section.get("title") or f"প্রারম্ভ {idx}"
            content = section.get("html") or ""
            if html_is_blank(content):
                continue
            html_content = self.render_template(
                "lesson.html",
                lesson_title=title,
                lesson_content=content,
            )
            page = epub.EpubHtml(
                title=title,
                file_name=f"front_section_{idx}.xhtml",
                content=html_content,
            )
            self.register_chapter(page, include_in_nav=True)

    def add_back_section_pages(self, sections):
        for idx, section in enumerate(sections, start=1):
            title = section.get("title") or f"সমাপ্তি {idx}"
            content = section.get("html") or ""
            if html_is_blank(content):
                continue
            html_content = self.render_template(
                "lesson.html",
                lesson_title=title,
                lesson_content=content,
            )
            page = epub.EpubHtml(
                title=title,
                file_name=f"back_section_{idx}.xhtml",
                content=html_content,
            )
            self.register_chapter(page, include_in_nav=True, append_back=True)

    def add_toc_page(self, lessons):
        html_content = self.render_template("toc.html", lessons=lessons)
        chapter = epub.EpubHtml(
            title="সূচিপত্র",
            file_name="toc.xhtml",
            content=html_content,
        )
        # The printed সূচিপত্র page sits between front matter and the body in
        # both the spine and the EPUB NAV so that the on-page reading order
        # and the navigation order agree (HTML preview and EPUB must show the
        # same TOC coverage in the same place).
        self.register_chapter(chapter, include_in_nav=True)

    def add_hierarchical_toc_page(self, toc_structure, content_items):
        item_counter = 1
        path_to_file = {}
        fallback_title_to_file = {}

        for item in content_items:
            file_name = f"lesson_{item_counter}.xhtml"
            item_counter += 1
            item_path = content_path_tuple(item.get("path"))
            if item_path:
                path_to_file[item_path] = file_name
            fallback_title_to_file.setdefault(item.get("title"), file_name)

        def build_hierarchical_entries(entries, parent_path=()):
            built_entries = []

            for entry in entries:
                path = resolve_entry_path(entry, parent_path)
                children = build_hierarchical_entries(entry.get("children", []), path)
                file_name = path_to_file.get(path) or fallback_title_to_file.get(
                    entry.get("title")
                )
                built_entries.append(
                    {
                        "title": entry.get("title", ""),
                        "file_name": file_name,
                        "has_children": bool(children),
                        "children": children,
                    }
                )

            return built_entries

        hierarchical_lessons = build_hierarchical_entries(toc_structure)
        html_content = self.render_template(
            "toc_hierarchical.html",
            lessons=hierarchical_lessons,
        )
        chapter = epub.EpubHtml(
            title="সূচিপত্র",
            file_name="toc.xhtml",
            content=html_content,
        )
        # See add_toc_page: the printed Contents page is included in both
        # the spine and the EPUB NAV so that nav order matches reading order.
        self.register_chapter(chapter, include_in_nav=True)

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
            )
            file_name = f"lesson_{idx}.xhtml"
            chapter = epub.EpubHtml(
                title=title,
                file_name=file_name,
                content=html_content,
            )
            self.register_chapter(chapter)
            if path:
                self.content_pages_by_path[path] = chapter
            self.fallback_title_to_page.setdefault(title, chapter)

    def build_navigation_entries(self, toc_structure, parent_path=()):
        entries = []

        for entry in toc_structure:
            path = resolve_entry_path(entry, parent_path)
            chapter = self.content_pages_by_path.get(path) or self.fallback_title_to_page.get(
                entry.get("title", "")
            )
            children = self.build_navigation_entries(entry.get("children", []), path)

            if chapter and children:
                entries.append((chapter, tuple(children)))
            elif chapter:
                entries.append(chapter)
            elif children:
                entries.append((epub.Section(entry.get("title", "")), tuple(children)))

        return entries

    def build_epub(self, filename="book.epub", toc_structure=None):
        filename = safe_epub_filename(filename)
        content_navigation = (
            self.build_navigation_entries(toc_structure or [])
            if toc_structure
            else list(self.content_pages_by_path.values())
        )
        self.book.toc = tuple(self.front_matter_pages + content_navigation + self.back_matter_pages)
        self.book.spine = [*self.chapters, ("nav", "no")]
        self.book.add_item(epub.EpubNcx())
        self.book.add_item(epub.EpubNav())
        epub.write_epub(os.path.join(self.output_folder, filename), self.book)
        print(f"EPUB saved at {os.path.join(self.output_folder, filename)}")
