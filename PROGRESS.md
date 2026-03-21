# Progress Log

## Phase 0: Repo Assessment

Completed:
- Inspected the real repository and confirmed it was a script-first scraper/exporter.
- Mapped the current execution flow from `code/main.py` into `code/scraper.py`, `code/html_book.py`, and `code/epub_book.py`.
- Identified the concrete mismatches:
  - missing tracked `code/config.py`
  - `title` vs `book_title`
  - minimal `.gitignore`
  - no backend/frontend/app structure
  - flat scraped metadata unsuitable as a canonical model

## Phase 1: Platform Foundation

Completed:
- Added Django backend scaffold under `backend/`.
- Added React frontend scaffold under `frontend/`.
- Added environment-based settings.
- Added PostgreSQL/Celery/Redis oriented Docker workflow.
- Added root `.env.example`, `.gitignore`, requirements files, and README.

Remaining:
- Tighten production security settings per deployment environment.

## Phase 2: Scraper and Export Refactor

Completed:
- Preserved `code/` instead of deleting it.
- Added a reusable legacy adapter service in Django.
- Fixed `book_title` usage in the legacy CLI.
- Added tracked config bootstrap in `code/config.py`.
- Added ebanglalibrary URL validation/normalization.
- Kept HTML and EPUB generation working while allowing list/structured metadata values.

Remaining:
- Extract more scraper internals into pure service functions with dedicated fixtures.
- Add deterministic scraper parser tests against saved HTML snapshots.

## Phase 3: Persistence, Submissions, and Jobs

Completed:
- Added models for books, sources, contributors, series, categories, generated assets, metadata reviews/versions, submissions, resolution attempts, candidates, jobs/logs, duplicate reviews, grants, preview sessions, reading sessions, and bookmarks.
- Added Celery task wiring and a management-command wrapper for the legacy batch flow.
- Added title-resolution service scaffolding and duplicate detection paths.
- Added protected asset download and reader-launch endpoints.
- Added database-first submission fulfillment so title and URL requests reuse existing books before creating new ones.
- Added canonical normalization fields plus deduplicating relation sync so repeated author/series/category/type names are not recreated.
- Added submission/auth throttling hooks and tightened reader-state access checks.
- Added token-backed reader session/bookmark endpoints for the external EPUB reader launch flow.
- Added catalog refresh API support for manually refreshing the ebanglalibrary title-resolution index.

Remaining:
- Add richer duplicate merge workflows.
- Add fuller audit enrichment and background catalog refresh scheduling.

## Phase 4: Library and Management UI

Completed:
- Added React pages for library home, login/registration, submission, queue/results, book detail, and access overview.
- Added capability-aware UI gating instead of relying only on `is_staff`.
- Added in-app TOTP setup/confirmation, reader progress/bookmark controls, metadata version visibility, duplicate review actions, and grant management basics.
- Added richer catalog and queue filtering plus saved filters.
- Added metadata review create/update flows in the book-detail experience.
- Added multi-book completion actions after submission intake.

Remaining:
- Staff-grade metadata review UI with richer merge/edit tooling.
- Even richer search facets and reviewer tooling.
- Grant editing and user management screens beyond the current create/revoke flow.

## Blockers / Assumptions

- The checked-in `ebook-scrapper/` virtualenv was used for backend verification because the fresh workspace does not yet have dependencies installed globally.
- The external reader at `/Users/rsalehin24/Documents/epub-reader` was updated to consume backend launch manifests and sync reading progress.
- `docker compose` could not be verified in this environment because the available Docker CLI does not expose the compose subcommand here.

## Exact Next Steps

1. Bring up the Docker stack end to end and validate the worker path against live PostgreSQL/Redis instead of eager-mode local execution.
2. Expand duplicate review into full merge/link/reject workflows with richer evidence and reviewer notes.
3. Add even deeper admin tooling around grants and duplicate merges if the current reviewer screens need more operational power.
4. Change the one-time seeded superadmin password after first sign-in if this environment is going to persist.
