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
- `app/backend/storage/`: the runtime storage location for static files, uploads, generated books, and scraped exports
- `automation/`: shared shell and env helpers used by local, deploy, and log automation
- `tests/TEST_MATRIX.md`: feature-to-test coverage map for backend and live browser suites

## Primary Workflows

- Local development: [docs/operations/local-development.md](docs/operations/local-development.md)
- Deployment automation: [docs/operations/deployment.md](docs/operations/deployment.md)
- Log viewing: [docs/operations/log-viewing.md](docs/operations/log-viewing.md)

## Key Commands

- `local/scripts/generate-env.sh all`
- `local/scripts/dev.sh up`
- `tests/scripts/seed-e2e-data.sh`
- `tests/scripts/test-all.sh`
- `tests/scripts/test-backend.sh`
- `tests/scripts/test-frontend-unit.sh`
- `tests/scripts/test-e2e.sh`
- `tests/scripts/verify.sh --repeat 3`
- `deploy/scripts/deploy.sh`
- `logs/show-logs.sh backend remote`
- `logs/show-logs.sh worker remote`
- `logs/show-logs.sh beat remote`

## Runtime Notes

- Local development runs `postgres`, `redis`, `backend`, `worker`, `beat`, and `frontend` from [local/compose/docker-compose.yml](local/compose/docker-compose.yml).
- Deployment runs the same core services plus the Dockerized frontend from [deploy/compose/docker-compose.yml](deploy/compose/docker-compose.yml).
- Books are stored only under `app/backend/storage/`, with generated titles in `app/backend/storage/media/generated/` and scraped export folders in `app/backend/storage/media/scraped-books/`.
- Automated tests live under [tests/backend](tests/backend) and [tests/frontend](tests/frontend).
- Backend pytest config lives at [tests/pytest.ini](tests/pytest.ini).
- `tests/scripts/verify.sh` and `tests/scripts/test-all.sh` use the live Docker stack, reseed deterministic E2E records, run backend tests in the backend container, run frontend unit tests, build the frontend, and execute Playwright against the live app.
- `tests/TEST_MATRIX.md` maps the current backend coverage, frontend unit coverage, and the 19 live browser stories that run against the local Dockerized application.
- Repo-facing scripts under `local/scripts/`, `deploy/scripts/`, `tests/scripts/`, and `logs/` support `-h` or `--help` for usage details without starting work.

## Supporting Docs

- Source metadata notes: [docs/ingestion/source-site-metadata.md](docs/ingestion/source-site-metadata.md)
