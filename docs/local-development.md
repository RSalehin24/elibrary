# Local Development

## Prerequisites

- Docker with the Compose plugin, or `docker-compose`
- Python virtualenv already available at `.venv/` for local test execution
- Node/npm available locally for browser/build verification

## Environment Setup

Generate the repo env files you need:

```bash
scripts/generate-env.sh local
scripts/generate-env.sh backend
scripts/generate-env.sh frontend
```

The main local stack reads `.env`. Update values there as needed.

## Start The Local Stack

```bash
scripts/dev.sh up
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

## Common Commands

```bash
scripts/dev.sh ps
scripts/dev.sh logs frontend
scripts/dev.sh logs backend
scripts/dev.sh restart backend
scripts/dev.sh down
```

## Verification

Run the full verification pass:

```bash
scripts/verify.sh
```

Repeat it multiple times when you want extra confidence:

```bash
scripts/verify.sh --repeat 3
```
