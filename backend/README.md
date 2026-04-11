# Backend

This folder contains the Django API, Celery worker/beat entrypoints, and the ingestion/catalog/access services.

## Local Development

Use the repo-level guide in [docs/operations/local-development.md](../docs/operations/local-development.md). The default local workflow runs the backend through the watch-enabled Docker development stack.

## Runtime Notes

- App code: `backend/apps/`
- Django config: `backend/config/`
- Tests: `backend/tests/`
- Local watch helper: [local/scripts/run_with_watch.py](../local/scripts/run_with_watch.py)

## Container Targets

- [local/docker/backend.Dockerfile](../local/docker/backend.Dockerfile): local autoreload image with dev dependencies
- [deploy/docker/backend.Dockerfile](../deploy/docker/backend.Dockerfile): production Gunicorn/Celery image
