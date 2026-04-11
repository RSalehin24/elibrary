# Bangla Library Platform

Monorepo for the Bangla ebook platform.

## Stack

- Backend: Django + Celery in [backend](backend)
- Frontend: React + Vite in [frontend](frontend)
- Infrastructure: Docker Compose for local and deployed services, host Nginx + Certbot for the remote edge

## Repository Layout

- `local/`: local Compose, Dockerfiles, env templates, and developer scripts
- `deploy/`: deployment Compose, Dockerfiles, env templates, and remote automation scripts
- `logs/`: local and remote log streaming plus captured log files
- `storage/`: the only runtime storage location for static files, uploads, generated books, and scraped exports
- `tooling/`: shared shell and env helpers used by both local and deploy workflows

## Primary Workflows

- Local development: [docs/operations/local-development.md](docs/operations/local-development.md)
- Deployment automation: [docs/operations/deployment.md](docs/operations/deployment.md)
- Log viewing: [docs/operations/log-viewing.md](docs/operations/log-viewing.md)

## Key Commands

- `local/scripts/generate-env.sh all`
- `local/scripts/dev.sh up`
- `local/scripts/verify.sh --repeat 3`
- `deploy/scripts/deploy.sh`
- `logs/show-logs.sh backend remote`

## Runtime Notes

- Local development runs `postgres`, `redis`, `backend`, `worker`, `beat`, and `frontend` from [local/compose/docker-compose.yml](local/compose/docker-compose.yml).
- Deployment runs the same core services plus the Dockerized frontend from [deploy/compose/docker-compose.yml](deploy/compose/docker-compose.yml).
- Books are stored only under `storage/`, with generated titles in `storage/media/generated/` and scraped export folders in `storage/media/scraped-books/`.

## Supporting Docs

- Source metadata notes: [docs/ingestion/source-site-metadata.md](docs/ingestion/source-site-metadata.md)
