# Run Guide

## Local

1. Prepare env file.

```bash
cp .env.example .env
```

2. Start backend stack.

```bash
./scripts/docker-up.sh -d
```

3. Start frontend dev server.

```bash
cd frontend
npm ci
npm run dev
```

If port `5173` is already occupied, the dev server now exits with an error.
Close stale Vite sessions and restart:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
kill <pid>
cd frontend && npm run dev
```

4. Open app.

- Frontend: `http://localhost:5173`
- Backend API: `http://127.0.0.1:8000`

Note: `docker-compose` in this repository starts backend services only; it does not serve the React frontend in local development.

5. Useful local checks.

```bash
docker-compose logs -f worker
docker-compose logs -f backend
```

## Remote (EC2)

1. Prepare deploy env.

```bash
cp scripts/.env.example scripts/.env
```

2. Set values in `scripts/.env`.

- `DEPLOY_USER_NAME`
- `DEPLOY_IP`
- `DEPLOY_BRANCH_NAME`
- `DEPLOY_DOMAIN`
- `DEPLOY_CERTBOT_EMAIL`
- `DEPLOY_NGINX_CONF_DIR=/etc/nginx/conf.d`
- `DEPLOY_NGINX_CONFIG_NAME=library.salehin24.me.conf`
- `DEPLOY_NGINX_VERSION=1.29.4`

3. Run automated deploy from local machine.

```bash
bash scripts/deploy.sh
```

What deploy does:

- runs preflight checks (DNS, SSH, sudo, Docker, Compose)
- syncs code to `/home/<user>/library_app`
- builds frontend bundle on remote
- recreates Docker services (`backend`, `worker`, `beat`, `postgres`, `redis`)
- validates worker DNS reachability for source sync
- configures host Nginx + Certbot and verifies HTTPS

## Operations

```bash
docker-compose ps
docker-compose logs -f backend
docker-compose logs -f worker
docker-compose down
docker-compose down -v
```
