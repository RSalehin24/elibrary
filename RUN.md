# Local Run Guide

This repo now contains two separate deployable apps:

- [`backend/`](./backend)
- [`frontend/`](./frontend)

For detailed per-app run and deploy instructions, use:

- [`backend/README.md`](./backend/README.md)
- [`frontend/README.md`](./frontend/README.md)

## Run With Docker

From the repo root:

```bash
cp .env.example .env
docker-compose up --build
```

This starts the full local stack:

- `frontend` at `http://localhost:5173`
- `backend` at `http://localhost:8000`
- `postgres` at `localhost:5432`
- `redis` at `localhost:6379`

If you want Docker to keep running in the background:

```bash
docker-compose up --build -d
```

## View Logs

If you run `docker-compose up --build` without `-d`, Docker will stream logs in the terminal automatically.

If you run in detached mode, use:

```bash
docker-compose logs -f
```

Useful log commands:

```bash
docker-compose logs -f backend frontend
docker-compose logs -f backend
docker-compose logs -f frontend
docker-compose logs -f worker
docker-compose logs --tail=100 backend
```

## Helpful Docker Commands

See running services:

```bash
docker-compose ps
```

Stop everything:

```bash
docker-compose down
```

Stop everything and remove volumes too:

```bash
docker-compose down -v
```
