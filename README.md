# Bangla Library Platform

Monorepo for the Bangla ebook platform. The platform scrapes, processes, and serves Bangla (and English) ebooks from [ebanglalibrary.com](https://www.ebanglalibrary.com), producing well-structured EPUB and HTML books for an authenticated library of users.

## Stack

- Backend: Django + Celery in [app/backend](app/backend)
- Frontend: React + Vite in [app/frontend](app/frontend)
- Infrastructure: Docker Compose for local and deployed services, host Nginx + Certbot for the remote edge

## Features

### EPUB Generation Pipeline

- Scrapes book content, cover image, metadata, TOC, and chapters from ebanglalibrary.com.
- Produces a structured EPUB with a fixed page order: cover → title → book information → dedication → front sections → table of contents → chapters → end sections.
- Generates a programmatic dark-mode cover when no source cover image exists.
- Detects book language (Bengali / English) and applies the correct field labels throughout.
- Extracts and orders structured book information (title, author, translator, editor, publisher, series, category, ISBN, price, edition, etc.) from wherever it appears in the scraped content.
- Identifies and isolates dedication text, front-matter prose, and inline TOC sections separately from chapter content.
- Unnamed front-matter prose renders with no page heading and appears in the nav as `পূর্বকথা` (Bengali) or `Preliminary Note` (English).
- Preserves nested chapter and sub-chapter structure in both the NAV and the printed TOC page.
- Inline plain-text TOC sections are dropped when a real linked TOC exists to avoid duplication.

### Book Processing Pipeline

- URL-based submission system: users submit a source book URL and the backend runs scraping, resolution, and EPUB creation as a Celery pipeline.
- Processing queue with `queued → processing → ready` lifecycle; supports stop, resume, retry, and recreate at every stage.
- Duplicate detection surfaces possible matches before creating a new local book, with `New`, `New Edition`, or `Duplicate` (confirm match) resolution options.
- Manual book creation: operators can create catalog entries without a source URL and attach metadata, cover images, and file assets directly.

### Catalog Sync and Automation

- Catalog sync reconciles ebanglalibrary.com book listings against the local database.
- Manual sync and automated scheduled sync share the same catalog runtime so they never run in parallel.
- Pause and resume with durable page-level checkpoints.
- Incomplete book tracking: a dedicated automation run identifies books still marked unfinished on the source site and queues them for reprocessing.
- Post-sync request creation creates initial processing requests only for catalog records that have never been processed.

### Library and Reader

- Searchable library with filter by category, series, and writer.
- In-browser HTML reader and EPUB download.
- Kindle delivery: users can configure Kindle email addresses and send books directly.
- Bookmarks and metadata editing from the book detail page.

### Access Control

- Granular per-book permission grants: preview once, durable read, download, edit metadata, manage processing, manage access, and full admin.
- Time-limited grants with optional expiry.
- Users & Access management page for inviting and managing library members.

### Authentication

- Email-based login with invite-only account creation.
- Mandatory TOTP two-factor authentication gate: accounts flagged `totp_required` are forced through `/two-factor-setup` before accessing any protected route.
- Self-service password reset with 6-hour link expiry; older reset links are invalidated when a new one is requested.
- Setup email resend for onboarding-pending accounts; each resend invalidates earlier invite links.

### Metadata Normalization

- Contributor name validation and cleaning with layered Bengali and English rules.
- Duplicate contributor cleanup, orphan contributor sweeping, and `repair_ebangla_metadata` management command.
- Book information rendered in a canonical field order using `format_book_info_html_ordered`.

### Testing and Regression

- Backend pytest suite covering authentication, access grants, catalog management, and the full ingestion pipeline.
- Frontend unit tests for activity tracking, request formatting, and job filter helpers.
- 24 live Playwright browser stories run against the real Dockerized local application.
- 300-book EPUB structure regression harness (`tests/scripts/regression_curate_300.sh`) with resumable state and structural invariant assertions.

## Repository Layout

- `app/`: application source code for backend and frontend
- `tests/`: backend and browser test suites at the repo root
- `local/`: local Compose, Dockerfiles, env templates, and developer scripts
- `deploy/`: deployment Compose, Dockerfiles, env templates, and remote automation scripts
- `migration/`: database migration scripts for moving data between environments
- `logs/`: local and remote log streaming plus captured log files
- `docs/`: architecture specs, operations guides, and processing reference docs
- `app/backend/storage/`: the runtime storage location for static files, uploads, generated books, and scraped exports
- `automation/`: shared shell and env helpers used by local, deploy, and log automation
- `tests/README.md`: test suite overview, coverage map, and script guide

## Primary Workflows

- Local development: [docs/operations/local-development.md](docs/operations/local-development.md)
- Deployment automation: [docs/operations/deployment.md](docs/operations/deployment.md)
- Log viewing: [docs/operations/log-viewing.md](docs/operations/log-viewing.md)

## Key Commands

- `local/scripts/generate-env.sh`
- `deploy/scripts/generate-env.sh production`
- `deploy/scripts/generate-env.sh host`
- `local/scripts/dev.sh up`
- `tests/scripts/seed-e2e-data.sh`
- `tests/scripts/test-all.sh`
- `tests/scripts/test-backend.sh`
- `tests/scripts/test-frontend-unit.sh`
- `tests/scripts/test-e2e.sh`
- `tests/scripts/verify.sh --repeat 3`
- `deploy/scripts/deploy.sh`
- `logs/scripts/show-logs.sh backend remote`
- `logs/scripts/show-logs.sh worker remote`
- `logs/scripts/show-logs.sh beat remote`

## Runtime Notes

- Local development runs `postgres`, `redis`, `backend`, `worker`, `beat`, and `frontend` from [local/compose/docker-compose.yml](local/compose/docker-compose.yml).
- Deployment runs the same core services plus the Dockerized frontend from [deploy/compose/docker-compose.yml](deploy/compose/docker-compose.yml).
- Books are stored only under `app/backend/storage/`, with generated titles in `app/backend/storage/media/generated/` and scraped export folders in `app/backend/storage/media/scraped-books/`.
- Automated tests live under [tests/backend](tests/backend) and [tests/frontend](tests/frontend).
- Backend pytest config lives at [tests/pytest.ini](tests/pytest.ini).
- `tests/scripts/verify.sh` and `tests/scripts/test-all.sh` use the live Docker stack, reseed deterministic E2E records, run backend tests in the backend container, run frontend unit tests, build the frontend, and execute Playwright against the live app.
- [tests/README.md](tests/README.md) maps the current backend coverage, frontend unit coverage, and the 24 live browser stories that run against the local Dockerized application.
- Repo-facing scripts under `local/scripts/`, `deploy/scripts/`, `tests/scripts/`, and `logs/` support `-h` or `--help` for usage details without starting work.

## Supporting Docs

- EPUB pipeline specification: [docs/epub-pipeline-specification.md](docs/epub-pipeline-specification.md)
- Processing use cases: [docs/processing-use-cases.md](docs/processing-use-cases.md)
- Processing user stories: [docs/processing-user-stories.md](docs/processing-user-stories.md)
- Processing pages reference: [docs/processing-pages-reference.md](docs/processing-pages-reference.md)
- Processing pages implementation audit: [docs/processing-pages-implementation-audit.md](docs/processing-pages-implementation-audit.md)
- Processing live test matrix: [docs/processing-live-test-matrix.md](docs/processing-live-test-matrix.md)
- Source metadata notes: [docs/ingestion/source-site-metadata.md](docs/ingestion/source-site-metadata.md)
- Authentication flows: [docs/operations/authentication-flows.md](docs/operations/authentication-flows.md)
