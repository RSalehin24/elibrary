# Bangla Library Platform

Monorepo for the Bangla ebook platform.

## Stack

- Backend: Django + Celery in [backend](backend)
- Frontend: React + Vite in [frontend](frontend)
- Infrastructure: Docker Compose for local/runtime services, host Nginx + Certbot for remote edge delivery

## Primary Workflows

- Local development: [docs/local-development.md](docs/local-development.md)
- Deployment automation: [docs/deployment.md](docs/deployment.md)
- Log viewing: [docs/log-viewing.md](docs/log-viewing.md)

## Core Scripts

- `scripts/generate-env.sh`: scaffold local, production, test, backend, frontend, or deploy env files
- `scripts/dev.sh`: start or stop the local watch-enabled development stack
- `scripts/verify.sh`: run backend tests, frontend build, and Playwright suite, optionally repeated
- `scripts/deploy.sh`: automated remote deployment with env sync, Docker checks, and nginx setup
- `logs/show-logs.sh`: local or remote frontend/backend log streaming

## Architecture Notes

- Production/runtime compose stays focused on backend services: `backend`, `worker`, `beat`, `postgres`, `redis`
- Local development adds a Vite frontend plus auto-reloading backend/Celery via [docker-compose.dev.yml](docker-compose.dev.yml)
- Host Nginx serves `frontend/dist`, proxies `/api/` and `/admin/`, and exposes static/media from `storage/`

## Supporting Docs

- Source metadata notes: [docs/ebanglalibrary-url-metadata.md](docs/ebanglalibrary-url-metadata.md)
