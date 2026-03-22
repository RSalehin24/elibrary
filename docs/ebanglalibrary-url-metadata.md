# ebanglalibrary URL Metadata

This note documents the URL patterns and metadata sources currently used by the Bangla Library ingestion flow.

## Canonical book URL

- Canonical pattern: `https://www.ebanglalibrary.com/books/<slug>/`
- Only `/books/` URLs are accepted for direct ingestion.
- Input URLs are normalized to:
  - `https`
  - host `www.ebanglalibrary.com`
  - trailing slash

## Reliable metadata order

When a direct book URL is available, the system now prefers metadata from the book page itself before depending on archive-list text.

Metadata lookup order:

1. Direct book page URL
2. Stored `SourceCatalogEntry` metadata
3. Archive listing text from `/books/`
4. Full legacy scrape during processing

## Book page metadata

The following fields are read directly from the book page:

- Title:
  - primary source: the HTML `<title>`
  - split on separators like ` - `, ` – `, or ` — `
- Author:
  - primary source: `.entry-meta.entry-meta-after-content .entry-terms-authors`
  - fallback: author text from the `<title>`
- Series:
  - `.entry-meta.entry-meta-after-content .entry-terms-series`
- Category:
  - `.entry-meta.entry-meta-after-content .entry-terms-ld_course_category`
- Canonical URL:
  - `<link rel="canonical">` when present
  - otherwise the normalized input URL

This metadata is stored into `SourceCatalogEntry.raw_data` with `metadata_source="book_page"`.

## Archive discovery URLs

The archive listing lives at:

- `https://www.ebanglalibrary.com/books/`

Observed query parameters:

- `_a_z=<bucket>`
  - filters the archive by the first useful query character
- `_paged=<page>`
  - pagination for archive results

The archive pages are still useful for discovery, but the listing text is now treated as less trustworthy than the book page itself.

## Lesson pagination URLs

The legacy scraper loads lesson pages with:

- `?ld-courseinfo-lesson-page=<page_number>`

These are used during full content scraping, not during lightweight metadata lookup.

## Current implementation impact

- Direct URL submissions store source-page metadata as soon as the URL is accepted.
- Title resolution enriches top archive candidates by reading the candidate book pages directly.
- If Celery/Redis dispatch fails, ingestion falls back to inline processing so Redis connection errors do not block book creation outright.
