# Bangla Library Platform

Monorepo for the Bangla ebook platform.

## Stack

- Backend: Django + Celery in [app/backend](app/backend)
- Frontend: React + Vite in [app/frontend](app/frontend)
- Infrastructure: Docker Compose for local and deployed services, host Nginx + Certbot for the remote edge

## Repository Layout

- `app/`: application source code for backend and frontend
- `tests/`: backend and browser test suites at the repo root
- `local/`: local Compose, Dockerfiles, env templates, and developer scripts
- `deploy/`: deployment Compose, Dockerfiles, env templates, and remote automation scripts
- `logs/`: local and remote log streaming plus captured log files
- `storage/`: the only runtime storage location for static files, uploads, generated books, and scraped exports
- `automation/`: shared shell and env helpers used by local, deploy, and log automation
- `tests/TEST_MATRIX.md`: feature-to-test coverage map for backend and live browser suites

## Primary Workflows

- Local development: [docs/operations/local-development.md](docs/operations/local-development.md)
- Deployment automation: [docs/operations/deployment.md](docs/operations/deployment.md)
- Log viewing: [docs/operations/log-viewing.md](docs/operations/log-viewing.md)

## Key Commands

- `local/scripts/generate-env.sh all`
- `local/scripts/dev.sh up`
- `local/scripts/seed-e2e-data.sh`
- `local/scripts/verify.sh --repeat 3`
- `deploy/scripts/deploy.sh`
- `logs/show-logs.sh backend remote`

## Runtime Notes

- Local development runs `postgres`, `redis`, `backend`, `worker`, `beat`, and `frontend` from [local/compose/docker-compose.yml](local/compose/docker-compose.yml).
- Deployment runs the same core services plus the Dockerized frontend from [deploy/compose/docker-compose.yml](deploy/compose/docker-compose.yml).
- Books are stored only under `storage/`, with generated titles in `storage/media/generated/` and scraped export folders in `storage/media/scraped-books/`.
- Automated tests live under [tests/backend](tests/backend) and [tests/frontend](tests/frontend).
- `local/scripts/verify.sh` uses the live Docker stack, reseeds deterministic E2E records, runs backend tests in the backend container, builds the frontend in the frontend container, and executes Playwright against the live app.
- `tests/TEST_MATRIX.md` maps the current backend coverage and the 17 live browser stories that run against the local Dockerized application.

## Supporting Docs

- Source metadata notes: [docs/ingestion/source-site-metadata.md](docs/ingestion/source-site-metadata.md)
