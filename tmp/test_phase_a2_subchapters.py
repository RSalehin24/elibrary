"""Phase A.2 smoke test: expand_content_items_with_subchapters."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "app", "backend"))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django  # noqa: E402

django.setup()

from apps.ingestion.services.normalization import (  # noqa: E402
    expand_content_items_with_subchapters,
)


def _content(html_parts):
    return "\n".join(html_parts)


def test_splits_lesson_with_multiple_h2():
    item = {
        "title": "Chapter One",
        "type": "lesson",
        "content": _content([
            "<p>This is an opening paragraph that should be the parent intro because it is long enough to count as substantial body text that the reader deserves to see before the first sub-heading appears in the chapter.</p>",
            "<h2>First Section</h2>",
            "<p>Content for the first section. This text exists so the section is non-trivial.</p>",
            "<h2>Second Section</h2>",
            "<p>Content for the second section. Also non-trivial body text for the reader.</p>",
            "<h2>Third Section</h2>",
            "<p>Third section body text large enough to pass the body threshold.</p>",
        ]),
    }
    toc = [{"title": "Chapter One", "type": "lesson", "has_content": True, "path": ["Chapter One"]}]
    new_toc, new_items = expand_content_items_with_subchapters(toc, [item])
    assert len(new_items) == 4, f"expected parent + 3 subs, got {len(new_items)}"
    assert new_items[0]["title"] == "Chapter One"
    assert new_items[0]["content"], "expected parent to retain intro paragraph"
    assert [it["title"] for it in new_items[1:]] == ["First Section", "Second Section", "Third Section"]
    for sub in new_items[1:]:
        assert sub["parent"] == "Chapter One"
        assert sub["path"][0] == "Chapter One"
    entry = new_toc[0]
    assert len(entry["children"]) == 3
    assert [c["title"] for c in entry["children"]] == ["First Section", "Second Section", "Third Section"]


def test_no_split_when_only_one_h2():
    item = {
        "title": "Solo",
        "type": "lesson",
        "content": "<h2>Only Heading</h2><p>Some body text that is long enough to matter.</p>",
    }
    toc = [{"title": "Solo", "type": "lesson", "has_content": True, "path": ["Solo"]}]
    new_toc, new_items = expand_content_items_with_subchapters(toc, [item])
    assert new_items == [item]
    assert "children" not in new_toc[0] or not new_toc[0].get("children")


def test_falls_back_to_h3_when_no_h2():
    item = {
        "title": "Mixed",
        "type": "lesson",
        "content": _content([
            "<h3>Alpha</h3>",
            "<p>Body text for alpha section that needs to be long enough.</p>",
            "<h3>Beta</h3>",
            "<p>Body text for beta section that needs to be long enough.</p>",
        ]),
    }
    toc = [{"title": "Mixed", "type": "lesson", "has_content": True, "path": ["Mixed"]}]
    new_toc, new_items = expand_content_items_with_subchapters(toc, [item])
    assert [it["title"] for it in new_items[1:]] == ["Alpha", "Beta"]


def test_does_not_split_headings_inside_blockquote():
    item = {
        "title": "Quoted",
        "type": "lesson",
        "content": _content([
            "<blockquote><h2>Quoted A</h2><p>x</p><h2>Quoted B</h2><p>y</p></blockquote>",
        ]),
    }
    toc = [{"title": "Quoted", "type": "lesson", "has_content": True, "path": ["Quoted"]}]
    new_toc, new_items = expand_content_items_with_subchapters(toc, [item])
    assert new_items == [item]


def test_short_preamble_dropped_from_parent():
    item = {
        "title": "Short Intro",
        "type": "lesson",
        "content": _content([
            "<p>Hi.</p>",  # too short to keep as parent intro
            "<h2>One</h2><p>First sub body text long enough.</p>",
            "<h2>Two</h2><p>Second sub body text long enough.</p>",
        ]),
    }
    toc = [{"title": "Short Intro", "type": "lesson", "has_content": True, "path": ["Short Intro"]}]
    new_toc, new_items = expand_content_items_with_subchapters(toc, [item])
    assert len(new_items) == 3
    assert new_items[0]["content"] == ""  # short preamble dropped
    assert new_toc[0]["has_content"] is False


def test_existing_children_left_alone():
    items = [
        {"title": "Parent", "type": "lesson", "content": ""},
        {"title": "Kid 1", "type": "topic", "parent": "Parent", "content": "<p>k1</p>"},
        {"title": "Kid 2", "type": "topic", "parent": "Parent", "content": "<p>k2</p>"},
    ]
    toc = [
        {
            "title": "Parent",
            "type": "lesson",
            "has_content": False,
            "path": ["Parent"],
            "children": [
                {"title": "Kid 1", "type": "topic", "has_content": True, "path": ["Parent", "Kid 1"]},
                {"title": "Kid 2", "type": "topic", "has_content": True, "path": ["Parent", "Kid 2"]},
            ],
        }
    ]
    new_toc, new_items = expand_content_items_with_subchapters(toc, items)
    assert new_items == items
    assert len(new_toc[0]["children"]) == 2


if __name__ == "__main__":
    tests = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"OK  {t.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {t.__name__}: {exc}")
    if failed:
        sys.exit(1)
    print(f"\n{len(tests)} smoke tests passed.")
