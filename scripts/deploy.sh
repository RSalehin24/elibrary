#!/bin/sh

set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy.sh

Example:
  cp scripts/.env.example scripts/.env
  nano scripts/.env
  scripts/deploy.sh

What it does:
  1) SSH (agent-forwarded) to remote server
  2) Clones/pulls repo into ~/library_app
  3) Ensures .env exists from .env.example
  4) Builds frontend dist on remote machine
  5) Starts Docker Compose app stack (without nginx)
  6) Configures host nginx + certbot automatically
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
DEFAULT_ENV_FILE="$SCRIPT_DIR/.env.example"

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$DEFAULT_ENV_FILE" ]; then
    cp "$DEFAULT_ENV_FILE" "$ENV_FILE"
    printf 'Created %s from %s\n' "$ENV_FILE" "$DEFAULT_ENV_FILE"
  else
    printf 'Missing %s\n' "$ENV_FILE"
    exit 1
  fi
fi

set -a
. "$ENV_FILE"
set +a

DEPLOY_USER_NAME="${DEPLOY_USER_NAME:-ubuntu}"
DEPLOY_IP="${DEPLOY_IP:-54.169.28.248}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-library.rsalehin24.me}"
DEPLOY_CERTBOT_EMAIL="${DEPLOY_CERTBOT_EMAIL:-rsalehin24@gmail.com}"
DEPLOY_NGINX_CONF_DIR="${DEPLOY_NGINX_CONF_DIR:-/etc/nginx/conf.d}"
DEPLOY_NGINX_CONFIG_NAME="${DEPLOY_NGINX_CONFIG_NAME:-library.salehin24.me.conf}"
DEPLOY_NGINX_VERSION="${DEPLOY_NGINX_VERSION:-1.29.4}"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'main')"
BRANCH="${DEPLOY_BRANCH_NAME:-$CURRENT_BRANCH}"
TARGET="${DEPLOY_USER_NAME}@${DEPLOY_IP}"
REPO_SSH="${REPO_SSH:-git@github.com:RSalehin24/ebook-scrapping.git}"
APP_DIR='~/library_app'
DOMAIN="${DOMAIN:-library.rsalehin24.me}"
REMOTE_APP_DIR='$HOME/library_app'
DOMAIN="$DEPLOY_DOMAIN"
CERTBOT_EMAIL="$DEPLOY_CERTBOT_EMAIL"
BACKEND_PORT="${BACKEND_PORT:-8000}"

printf '\n[1/5] Syncing code on %s...\n' "$TARGET"
ssh -A "$TARGET" REPO_SSH="$REPO_SSH" BRANCH="$BRANCH" APP_DIR="$REMOTE_APP_DIR" DOMAIN="$DOMAIN" CERTBOT_EMAIL="$CERTBOT_EMAIL" BACKEND_PORT="$BACKEND_PORT" 'bash -s' <<'EOF'
set -eu

set_default_env() {
  key="$1"
  value="$2"
  file="$3"

  if grep -q "^${key}=" "$file"; then
    current_value=$(grep "^${key}=" "$file" | head -n 1 | cut -d '=' -f2-)
    if [ -z "$current_value" ]; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    fi
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
else
  rm -rf "$APP_DIR"
  git clone "$REPO_SSH" "$APP_DIR"
  cd "$APP_DIR"
  git checkout "$BRANCH"
fi

if [ ! -f .env ]; then
  cp .env.example .env
fi

set_default_env PUBLIC_BASE_URL "https://${DOMAIN}" .env
set_default_env VITE_API_BASE_URL "/api" .env
set_default_env BACKEND_PORT "$BACKEND_PORT" .env
set_default_env HOST_STATIC_DIR "./storage/staticfiles" .env
set_default_env HOST_MEDIA_DIR "./storage/media" .env

mkdir -p storage/staticfiles storage/media

printf '\nRemote ready at %s\n' "$APP_DIR"
printf 'Branch: %s\n' "$BRANCH"
printf 'Remote .env defaults ensured (existing values preserved)\n'
EOF

printf '\n[2/5] Building frontend dist on %s...\n' "$TARGET"
ssh -t "$TARGET" "cd $APP_DIR && \
  docker run --rm -v \"\$PWD/frontend:/app\" -w /app node:22-alpine sh -lc 'npm ci && npm run build'"

printf '\n[3/5] Starting app stack on %s...\n' "$TARGET"
ssh -t "$TARGET" "cd $APP_DIR && \
  if docker compose version >/dev/null 2>&1; then \
    docker compose up -d --build; \
  elif command -v docker-compose >/dev/null 2>&1; then \
    docker-compose up -d --build; \
  else \
    echo 'Docker Compose not found. Install docker compose plugin or docker-compose binary.'; \
    exit 127; \
  fi"

printf '\n[4/5] Configuring host nginx + certbot on %s...\n' "$TARGET"
ssh -t "$TARGET" "cd $APP_DIR && sudo sh scripts/setup-host-nginx.sh '$DOMAIN' '$CERTBOT_EMAIL' '$HOME/library_app' '$BACKEND_PORT' '$DEPLOY_NGINX_CONFIG_NAME' '$DEPLOY_NGINX_CONF_DIR' '$DEPLOY_NGINX_VERSION'"

printf '\n[5/5] Done.\n'
printf 'DNS requirement: point %s -> %s\n' "$DOMAIN" "$TARGET"
printf 'If another app uses port 80 on this host, keep switch-app.sh at ~/switch-app.sh on remote server to swap.\n'
