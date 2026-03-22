from pathlib import Path

from apps.ingestion.services.legacy_adapter import generate_exports, legacy_modules


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
    html = (Path(tmp_path) / "book.html").read_text(encoding="utf-8")
    assert "cover-placeholder-card" in html


def test_legacy_exports_inline_existing_cover_even_if_requested_extension_is_wrong(tmp_path):
    (Path(tmp_path) / "book_cover.jpg").write_bytes(b"fake-jpg")
    book_data = {
        "book_title": "রূপান্তর",
        "author": "লেখক এক",
        "series": "",
        "book_type": "",
        "cover": "book_cover.jog",
        "main_content": "<p>মূল অংশ</p>",
        "book_info": "",
        "dedication": "",
        "toc": [{"title": "অধ্যায় ১", "type": "lesson", "has_content": True}],
        "content_items": [{"title": "অধ্যায় ১", "content": "<p>বিষয়</p>", "type": "lesson", "parent": None}],
        "output_folder": str(tmp_path),
    }

    generate_exports(book_data)

    html = (Path(tmp_path) / "book.html").read_text(encoding="utf-8")
    assert "data:image/jpeg;base64," in html
    assert "book_cover.jog" not in html


def test_legacy_scraper_extracts_leading_front_matter_without_dedication():
    scraper, _, _ = legacy_modules()
    main_content = """
    <div>
      <p><strong>অনুবাদ</strong>: অনুবাদক এক</p>
      <p><strong>প্রথম প্রকাশ</strong>: জানুয়ারি ২০০১</p>
      <p>এটাই মূল কনটেন্ট।</p>
    </div>
    """

    book_info, dedication, cleaned_content = scraper.extract_dedication(main_content)

    assert "অনুবাদক এক" in book_info
    assert "জানুয়ারি ২০০১" in book_info
    assert dedication == ""
    assert "অনুবাদক এক" not in cleaned_content
    assert "জানুয়ারি ২০০১" not in cleaned_content
    assert "এটাই মূল কনটেন্ট।" in cleaned_content


def test_legacy_scraper_extracts_title_prefixed_translator_and_publication_from_main_content():
    scraper, _, _ = legacy_modules()
    main_content = """
    <div>
      <h2 class="wp-block-heading">ম্যালিস – কিয়েগো হিগাশিনো</h2>
      <p><strong>ম্যালিস – কিয়েগো হিগাশিনো</strong><br/>অনুবাদ: সালমান হক, ইশরাক অর্ণব</p>
      <p>প্রথম প্রকাশ: মার্চ ২০২৩</p>
      <p><strong>ভূমিকা</strong></p>
      <p>এটাই মূল কনটেন্ট।</p>
    </div>
    """

    book_info, dedication, cleaned_content = scraper.extract_dedication(main_content)

    assert "অনুবাদ: সালমান হক, ইশরাক অর্ণব" in book_info
    assert "প্রথম প্রকাশ: মার্চ ২০২৩" in book_info
    assert dedication == ""
    assert "অনুবাদ: সালমান হক, ইশরাক অর্ণব" not in cleaned_content
    assert "প্রথম প্রকাশ: মার্চ ২০২৩" not in cleaned_content
    assert "এটাই মূল কনটেন্ট।" in cleaned_content
