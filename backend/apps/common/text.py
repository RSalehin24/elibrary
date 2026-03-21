import re
import unicodedata


def clean_display_text(value):
    if not value:
        return ""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value))).strip()


def normalize_catalog_text(value):
    if not value:
        return ""

    text = clean_display_text(value).lower()
    text = re.sub(r"[^\w\s]", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()
