# Bangla Library Platform

Monorepo for the Bangla ebook platform. The platform scrapes, processes, and serves Bangla (and English) ebooks from [ebanglalibrary.com](https://www.ebanglalibrary.com), producing well-structured EPUB and HTML books for an authenticated library of users.

---

## Features

- 📚 **Ebook Scraping** — Automated scraper that ingests ebooks and their metadata (title, author, category, cover image) from a popular Bengali ebook site.
- 🗂️ **Book Catalog** — Browsable and searchable catalog of all scraped books, organized by category and author.
- 📖 **Ebook Generation** — Generates downloadable ebook files from scraped content and stores them for user access.
- 🔐 **Authentication** — User registration and login with session-based access control.
- ⚙️ **Async Task Processing** — Long-running scrape and generation jobs are handled by Celery workers with Redis as the message broker, keeping the API responsive.
- 🐳 **Dockerized Stack** — Full local development and production deployment via Docker Compose, including Postgres, Redis, Django backend, Celery worker & beat, and React frontend.
- 🧪 **Automated Testing** — Backend pytest suite, frontend unit tests (Vitest), and 19 end-to-end browser stories powered by Playwright.
- 🚀 **One-Command Deployment** — Remote deployment automation with Nginx + Certbot for TLS at the edge.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend API | Django (Python) |
| Task Queue | Celery + Redis |
| Frontend | React + Vite (JavaScript) |
| Database | PostgreSQL |
| Containerisation | Docker Compose |
| Edge / TLS | Nginx + Certbot |
| Testing | pytest · Vitest · Playwright |

---

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
- `app/` — application source code for backend and frontend
- `tests/` — backend and browser test suites at the repo root
- `local/` — local Compose, Dockerfiles, env templates, and developer scripts
- `deploy/` — deployment Compose, Dockerfiles, env templates, and remote automation scripts
- `logs/` — local and remote log streaming plus captured log files
- `automation/` — shared shell and env helpers used by local, deploy, and log automation
- `app/backend/storage/` — runtime storage for static files, uploads, generated books, and scraped exports

---

## Getting Started

### Prerequisites

- Docker & Docker Compose
- Git

### Local Development

```bash
# 1. Generate local environment files
local/scripts/generate-env.sh

# 2. Start the full local stack (postgres, redis, backend, worker, beat, frontend)
local/scripts/dev.sh up
```

The frontend will be available at `http://localhost:5173` and the backend API at `http://localhost:8000`.

### Running Tests

```bash
# Run all tests (requires live Docker stack)
tests/scripts/test-all.sh

# Backend tests only
tests/scripts/test-backend.sh

# Frontend unit tests only
tests/scripts/test-frontend-unit.sh

# End-to-end browser tests only
tests/scripts/test-e2e.sh

# Seed deterministic E2E data
tests/scripts/seed-e2e-data.sh

# Verify the full suite N times
tests/scripts/verify.sh --repeat 3
```

See [tests/README.md](tests/README.md) for the full coverage map and browser story list.

### Deployment

```bash
# Generate production environment files
deploy/scripts/generate-env.sh production
deploy/scripts/generate-env.sh host

# Deploy to remote server
deploy/scripts/deploy.sh
```

See [docs/operations/deployment.md](docs/operations/deployment.md) for the full deployment guide.

---

## Key Commands

| Command | Purpose |
|---|---|
| `local/scripts/dev.sh up` | Start local Docker stack |
| `deploy/scripts/deploy.sh` | Deploy to production |
| `logs/scripts/show-logs.sh backend remote` | Stream remote backend logs |
| `logs/scripts/show-logs.sh worker remote` | Stream remote worker logs |
| `logs/scripts/show-logs.sh beat remote` | Stream remote beat logs |

All scripts support `-h` / `--help` for usage details.

---

## Documentation

- [Local development guide](docs/operations/local-development.md)
- [Deployment guide](docs/operations/deployment.md)
- [Authentication flows](docs/operations/authentication-flows.md)
- [Log viewing guide](docs/operations/log-viewing.md)
- [Source site metadata notes](docs/ingestion/source-site-metadata.md)
- [Test suite overview](tests/README.md)
