# Bangla Library Platform

This repository started as a Python scraper that pulls Bengali ebooks from `https://www.ebanglalibrary.com/` and generates standalone HTML/EPUB exports under `outputs/`. It now includes an evolutionary refactor path toward a production-ready digital library platform while preserving the legacy scraper/export flow.

## Current Architecture

- `code/`: legacy scraper and export pipeline, kept intact and still runnable.
- `backend/`: Django backend for auth, submissions, catalog persistence, protected asset access, and background processing orchestration.
- `frontend/`: React/Vite application for the library, submission, queue, and access-management experience.
- `docker-compose.yml`: local development stack with PostgreSQL, Redis, Django, Celery worker, and React.

## Real Repo Baseline

- `code/main.py` was the original batch entrypoint.
- `code/scraper.py` already contained the reusable ingestion logic: retries, normalization, fuzzy title comparison, header cleanup, dedication extraction, TOC construction, and lesson/topic scraping.
- `code/html_book.py` and `code/epub_book.py` already generated exports and still do.
- The repo originally had no backend, no frontend, no database models, no tests, and only a minimal `.gitignore`.

## Python Version

The previous `code/requirements.txt` referenced Python `3.14.2`, but the platform is now documented and containerized around **Python 3.12** as the supported target for Django, Celery, and PostgreSQL compatibility. The checked-in `ebook-scrapper/` virtualenv remains disposable local noise and is not the deployment model.

## What Exists Now

### Backend

- Email-first custom user model with session auth.
- TOTP setup/confirm/status endpoints.
- Password-reset request and reset-confirm APIs.
- Catalog models for books, contributors, series, categories, sources, metadata reviews, metadata versions, and generated assets.
- Ingestion models for submissions, title-resolution attempts, match candidates, processing jobs/logs, duplicate reviews, and source catalog entries.
- Access-control models for grants, preview sessions, reading sessions, and bookmarks.
- Protected asset download endpoints and a backend-issued reader launch flow for `https://ereader.rsalehin24.me/`.
- Celery task wiring plus a Django management command that wraps the legacy batch process.
- Capability-scoped authorization for metadata editing, processing review, and access management.
- Submission-time database reuse so existing books are returned instead of being recreated from duplicate title/URL requests.
- Canonical normalized contributor/series/category/book naming so repeated names collapse to a single relational record.
- Public-facing auth/submission throttle hooks and server-side reader-state protection.
- Token-backed reader session and bookmark endpoints for the external EPUB reader launch contract.
- Saved-filter persistence for catalog and queue management views.
- Metadata review APIs that update per-book review state and versioning history.

### Frontend

- React/Vite scaffold with:
  - library home
  - book detail
  - submission/import
  - queue/results
  - auth
  - access overview
- In-app TOTP setup/confirmation.
- Basic reviewer actions for duplicate confirmation and submission reprocessing.
- Reader progress and bookmark controls for authorized users.
- Staff/capability-aware metadata editing and version history views.
- Saved filter controls for library and queue workflows.
- Metadata review controls in the book-detail workflow.
- Bulk post-submission actions for opening created records and launching readers.

### Legacy Pipeline Preservation

- `code/main.py` now supports env vars and CLI flags for batch input.
- `code/config.py` is tracked and bootstrap-safe.
- `title` vs `book_title` mismatch is fixed.
- HTML/EPUB generators now tolerate relational-style/list metadata by adapting values back to display strings.

## Key Environment Variables

Use `.env.example` as the baseline.

- `DATABASE_URL`
- `CELERY_BROKER_URL`
- `CELERY_RESULT_BACKEND`
- `DJANGO_SECRET_KEY`
- `DJANGO_ALLOWED_HOSTS`
- `DJANGO_CORS_ALLOWED_ORIGINS`
- `DJANGO_CSRF_TRUSTED_ORIGINS`
- `SUPER_ADMIN_EMAIL`
- `SUPER_ADMIN_PASSWORD`
- `EPUB_READER_BASE_URL`
- `BOOK_URLS_JSON` / `BOOK_URL`

## Local Development

### Backend without Docker

The repository currently validates backend work using the existing checked-in virtualenv:

```bash
./ebook-scrapper/bin/python backend/manage.py migrate
./ebook-scrapper/bin/python backend/manage.py seed_superadmin --password 'change-me'
./ebook-scrapper/bin/python backend/manage.py runserver
```

In local non-Docker development, Celery defaults to eager execution unless you explicitly set `CELERY_TASK_ALWAYS_EAGER=0`.

### Frontend without Docker

```bash
cd frontend
npm install
npm run dev
```

### Full Stack with Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Services:

- Django API: `http://localhost:8000`
- React app: `http://localhost:5173`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

## Legacy CLI / Batch Path

Direct script path:

```bash
BOOK_URLS_JSON='[["Sample","https://www.ebanglalibrary.com/books/sample/"]]' python code/main.py
python code/main.py --url https://www.ebanglalibrary.com/books/sample/
```

Django-managed wrapper:

```bash
./ebook-scrapper/bin/python backend/manage.py process_legacy_batch --sync --url https://www.ebanglalibrary.com/books/sample/
```

## Migrations and Workers

```bash
./ebook-scrapper/bin/python backend/manage.py makemigrations
./ebook-scrapper/bin/python backend/manage.py migrate
celery -A config worker --workdir backend --loglevel=info
```

## Reader Integration Contract

The backend issues reader launches via:

- `POST /api/access/books/<slug>/reader-launch/`

That returns a `launch_url` pointing at `https://ereader.rsalehin24.me/?manifest=<signed manifest url>`.

The reader can then request:

- `GET /api/access/reader/<token>/manifest/`
- `GET /api/access/reader/<token>/epub/`
- `GET /api/access/reader/<token>/html/`
- `GET/POST /api/access/reader/<token>/session/`
- `GET/POST /api/access/reader/<token>/bookmarks/`

This keeps file authorization in Django instead of trusting the frontend alone.

The static reader at `/Users/rsalehin24/Documents/epub-reader` now supports:

- `/?manifest=<absolute manifest url>`

When launched that way, it auto-loads the protected EPUB and syncs reading progress back through the backend session URL.

## Tests

Run backend tests with:

```bash
./ebook-scrapper/bin/python -m pytest
```

Run the verified frontend production build with:

```bash
cd frontend
npm run build
```

## What Is Still Incomplete

- Production mail delivery hardening and deeper account-management UX.
- Richer merge/review tooling for duplicates and metadata corrections beyond the current basic staff flows.
- Fuller grant/user management UX beyond the current screens.
- Deeper reader-side polish beyond the current manifest launch and progress-sync contract.
- End-to-end Docker validation against live Postgres/Redis/Celery rather than eager-mode local testing.

## Resume Notes

See `PROGRESS.md` for the phased checkpoint summary and immediate next steps.
