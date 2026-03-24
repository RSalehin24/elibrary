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

./scripts/docker-up.sh
```

```bash
docker-compose up --build
```

This Docker flow now matches the deployed runtime shape:

- host Nginx (outside Docker) serves the built frontend
- host Nginx proxies `/api/` and `/admin/` to backend at `127.0.0.1:${BACKEND_PORT}`
- `backend`, `worker`, `beat`, `postgres`, and `redis` run in Docker

This starts the full local stack:

- backend API at `http://127.0.0.1:8000`
- `worker` for background book processing
- `beat` for daily scheduled source automation

If you want Docker to keep running in the background:

```bash
./scripts/docker-up.sh -d
```

If the stack is already running and you later pull schema changes, apply migrations with:

```bash
docker-compose exec backend python manage.py migrate
```

## Email Setup

User creation can now send a password-setup email automatically. For real delivery, update `.env` with your SMTP provider details:

```env
DEFAULT_FROM_EMAIL=library@rsalehin24.me
EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend
EMAIL_HOST=
EMAIL_PORT=587
EMAIL_HOST_USER=
EMAIL_HOST_PASSWORD=
EMAIL_USE_TLS=1
EMAIL_USE_SSL=0
EMAIL_TIMEOUT=20
```

Keep `PUBLIC_BASE_URL` pointed at the user-facing site so password reset links open the correct frontend route.

## Reverse Proxy Deploy

Local and server now use the same Docker layout and the same startup command. The normal env difference between local and server is:

- email delivery settings
- `PUBLIC_BASE_URL`, which drives frontend routing and Django public URLs

Relevant files:

- [`docker-compose.yml`](./docker-compose.yml)
- [`scripts/setup-host-nginx.sh`](./scripts/setup-host-nginx.sh)

Typical local `.env`:

```env
APP_ENV=production
DJANGO_DEBUG=0
PUBLIC_BASE_URL=http://localhost
VITE_API_BASE_URL=/api
BACKEND_PORT=8000
HOST_STATIC_DIR=./storage/staticfiles
HOST_MEDIA_DIR=./storage/media
```

Typical server `.env`:

```bash
APP_ENV=production
DJANGO_DEBUG=0
PUBLIC_BASE_URL=https://library.example.com
VITE_API_BASE_URL=/api
BACKEND_PORT=8000
HOST_STATIC_DIR=./storage/staticfiles
HOST_MEDIA_DIR=./storage/media
```

Bring up the stack locally or on the server with the same command:

```bash
docker-compose up -d --build
```

### Host Nginx + Certbot (Nginx 1.29.4)

After Docker services are up, configure Nginx on the server (outside Docker):

```bash
sudo sh scripts/setup-host-nginx.sh library.rsalehin24.me you@example.com /home/ubuntu/library_app 8000 library.salehin24.me.conf /etc/nginx/conf.d 1.29.4
```

This script:

- writes `/etc/nginx/conf.d/library.salehin24.me.conf`
- serves frontend from `~/library_app/frontend/dist`
- proxies `/api/` and `/admin/` to `127.0.0.1:8000`
- serves `/static/` and `/media/` from `~/library_app/storage/...`
- runs `certbot certonly --webroot`, then writes HTTPS + redirect Nginx config

Auto-renew is configured automatically by `scripts/setup-host-nginx.sh`.
It enables `certbot.timer` when available (or falls back to a cron job) and installs an Nginx reload hook after renewals.

If you prefer calling Docker Compose directly on this machine, use the classic builder flags to avoid the local `buildx` warning:

```bash
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker-compose up --build
```

## EC2 Deploy Helper

Use the helper from your local machine to prepare and deploy to EC2:

```bash
./scripts/deploy.sh
```

What it does:

- SSH into the host and clone/pull this repo into `~/library_app`
- create `.env` from `.env.example` when missing
- set `PUBLIC_BASE_URL=https://library.rsalehin24.me`
- build frontend dist in `frontend/dist`
- start docker services (`backend`, `worker`, `beat`, `postgres`, `redis`)
- configure host Nginx + Certbot automatically

Prerequisites:

- your local SSH agent can access GitHub (deploy key or personal SSH key)
- DNS `library.rsalehin24.me` points to the EC2 public IP

## Switch Library vs Nextcloud

On the EC2 host, if only one app should own port 80 at a time:

```bash
cd ~/library_app
./scripts/switch-app.sh library
./scripts/switch-app.sh nextcloud
```

Behavior:

- `library`: stops nextcloud containers (name prefix `nextcloud-aio`), then starts library compose stack
- `nextcloud`: stops library compose stack, then starts nextcloud containers

If your nextcloud container names differ, set a custom match pattern:

```bash
NEXTCLOUD_PATTERN='^your-nextcloud-prefix' ./scripts/switch-app.sh nextcloud
```

## View Logs

If you run `docker-compose up --build` without `-d`, Docker will stream logs in the terminal automatically.

If you run in detached mode, use:

```bash
docker-compose logs -f
```

Useful log commands:

```bash
docker-compose logs -f backend
docker-compose logs -f worker
docker-compose logs -f beat
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
