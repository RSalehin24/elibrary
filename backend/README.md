# Backend

This folder contains the Django API, Celery worker/beat entrypoints, and the ingestion/catalog/access services.

## Local Development

Use the repo-level guide in [docs/local-development.md](../docs/local-development.md). The default local workflow now runs the backend through the watch-enabled Docker development stack.

## Runtime Notes

- App code: `backend/apps/`
- Django config: `backend/config/`
- Tests: `backend/tests/`
- Local watch helper: [backend/scripts/run_with_watch.py](scripts/run_with_watch.py)

## Container Targets

- `backend/Dockerfile` `runtime` target: production Gunicorn image
- `backend/Dockerfile` `dev` target: local autoreload image with dev dependencies
