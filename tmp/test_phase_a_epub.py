"""Standalone smoke test for Phase A.1 changes — runnable with the host
Python without spinning up Docker/Django. Asserts:

1. Printed toc.xhtml is mandatory and rendered with lazy body.
2. nav.xhtml entries == printed toc.xhtml entries (same hrefs/titles).
3. nav.xhtml does NOT include front matter (cover/title/info/dedication/front_section)
   nor a self-link to toc.xhtml.
4. nav.xhtml is in the spine with linear="no".
5. EpubContentMissingError raised when no content registered.
6. Back sections appear in both printed toc.xhtml and nav.xhtml.

Run: PYTHONPATH=app/backend python3 tmp/test_phase_a_epub.py
"""
from __future__ import annotations

import io
import re
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app" / "backend"))

from apps.ingestion.pipeline.epub_properties.epub_builder import (
    EpubBuilder,
    EpubContentMissingError,
)


def _hrefs(html: str) -> list[str]:
    return re.findall(r'href="([^"]+)"', html)


def build_sample(tmp: Path) -> Path:
    b = EpubBuilder(book_title="ফেজ এ", author="পরীক্ষা", output_folder=str(tmp))
    b.add_generated_cover_page()
    b.add_title_page()
    b.add_info_page(scraped_book_info="<p>প্রকাশক — নমুনা</p>")
    b.add_dedication_page(dedication_html="<p>উৎসর্গ</p>")
    b.add_front_section_pages([{"title": "ভূমিকা", "html": "<p>প্রাথমিক কথা</p>"}])
    b.add_hierarchical_toc_page(
        toc_structure=[
            {"title": "অধ্যায় ১", "path": ["অধ্যায় ১"], "children": []},
            {"title": "অধ্যায় ২", "path": ["অধ্যায় ২"], "children": []},
        ],
        content_items=[
            {"title": "অধ্যায় ১", "path": ["অধ্যায় ১"], "content": "<p>এক</p>"},
            {"title": "অধ্যায় ২", "path": ["অধ্যায় ২"], "content": "<p>দুই</p>"},
        ],
    )
    b.add_lesson_pages([
        {"title": "অধ্যায় ১", "path": ["অধ্যায় ১"], "content": "<p>এক</p>"},
        {"title": "অধ্যায় ২", "path": ["অধ্যায় ২"], "content": "<p>দুই</p>"},
    ])
    b.add_back_section_pages([{"title": "পরিশিষ্ট", "html": "<p>শেষ কথা</p>"}])
    b.build_epub("sample.epub", toc_structure=[
        {"title": "অধ্যায় ১", "path": ["অধ্যায় ১"], "children": []},
        {"title": "অধ্যায় ২", "path": ["অধ্যায় ২"], "children": []},
    ])
    return tmp / "sample.epub"


def main() -> int:
    failures = []
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        path = build_sample(tmp)
        assert path.exists(), "EPUB not written"

        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            nav = zf.read("EPUB/nav.xhtml").decode("utf-8")
            toc = zf.read("EPUB/toc.xhtml").decode("utf-8")
            opf = zf.read("EPUB/content.opf").decode("utf-8")

        # 1. Printed toc.xhtml exists and was populated
        if "EPUB/toc.xhtml" not in names:
            failures.append("toc.xhtml missing")
        if "অধ্যায় ১" not in toc or "অধ্যায় ২" not in toc:
            failures.append("printed toc.xhtml missing chapter titles")
        if "পরিশিষ্ট" not in toc:
            failures.append("printed toc.xhtml missing back-section entry")

        # 2. nav/toc parity
        nav_hrefs = [h for h in _hrefs(nav) if not h.startswith("#") and not h.startswith("http")]
        toc_hrefs = [h for h in _hrefs(toc) if not h.startswith("#") and not h.startswith("http")]
        if nav_hrefs != toc_hrefs:
            failures.append(f"nav/toc href mismatch:\n  nav={nav_hrefs}\n  toc={toc_hrefs}")

        # 3. nav.xhtml MUST NOT contain front matter or self-link
        forbidden = ["cover_page.xhtml", "title.xhtml", "info.xhtml", "dedication.xhtml",
                     "front_section_1.xhtml", "toc.xhtml"]
        leaks = [h for h in nav_hrefs if h in forbidden]
        if leaks:
            failures.append(f"nav.xhtml leaks front/self entries: {leaks}")

        # 4. nav linear=no in spine
        if 'idref="nav" linear="no"' not in opf and 'linear="no" idref="nav"' not in opf:
            failures.append("nav not marked linear='no' in spine")

        # 5. EpubContentMissingError on empty
        empty_builder = EpubBuilder(book_title="ফাঁকা", author="-", output_folder=tmp_str)
        empty_builder.add_title_page()
        empty_builder.add_hierarchical_toc_page(toc_structure=[], content_items=[])
        try:
            empty_builder.build_epub("empty.epub", toc_structure=[])
        except EpubContentMissingError:
            pass
        else:
            failures.append("EpubContentMissingError not raised for empty content")

        # 6. Back section in nav
        if "back_section_1.xhtml" not in nav_hrefs:
            failures.append("back section not in nav.xhtml")

    if failures:
        print("FAIL:")
        for f in failures:
            print("  -", f)
        return 1
    print("PASS — all Phase A.1 invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
