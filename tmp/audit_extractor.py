"""Offline check: run looks_like_contributor_name + split_contributor_value
against the exact defect cases the user reported. Prints a pass/fail row per case.
"""
import os, sys, django
from django.conf import settings as ds
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
os.environ.setdefault("DATABASE_URL", "postgresql://u:p@localhost:5432/x")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app", "backend"))
django.setup()
ds.DATABASES["default"] = {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}

from apps.catalog.models import ContributorRole as R
from apps.ingestion.services.normalization_support.metadata import (
    looks_like_contributor_name,
    split_contributor_value,
    clean_contributor_value,
    trim_publisher_candidate,
)

# (label, role, value, should_be_accepted)
CASES = [
    ("title-fragment as contributor", R.AUTHOR, "২ ছোটগল্প", False),
    ("title-fragment as contributor (translator)", R.TRANSLATOR, "২ ছোটগল্প", False),
    ("sentence as translator", R.TRANSLATOR, "কী ইতিহাসের পাতা থেকে মণিমুক্তো তুলে আনাই হোক", False),
    ("phrase as translator", R.TRANSLATOR, "পাশ্চাত্য দর্শনের ইতিহাস নির্ভর এক অসাধারণ", False),
    ("leading dash publisher", R.PUBLISHER, "– ঐতিহ্য", True),  # after strip becomes 'ঐতিহ্য', valid
    ("leading dash publisher 2", R.PUBLISHER, "– নন্দিত", True),
    ("leading dash publisher 3", R.PUBLISHER, "– নাগরী", True),
    ("leading dash publisher 4", R.PUBLISHER, "– বুনন", True),
    ("address as publisher", R.PUBLISHER, "1 College Row", False),
    ("address as publisher 2", R.PUBLISHER, "3/1 College Row", False),
    ("address as publisher 3", R.PUBLISHER, "Dhaka", False),
    ("address as publisher 4", R.PUBLISHER, "Kolkata 700009", False),
    ("garbage phrase publisher", R.PUBLISHER, "Date of", False),
    ("dangling conj publisher", R.PUBLISHER, "Mitra &", False),
    ("standalone honorific publisher", R.PUBLISHER, "Md", False),
    ("standalone honorific publisher b", R.PUBLISHER, "মো", False),
    ("standalone honorific author", R.AUTHOR, "Md", False),
    ("standalone honorific author b", R.AUTHOR, "মো", False),
    # Positives - should be accepted
    ("good author bangla", R.AUTHOR, "রকিব হাসান", True),
    ("good publisher bangla", R.PUBLISHER, "সেবা প্রকাশনী", True),
    ("good translator", R.TRANSLATOR, "মাহফুজুর রহমান", True),
    ("good publisher english", R.PUBLISHER, "Patra Bharati", True),
    ("good publisher with org keyword", R.PUBLISHER, "ঐতিহ্য", True),
]

print(f"{'CASE':60} {'ROLE':12} {'CLEAN':28} {'ACCEPTED':10} {'WANTED':10} {'RESULT'}")
fail = 0
for label, role, value, want_accept in CASES:
    cleaned = clean_contributor_value(value)
    accepted = looks_like_contributor_name(cleaned, role=role)
    ok = accepted == want_accept
    if not ok:
        fail += 1
    print(f"{label:60} {role:12} {cleaned!r:28} {str(accepted):10} {str(want_accept):10} {'PASS' if ok else 'FAIL'}")

# Test publisher trim from "Patra Bharati at 3/1 College Row, Kolkata 700009"
publisher_full = "Patra Bharati, 3/1 College Row, Kolkata 700009"
trimmed = trim_publisher_candidate(publisher_full)
print(f"\ntrim_publisher_candidate({publisher_full!r}) -> {trimmed}")
split_result = split_contributor_value(publisher_full, role=R.PUBLISHER)
print(f"split_contributor_value({publisher_full!r}, PUBLISHER) -> {split_result}")

publisher_with_by = "PATRA BHARATI at 3/1 College Row"
print(f"split_contributor_value({publisher_with_by!r}, PUBLISHER) -> {split_contributor_value(publisher_with_by, role=R.PUBLISHER)}")

print(f"\nTotal failures: {fail}/{len(CASES)}")
sys.exit(1 if fail else 0)
