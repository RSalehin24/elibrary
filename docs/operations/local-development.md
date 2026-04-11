# Local Development

## Prerequisites

- Docker with the Compose plugin, or `docker-compose`
- Python virtualenv available at `.venv/` for local verification runs
- Node/npm available locally for frontend build and Playwright verification

## Folder Layout

- `local/compose/`: watch-enabled local Docker Compose stack
- `local/docker/`: local Dockerfiles for backend and frontend
- `local/env/`: local env template and generated local env file
- `local/scripts/`: local run, env generation, verification, and watch helpers

## Environment Setup

Generate the local env file:

```bash
local/scripts/generate-env.sh local
```

The local stack reads `local/env/.env`. Update values there as needed.

## Start The Local Stack

```bash
local/scripts/dev.sh up
```

This starts:

- `postgres`
- `redis`
- `backend` with Django autoreload
- `worker` with Python file watching
- `beat` with Python file watching
- `frontend` with Vite hot reload

Default URLs:

- Frontend: `http://127.0.0.1:5173`
- Backend API: `http://127.0.0.1:8000`

Books, uploads, and static assets are stored only under the repo `storage/` directory.

## Common Commands

```bash
local/scripts/dev.sh ps
local/scripts/dev.sh logs frontend
local/scripts/dev.sh logs backend
local/scripts/dev.sh restart backend
local/scripts/dev.sh down
```

## Verification

Run the full verification pass:

```bash
local/scripts/verify.sh
```

Repeat it multiple times when you want extra confidence:

```bash
local/scripts/verify.sh --repeat 3
```
