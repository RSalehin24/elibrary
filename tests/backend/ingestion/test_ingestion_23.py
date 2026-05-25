"""Phase F: pure auditor for produced EPUBs.

Builds real EPUB files via ``EpubBuilder`` and verifies
``audit_epub_structure`` distinguishes well-formed from broken outputs.
"""
from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from apps.ingestion.pipeline.epub_book import create_epub
from apps.ingestion.pipeline.epub_properties.epub_builder import EpubBuilder
from apps.ingestion.pipeline.epub_structure_audit import (
    _classify_slot,
    audit_epub_structure,
)


def _minimal_book_payload(tmp_path: Path) -> dict:
    return {
        "book_title": "পরীক্ষা",
        "author": "পরীক্ষক",
        "series": "",
        "book_type": "",
        "cover": "",
        "main_content": "",
        "book_info": "<p>বইয়ের তথ্য</p>",
        "dedication": "<p>উৎসর্গ</p>",
        "front_sections": [{"title": "ভূমিকা", "html": "<p>শুরু</p>"}],
        "back_sections": [{"title": "পরিশিষ্ট", "html": "<p>শেষ</p>"}],
        "toc": [
            {"title": "অধ্যায় ১", "path": ["অধ্যায় ১"], "children": []},
            {"title": "অধ্যায় ২", "path": ["অধ্যায় ২"], "children": []},
        ],
        "content_items": [
            {"title": "অধ্যায় ১", "content": "<p>প্রথম অধ্যায়</p>", "path": ["অধ্যায় ১"]},
            {"title": "অধ্যায় ২", "content": "<p>দ্বিতীয় অধ্যায়</p>", "path": ["অধ্যায় ২"]},
        ],
        "output_folder": str(tmp_path),
    }


def test_classify_slot_recognises_known_filenames():
    assert _classify_slot("cover_page.xhtml") == "cover"
    assert _classify_slot("title.xhtml") == "title"
    assert _classify_slot("info.xhtml") == "info"
    assert _classify_slot("dedication.xhtml") == "dedication"
    assert _classify_slot("toc.xhtml") == "toc"
    assert _classify_slot("nav.xhtml") == "nav"
    assert _classify_slot("front_section_3.xhtml") == "front"
    assert _classify_slot("back_section_1.xhtml") == "back"
    assert _classify_slot("lesson_12.xhtml") == "content"
    assert _classify_slot("main_content.xhtml") == "content"
    assert _classify_slot("strange.xhtml") is None


def test_audit_accepts_well_formed_epub(tmp_path):
    payload = _minimal_book_payload(tmp_path)
    create_epub(payload)
    epub_path = next(tmp_path.glob("*.epub"))

    result = audit_epub_structure(epub_path)

    assert result.ok, result.errors
    # cover → title → info → dedication → front → toc → content → back → nav
    assert result.spine_slots[0] == "cover"
    assert "title" in result.spine_slots
    assert "toc" in result.spine_slots
    assert "content" in result.spine_slots
    assert result.spine_slots[-1] == "nav"
    # nav and toc list the same files
    assert result.nav_hrefs and result.toc_hrefs
    assert [h.rsplit("/", 1)[-1] for h in result.nav_hrefs] == [
        h.rsplit("/", 1)[-1] for h in result.toc_hrefs
    ]


def test_audit_flags_missing_file(tmp_path):
    result = audit_epub_structure(tmp_path / "missing.epub")
    assert not result.ok
    assert any("does not exist" in err for err in result.errors)


def test_audit_flags_blank_content_page(tmp_path):
    # Hand-build an EPUB whose lesson_1.xhtml has only markup, no visible text.
    builder = EpubBuilder(book_title="ফাঁকা", author="-", output_folder=str(tmp_path))
    builder.add_generated_cover_page()
    builder.add_title_page()
    builder.add_hierarchical_toc_page(
        [{"title": "অধ্যায় ১", "path": ["অধ্যায় ১"], "children": []}],
        [{"title": "অধ্যায় ১", "content": "&nbsp;", "path": ["অধ্যায় ১"]}],
    )
    builder.add_lesson_pages(
        [{"title": "অধ্যায় ১", "content": "&nbsp;", "path": ["অধ্যায় ১"]}]
    )
    builder.build_epub(filename="blank.epub")

    epub_path = tmp_path / "blank.epub"
    # Overwrite lesson_1.xhtml with pure whitespace inside the zip to force a
    # blank-page detection (the template renders the title h1 which would
    # otherwise count as visible text).
    _replace_in_epub(epub_path, "lesson_1.xhtml", "<html><body>   </body></html>")

    result = audit_epub_structure(epub_path)
    assert not result.ok
    assert any("blank content" in err for err in result.errors), result.errors


def test_audit_flags_nav_self_link(tmp_path):
    payload = _minimal_book_payload(tmp_path)
    create_epub(payload)
    epub_path = next(tmp_path.glob("*.epub"))
    nav_self = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops">'
        '<head><title>nav</title></head><body>'
        '<nav epub:type="toc"><ol>'
        '<li><a href="nav.xhtml">Self</a></li>'
        '</ol></nav></body></html>'
    )
    _replace_in_epub(epub_path, "nav.xhtml", nav_self)

    result = audit_epub_structure(epub_path)
    assert not result.ok
    assert any("links to itself" in err for err in result.errors)


def _replace_in_epub(epub_path: Path, target_name: str, new_content: str) -> None:
    """Rewrite ``target_name`` inside the EPUB zip with ``new_content``."""
    import io
    import shutil

    tmp_path = epub_path.with_suffix(".tmp")
    with zipfile.ZipFile(epub_path, "r") as src, zipfile.ZipFile(
        tmp_path, "w", zipfile.ZIP_DEFLATED
    ) as dest:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename.endswith("/" + target_name) or item.filename.rsplit("/", 1)[-1] == target_name:
                data = new_content.encode("utf-8")
            dest.writestr(item, data)
    shutil.move(str(tmp_path), str(epub_path))
