# Local Development Assets

This folder contains the local Docker development stack, local env templates, runtime scratch files, and helper scripts used during day-to-day development.

## Folder Layout

- `local/compose/`: local Docker Compose definition
- `local/docker/`: local backend/frontend Dockerfiles
- `local/env/`: local env template and generated local env file
- `local/runtime/`: local runtime scratch files such as the Celery beat schedule
- `local/scripts/`: local stack control, env generation, and watch helpers

## Primary Entry Points

- Start the local stack: `local/scripts/dev.sh up`
- Stop the local stack: `local/scripts/dev.sh down`
- Generate the local env file: `local/scripts/generate-env.sh local`
- Show script usage: `local/scripts/dev.sh --help`

Every non-help run of `local/scripts/dev.sh` prints the effective super admin email and password used by the local stack.
Compose commands derive `local/env/.compose.env` automatically so secret values containing `$` are passed literally.

## Runtime Model

The default local stack starts:

- `postgres`
- `redis`
- one-shot `backend-init` bootstrap for migrations and super admin seeding
- `backend` with Django autoreload
- `worker` with Python file watching
- `beat` with Python file watching
- `frontend` with Vite hot reload

## Related Docs

- Local development guide: [docs/operations/local-development.md](../docs/operations/local-development.md)
- Tests overview: [tests/README.md](../tests/README.md)
