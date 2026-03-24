# Bangla Library Platform

Monorepo for a production-ready Bangla ebook pipeline.

- Backend: Django + Celery (`backend/`)
- Frontend: React + Vite (`frontend/`)
- Runtime services: Postgres, Redis, backend, worker, beat via Docker Compose
- Edge/proxy on server: host Nginx + Certbot (outside Docker)

## Current Architecture

- `docker-compose.yml` runs app services only (`backend`, `worker`, `beat`, `postgres`, `redis`)
- Backend binds to `127.0.0.1:${BACKEND_PORT}:8000`
- Host Nginx serves `frontend/dist`, proxies `/api/` and `/admin/` to backend, and serves `/static/` + `/media/`
- Celery worker handles ingestion/catalog jobs; beat handles scheduled automation

## Reliability Notes (Latest)

- Catalog source fetch now has in-app DNS fallback logic in ingestion resolution:
  - host fallback (`www.ebanglalibrary.com` and `ebanglalibrary.com`)
  - DNS resolver fallback and direct-IP HTTPS fallback path
- Docker DNS still supports configurable resolvers with primary + fallback env values

## Quick Start

Use the runbook in [RUN.md](RUN.md) for exact Local and Remote steps.

## Important Paths

- Backend app code: `backend/apps/`
- Ingestion resolution logic: `backend/apps/ingestion/services/resolution.py`
- Ingestion docs: `docs/ebanglalibrary-url-metadata.md`
- Deploy automation: `scripts/deploy.sh`
- Host Nginx automation: `scripts/setup-host-nginx.sh`
