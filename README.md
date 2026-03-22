# Bangla Library Platform

This repository is now organized as two independently deployable apps:

- `backend/`: Django API, auth, catalog, ingestion, reader access, Celery worker/beat support, and the integrated legacy scraper/export pipeline under `backend/apps/ingestion/legacy/`.
- `frontend/`: React/Vite client that talks to the backend over `VITE_API_BASE_URL`.

The apps can still be developed together locally from this repo, but they are now structured so each one can be deployed from its own folder in a separate environment.

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
  - optional local full-stack integration only

## Separate Deployment

Deploy the backend from the [`backend/`](./backend) folder.

Deploy the frontend from the [`frontend/`](./frontend) folder.

Each folder now has its own environment example and deployment notes:

- [`backend/README.md`](./backend/README.md)
- [`frontend/README.md`](./frontend/README.md)

## Local Full Stack

If you still want the whole stack together locally:

```bash
cp .env.example .env
docker-compose up --build
```

Services:

- Backend: `http://localhost:8000`
- Frontend: `http://localhost:5173`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

## Notes

- The old root-level `code/` dependency is now integrated into `backend/apps/ingestion/legacy/`, so the backend is self-contained.
- Retained generated HTML, EPUB, and cover assets live under `backend/storage/media/generated/`; `backend/outputs/` is only temporary staging during ingestion.
- The root `.env.example` remains useful for local integrated development with `docker-compose.yml`.
