from apps.catalog.models import Book, ContributorRole
from apps.common.text import normalize_catalog_text


def normalized_role_names(normalized_scraped, role):
    return {
        normalize_catalog_text(entry["name"])
        for entry in normalized_scraped.get("contributors", [])
        if entry.get("role") == role and normalize_catalog_text(entry.get("name", ""))
    }


def normalized_value_set(values):
    return {normalize_catalog_text(value) for value in values if normalize_catalog_text(value)}


def related_role_names(book, role):
    return {
        normalize_catalog_text(relation.contributor.name)
        for relation in book.book_contributors.all()
        if relation.role == role and normalize_catalog_text(relation.contributor.name)
    }


def related_category_names(book):
    return {
        normalize_catalog_text(relation.category.name)
        for relation in book.book_categories.all()
        if normalize_catalog_text(relation.category.name)
    }


def related_series_names(book):
    return {
        normalize_catalog_text(relation.series.name)
        for relation in book.book_series.all()
        if normalize_catalog_text(relation.series.name)
    }


def detect_metadata_duplicate(scraped_data, *, normalize_scraped_book_fn, texts_are_similar_fn):
    target_title = scraped_data.get("book_title", "")
    normalized_scraped = normalize_scraped_book_fn(scraped_data)
    target_author_names = normalized_role_names(normalized_scraped, ContributorRole.AUTHOR)
    target_translator_names = normalized_role_names(normalized_scraped, ContributorRole.TRANSLATOR)
    target_category_names = normalized_value_set(normalized_scraped.get("categories", []))
    target_series_names = normalized_value_set(normalized_scraped.get("series", []))

    if not target_title:
        return None

    books = Book.objects.filter(deleted_at__isnull=True).prefetch_related(
        "book_contributors__contributor",
        "book_categories__category",
        "book_series__series",
    )
    for book in books:
        if not texts_are_similar_fn(target_title, book.title):
            continue

        existing_author_names = related_role_names(book, ContributorRole.AUTHOR)
        existing_translator_names = related_role_names(book, ContributorRole.TRANSLATOR)
        existing_category_names = related_category_names(book)
        existing_series_names = related_series_names(book)

        if not target_author_names or not existing_author_names:
            continue
        if not target_category_names or not existing_category_names:
            continue
        if not (target_category_names & existing_category_names):
            continue
        if target_series_names and not (target_series_names & existing_series_names):
            continue
        if target_translator_names and not (target_translator_names & existing_translator_names):
            continue
        if target_author_names & existing_author_names:
            return book

    return None


def find_exact_existing_book(scraped_data, *, normalize_scraped_book_fn):
    normalized_title = normalize_catalog_text(scraped_data.get("book_title", ""))
    if not normalized_title:
        return None

    candidate_books = (
        Book.objects.filter(
            source_site="ebanglalibrary.com",
            normalized_title=normalized_title,
            deleted_at__isnull=True,
        )
        .prefetch_related(
            "book_contributors__contributor",
            "book_categories__category",
            "book_series__series",
        )
        .order_by("-created_at")
    )

    normalized_scraped = normalize_scraped_book_fn(scraped_data)
    target_author_names = normalized_role_names(normalized_scraped, ContributorRole.AUTHOR)
    target_translator_names = normalized_role_names(normalized_scraped, ContributorRole.TRANSLATOR)
    target_category_names = normalized_value_set(normalized_scraped.get("categories", []))
    target_series_names = normalized_value_set(normalized_scraped.get("series", []))

    if not target_author_names or not target_category_names:
        return None

    for book in candidate_books:
        existing_author_names = related_role_names(book, ContributorRole.AUTHOR)
        existing_translator_names = related_role_names(book, ContributorRole.TRANSLATOR)
        existing_category_names = related_category_names(book)
        existing_series_names = related_series_names(book)

        if not existing_author_names or not existing_category_names:
            continue
        if not (target_category_names & existing_category_names):
            continue
        if target_series_names and not (target_series_names & existing_series_names):
            continue
        if target_translator_names and not (target_translator_names & existing_translator_names):
            continue
        if target_author_names & existing_author_names:
            return book

    return None


def find_existing_matching_book(book_title, normalized_scraped):
    """Return a live (non-deleted) Book that represents the same work.

    Matching rules:
    - Must share the same normalised title and source site.
    - Must share at least one author name.  If the incoming data has no
      author information the match is skipped (safer to create a new record
      than to accidentally merge unrelated books).
    - If *both* the incoming data *and* the candidate have translator names,
      they must share at least one translator; otherwise they are treated as
      different editions and the candidate is skipped.

    Returns the first matching Book, or None if no safe match is found.
    """
    normalized_title = normalize_catalog_text(book_title or "")
    if not normalized_title:
        return None

    target_author_names = normalized_role_names(normalized_scraped, ContributorRole.AUTHOR)
    if not target_author_names:
        # Cannot determine authorship — refuse to merge to avoid false positives.
        return None

    target_translator_names = normalized_role_names(normalized_scraped, ContributorRole.TRANSLATOR)

    candidates = (
        Book.objects.filter(
            source_site="ebanglalibrary.com",
            normalized_title=normalized_title,
            deleted_at__isnull=True,
        )
        .prefetch_related("book_contributors__contributor")
        .order_by("-created_at")
    )

    for book in candidates:
        existing_author_names = related_role_names(book, ContributorRole.AUTHOR)
        existing_translator_names = related_role_names(book, ContributorRole.TRANSLATOR)

        # Different author → different book entirely.
        if existing_author_names and not (target_author_names & existing_author_names):
            continue

        # Both sides have translator info but no overlap → different edition.
        if target_translator_names and existing_translator_names:
            if not (target_translator_names & existing_translator_names):
                continue

        return book

    return None
