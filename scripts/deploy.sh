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
  4) Sets domain and certbot env on remote .env
  5) Starts Docker Compose stack
  6) Issues SSL certificate via certbot automatically
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

if [ ! -f "$ENV_FILE" ]; then
  printf 'Missing %s\n' "$ENV_FILE"
  printf 'Create it from scripts/.env.example and retry.\n'
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

if [ -z "${DEPLOY_USER_NAME:-}" ] || [ -z "${DEPLOY_IP:-}" ]; then
  printf 'DEPLOY_USER_NAME and DEPLOY_IP must be set in %s\n' "$ENV_FILE"
  exit 1
fi

if [ -z "${DEPLOY_DOMAIN:-}" ] || [ -z "${DEPLOY_CERTBOT_EMAIL:-}" ]; then
  printf 'DEPLOY_DOMAIN and DEPLOY_CERTBOT_EMAIL must be set in %s\n' "$ENV_FILE"
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'main')"
BRANCH="${DEPLOY_BRANCH_NAME:-$CURRENT_BRANCH}"
TARGET="${DEPLOY_USER_NAME}@${DEPLOY_IP}"
REPO_SSH="${REPO_SSH:-git@github.com:RSalehin24/ebook-scrapping.git}"
APP_DIR='~/library_app'
DOMAIN="${DOMAIN:-library.rsalehin24.me}"
REMOTE_APP_DIR='$HOME/library_app'
DOMAIN="$DEPLOY_DOMAIN"
CERTBOT_EMAIL="$DEPLOY_CERTBOT_EMAIL"

printf '\n[1/4] Syncing code on %s...\n' "$TARGET"
ssh -A "$TARGET" REPO_SSH="$REPO_SSH" BRANCH="$BRANCH" APP_DIR="$REMOTE_APP_DIR" DOMAIN="$DOMAIN" CERTBOT_EMAIL="$CERTBOT_EMAIL" 'bash -s' <<'EOF'
set -eu

set_or_append_env() {
  key="$1"
  value="$2"
  file="$3"

  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
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

set_or_append_env PUBLIC_BASE_URL "https://${DOMAIN}" .env
set_or_append_env NGINX_SERVER_NAME "$DOMAIN" .env
set_or_append_env CERTBOT_DOMAIN "$DOMAIN" .env
set_or_append_env CERTBOT_EMAIL "$CERTBOT_EMAIL" .env
set_or_append_env SSL_ENABLED "1" .env
set_or_append_env VITE_API_BASE_URL "/api" .env
set_or_append_env NGINX_PORT "80" .env
set_or_append_env NGINX_SSL_PORT "443" .env

printf '\nRemote ready at %s\n' "$APP_DIR"
printf 'Branch: %s\n' "$BRANCH"
printf 'PUBLIC_BASE_URL and NGINX_SERVER_NAME set for %s\n' "$DOMAIN"
EOF

printf '\n[2/4] Starting stack on %s...\n' "$TARGET"
ssh -t "$TARGET" "cd $APP_DIR && \
  if docker compose version >/dev/null 2>&1; then \
    docker compose up -d --build; \
  elif command -v docker-compose >/dev/null 2>&1; then \
    docker-compose up -d --build; \
  else \
    echo 'Docker Compose not found. Install docker compose plugin or docker-compose binary.'; \
    exit 127; \
  fi"

printf '\n[3/4] Issuing/refreshing SSL certificate on %s...\n' "$TARGET"
ssh -t "$TARGET" "cd $APP_DIR && sh scripts/certbot-init.sh"

printf '\n[4/4] Done.\n'
printf 'DNS requirement: point %s -> %s\n' "$DOMAIN" "$TARGET"
printf 'If another app uses port 80 on this host, keep switch-app.sh at ~/switch-app.sh on remote server to swap.\n'
