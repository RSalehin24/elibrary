# Bangla Library Platform

This repository is organized as two app codebases with one unified Docker runtime:

- `backend/`: Django API, auth, catalog, ingestion, reader access, Celery worker/beat support, and the integrated legacy scraper/export pipeline under `backend/apps/ingestion/legacy/`.
- `frontend/`: React/Vite client that talks to the backend over `VITE_API_BASE_URL`.

The browser-facing runtime is now the same locally and on the server: Nginx serves the frontend bundle and proxies Django over the internal Docker network.

## Folder Layout

- `backend/`
  - `apps/`, `config/`, `manage.py`
  - `apps/ingestion/legacy/` for the scraper, HTML builder, and EPUB builder
  - `requirements.txt` and `requirements-dev.txt`
  - `.env.example`
  - `storage/` for retained backend-owned local assets
  - `outputs/` as temporary ingestion staging
- `frontend/`
  - `src/`, `package.json`, `vite.config.js`
  - `.env.example`
- `docker-compose.yml`
  - unified local/server stack with public Nginx and private app services

## Local Full Stack

The same Docker command is used locally and on the server:

```bash
cp .env.example .env
docker-compose up --build
```

Services:

- App: `http://localhost`
- Django API/admin: behind Nginx on the same origin
- Worker/beat/postgres/redis: internal Docker network only

## Notes

- The old root-level `code/` dependency is now integrated into `backend/apps/ingestion/legacy/`, so the backend is self-contained.
- Retained generated HTML, EPUB, and cover assets live under `backend/storage/media/generated/`; `backend/outputs/` is only temporary staging during ingestion.
- The root `.env.example` is the main starting point for both local and server deployment.
