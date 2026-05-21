# Bangla Library Platform

A full-stack digital library platform for scraping, cataloguing, and serving Bengali ebooks. It automatically ingests books from a popular Bengali ebook site, stores them with rich metadata, and exposes them through a clean, searchable web interface.

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

## Repository Layout

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
