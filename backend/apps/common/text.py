import re
import unicodedata


def clean_display_text(value):
    if not value:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def _is_textual_slug_character(char):
    category = unicodedata.category(char)
    return category.startswith(("L", "N", "M"))


def _collapse_separators(value, separator=" "):
    pattern = re.escape(separator) + r"+"
    return re.sub(pattern, separator, value).strip(separator)


def normalize_catalog_text(value):
    if not value:
        return ""

    text = unicodedata.normalize("NFKC", clean_display_text(value)).lower()
    normalized = []
    for char in text:
        if char.isspace():
            normalized.append(" ")
            continue
        if _is_textual_slug_character(char):
            normalized.append(char)

    return _collapse_separators("".join(normalized), " ")


def unicode_slugify(value):
    if not value:
        return ""

    text = unicodedata.normalize("NFKC", clean_display_text(value)).lower()
    slug = []
    previous_was_separator = False

    for char in text:
        if _is_textual_slug_character(char):
            slug.append(char)
            previous_was_separator = False
            continue
        if char in {" ", "-", "_", "/", "|", ":", "–", "—"}:
            if slug and not previous_was_separator:
                slug.append("-")
                previous_was_separator = True

    return _collapse_separators("".join(slug), "-")
