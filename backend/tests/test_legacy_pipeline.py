from pathlib import Path

from apps.ingestion.services.legacy_adapter import generate_exports


def test_legacy_exports_support_structured_display_values(tmp_path):
    book_data = {
        "book_title": "রূপান্তর",
        "author": [{"name": "লেখক এক"}, {"name": "লেখক দুই"}],
        "series": [{"title": "সিরিজ এক"}],
        "book_type": [{"name": "উপন্যাস"}],
        "cover": "",
        "main_content": "<p>মূল অংশ</p>",
        "book_info": "<p>তথ্য</p>",
        "dedication": "<p>উৎসর্গ</p>",
        "toc": [{"title": "অধ্যায় ১", "type": "lesson", "has_content": True}],
        "content_items": [{"title": "অধ্যায় ১", "content": "<p>বিষয়</p>", "type": "lesson", "parent": None}],
        "output_folder": str(tmp_path),
    }

    generate_exports(book_data)

    assert (Path(tmp_path) / "book.html").exists()
    assert (Path(tmp_path) / "রূপান্তর.epub").exists()
