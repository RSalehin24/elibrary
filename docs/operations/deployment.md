# Deployment

## What The Deployment Script Automates

`deploy/scripts/deploy.sh` is the primary deployment entrypoint. It is designed for an Ubuntu-style remote host with passwordless `sudo`.

It performs these steps:

1. Validates DNS, SSH, and sudo access.
2. Syncs the target branch to the remote app directory.
3. Syncs the local workspace to the remote host.
4. Merges non-empty keys from the selected local env file into the remote app env.
5. Installs or upgrades Docker when required.
6. Recreates the Docker Compose frontend and backend stack.
7. Installs/configures host Nginx and Certbot.
8. Verifies Nginx config loading and HTTPS reachability.

## Folder Layout

- `deploy/compose/`: production Docker Compose definition
- `deploy/docker/`: production Dockerfiles and Nginx container config
- `deploy/env/`: deployment env templates and generated env files
- `deploy/scripts/`: remote deployment and host bootstrap scripts
- `app/`: application code synchronized to the remote host
- `automation/`: shared env and shell helpers reused by local and deploy workflows

## Prepare Env Files

Generate or extend the needed env files:

```bash
local/scripts/generate-env.sh production
local/scripts/generate-env.sh test
local/scripts/generate-env.sh host
```

Files involved:

- `deploy/env/app.env.example`: shared application template for deployed stacks
- `deploy/env/.production.env`: production application/runtime values used for env sync
- `deploy/env/.test.env`: optional test deployment runtime values
- `deploy/env/host.env.example`: deploy host template
- `deploy/env/.host.env`: deploy host settings for SSH, Docker, and Nginx automation
- Remote `deploy/env/.app.env`: generated remote runtime env after sync/merge

Important deploy host settings in `deploy/env/.host.env`:

- `DEPLOY_USER_NAME`
- `DEPLOY_IP`
- `DEPLOY_BRANCH_NAME`
- `DEPLOY_DOMAIN`
- `DEPLOY_CERTBOT_EMAIL`
- `DEPLOY_NGINX_CONF_DIR`
- `DEPLOY_NGINX_CONFIG_NAME`
- `DEPLOY_NGINX_VERSION`
- `DEPLOY_DOCKER_VERSION`
- `DEPLOY_ENV_SYNC_MODE`

## Run Deployment

Default production deployment:

```bash
deploy/scripts/deploy.sh
```

Deploy using a different env file name:

```bash
deploy/scripts/deploy.sh --env-name test
```

Force or skip env sync:

```bash
deploy/scripts/deploy.sh --sync-mode push
deploy/scripts/deploy.sh --sync-mode preserve
deploy/scripts/deploy.sh --sync-mode prompt
```

## Env Sync Behavior

- The script merges only non-empty keys from the selected local env file into remote `deploy/env/.app.env`.
- Existing remote keys remain untouched unless the local env file provides a non-empty replacement.
- When a local or remote env file needs attention, the script offers a 5-second edit window and continues if you do nothing.
- Docker is installed automatically when missing, or upgraded when `DEPLOY_DOCKER_VERSION` is set and the remote version does not match.
- Host Nginx config is written automatically and Nginx is installed or upgraded when `DEPLOY_NGINX_VERSION` is set and the remote version does not match.

## Remote Runtime Model

- Docker Compose runs `frontend`, `backend`, `worker`, `beat`, `postgres`, and `redis`.
- Host Nginx proxies `/` to the frontend container and `/api/` plus `/admin/` to the backend container port bound on localhost.
- Static and media files are served from the repo `storage/` directory on the remote host.
- Workspace sync excludes local runtime files, local env files, gitignored logs, virtualenvs, and other generated artifacts.
