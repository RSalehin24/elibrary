# Deployment

## What The Deployment Script Automates

`scripts/deploy.sh` is the primary deployment entrypoint. It is designed for an Ubuntu-style remote host with passwordless `sudo`.

It performs these steps:

1. Validates DNS, SSH, and sudo access.
2. Syncs the target branch to the remote app directory.
3. Syncs the local workspace to the remote host.
4. Merges non-empty keys from the selected local env file into the remote `.env`.
5. Installs or upgrades Docker when required.
6. Builds the frontend production bundle on the remote machine.
7. Recreates the Docker Compose backend stack.
8. Installs/configures host Nginx and Certbot.
9. Verifies Nginx config loading and HTTPS reachability.

## Prepare Env Files

Generate or extend the needed env files:

```bash
scripts/generate-env.sh production
scripts/generate-env.sh deploy
```

Files involved:

- [`.env.production`](../.env.production): application/runtime values for deployment sync
- `scripts/.env`: deploy target settings

Important deploy settings in `scripts/.env`:

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
scripts/deploy.sh
```

Deploy using a different env file name:

```bash
scripts/deploy.sh --env-name test
```

Force or skip env sync:

```bash
scripts/deploy.sh --sync-mode push
scripts/deploy.sh --sync-mode preserve
scripts/deploy.sh --sync-mode prompt
```

## Env Sync Behavior

- The script merges only non-empty keys from the selected local env file into the remote `.env`.
- Existing remote keys remain untouched unless the local env file provides a non-empty replacement.
- When a local or remote env file needs attention, the script offers a 5-second edit window and continues if you do nothing.
- Docker is installed automatically when missing, or upgraded when `DEPLOY_DOCKER_VERSION` is set and the remote version does not match.
- Host Nginx config is written automatically and Nginx is installed or upgraded when `DEPLOY_NGINX_VERSION` is set and the remote version does not match.

## Remote Runtime Model

- Docker Compose runs `backend`, `worker`, `beat`, `postgres`, and `redis`.
- Host Nginx serves `frontend/dist`.
- Nginx proxies `/api/` and `/admin/` to the backend container port bound on localhost.
- Static and media files are served from the repo `storage/` directory on the remote host.
