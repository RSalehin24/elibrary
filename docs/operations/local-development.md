# Local Development

## Prerequisites

- Docker with the Compose plugin, or `docker-compose`
- Node/npm available locally for frontend build and Playwright verification

## Folder Layout

- `app/`: backend and frontend application code
- `local/compose/`: watch-enabled local Docker Compose stack
- `local/docker/`: local Dockerfiles for backend and frontend
- `local/env/`: local env template and generated local env file
- `local/runtime/`: runtime files created by local services, such as the Celery beat schedule
- `local/scripts/`: local run, env generation, seeding, verification, and watch helpers
- `tests/`: root-level backend and frontend automated tests

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

Books, uploads, and static assets are stored only under `app/backend/storage/`.

## Common Commands

```bash
local/scripts/dev.sh ps
local/scripts/dev.sh logs frontend
local/scripts/dev.sh logs backend
local/scripts/seed-e2e-data.sh
local/scripts/test-all.sh
local/scripts/test-backend.sh
local/scripts/test-frontend-unit.sh
local/scripts/test-e2e.sh
local/scripts/dev.sh restart backend
local/scripts/dev.sh down
```

## Verification

Run the full verification pass against the real Dockerized application:

```bash
local/scripts/verify.sh
```

Repeat it multiple times when you want extra confidence:

```bash
local/scripts/verify.sh --repeat 3
```

`local/scripts/verify.sh`:

- starts or refreshes the live local stack through `local/scripts/dev.sh up`
- waits for the frontend and backend to become healthy
- reseeds deterministic browser data through `local/scripts/seed-e2e-data.sh`
- runs backend `pytest` inside the backend container using `tests/pytest.ini`
- runs frontend unit tests from `tests/frontend/unit/`
- runs the frontend production build inside the frontend container
- runs Playwright against the live app on `http://127.0.0.1:5173`

The Playwright config and live browser stories live under:

- `tests/frontend/playwright.config.js`
- `tests/frontend/e2e/`

The separate test entrypoints are:

- `local/scripts/test-backend.sh`
- `local/scripts/test-frontend-unit.sh`
- `cd app/frontend && npm run build`
- `local/scripts/test-e2e.sh`
