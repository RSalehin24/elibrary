import os
from ebooklib import epub
from jinja2 import Environment, FileSystemLoader

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

    def render_template(self, template_name, **context):
        template = self.env.get_template(template_name)
        return template.render(**context)

    def add_cover_page(self, cover_image_path):
        image_name = os.path.basename(cover_image_path)
        
        self.book.set_cover(image_name, open(cover_image_path, "rb").read())
        
        html_content = self.render_template(
            "cover_page.html",
            cover_image=image_name
        )
        
        cover_page = epub.EpubHtml(
            title="কভার",
            file_name="cover_page.xhtml",
            content=html_content
        )

        self.book.add_item(cover_page)
        self.chapters.insert(0, cover_page)

    def add_title_page(self):
        html_content = self.render_template("title_page.html", book_title=self.book_title, author=self.author)
        c = epub.EpubHtml(title="শিরোনাম পৃষ্ঠা", file_name="title.xhtml", content=html_content)
        self.book.add_item(c)
        self.chapters.append(c)

    def add_info_page(self, translator="", additional_info="", scraped_book_info=""):
        """
        Add info page. If scraped_book_info is provided (extracted from main content),
        it will be used instead of the default template-based info.
        """
        html_content = self.render_template(
            "info_page.html",
            book_title=self.book_title,
            author=self.author,
            translator=translator,
            series=self.series,
            book_type=self.book_type,
            additional_info=additional_info,
            scraped_book_info=scraped_book_info,
            scrapped_data=not scraped_book_info  # Use template if no scraped info
        )
        c = epub.EpubHtml(title="বই বিষয়ক তথ্য", file_name="info.xhtml", content=html_content)
        self.book.add_item(c)
        self.chapters.append(c)

    def add_dedication_page(self, dedication_text=""):
        html_content = self.render_template("dedication.html", dedication_text=dedication_text)
        c = epub.EpubHtml(title="উৎসর্গ", file_name="dedication.xhtml", content=html_content)
        self.book.add_item(c)
        self.chapters.append(c)
        
    def add_main_content_page(self, main_content):
        html_content = self.render_template("main_content.html", main_content=main_content)
        c = epub.EpubHtml(title="প্রস্তাবনা", file_name="main_content.xhtml", content=html_content)
        self.book.add_item(c)
        self.chapters.append(c)

    def add_toc_page(self, lessons):
        """
        Add table of contents page.
        lessons can be either:
        - List of tuples: [(title, file_name), ...]
        - Hierarchical structure with lessons and topics
        """
        html_content = self.render_template("toc.html", lessons=lessons)
        c = epub.EpubHtml(title="সূচিপত্র", file_name="toc.xhtml", content=html_content)
        self.book.add_item(c)
        self.chapters.append(c)

    def add_hierarchical_toc_page(self, toc_structure, content_items):
        """
        Add hierarchical table of contents page.
        
        Args:
            toc_structure: Hierarchical TOC from scraper
            content_items: List of content item dictionaries
        """
        # Build hierarchical lessons structure for template
        hierarchical_lessons = []
        item_counter = 1
        
        # Create a mapping of titles to file names
        title_to_file = {}
        for item in content_items:
            title_to_file[item["title"]] = f"lesson_{item_counter}.xhtml"
            item_counter += 1
        
        for entry in toc_structure:
            if entry.get("children"):
                # Lesson with topics
                lesson_entry = {
                    "title": entry["title"],
                    "has_children": True,
                    "children": []
                }
                for child in entry["children"]:
                    lesson_entry["children"].append({
                        "title": child["title"],
                        "file_name": title_to_file.get(child["title"], "#")
                    })
                hierarchical_lessons.append(lesson_entry)
            else:
                # Standalone lesson
                hierarchical_lessons.append({
                    "title": entry["title"],
                    "file_name": title_to_file.get(entry["title"], "#"),
                    "has_children": False
                })
        
        html_content = self.render_template("toc_hierarchical.html", lessons=hierarchical_lessons)
        c = epub.EpubHtml(title="সূচিপত্র", file_name="toc.xhtml", content=html_content)
        self.book.add_item(c)
        self.chapters.append(c)

    def add_lesson_pages(self, lessons):
        """
        Add lesson pages.
        lessons: List of tuples [(title, content), ...]
        """
        for idx, (title, content) in enumerate(lessons, start=1):
            html_content = self.render_template("lesson.html", lesson_title=title, lesson_content=content)
            file_name = f"lesson_{idx}.xhtml"
            c = epub.EpubHtml(title=title, file_name=file_name, content=html_content)
            self.book.add_item(c)
            self.chapters.append(c)

    def build_epub(self, filename="book.epub"):
        self.book.toc = tuple(self.chapters)
        self.book.spine = self.chapters
        self.book.add_item(epub.EpubNcx())
        self.book.add_item(epub.EpubNav())
        epub.write_epub(os.path.join(self.output_folder, filename), self.book)
        print(f"EPUB saved at {os.path.join(self.output_folder, filename)}")
