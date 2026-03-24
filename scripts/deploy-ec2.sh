#!/bin/sh

set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-ec2.sh <user@ip> [branch]

Example:
  scripts/deploy-ec2.sh ubuntu@54.169.28.248 reyan-ebook-library

What it does:
  1) SSH (agent-forwarded) to EC2
  2) Clones/pulls repo into ~/library_app
  3) Ensures .env exists from .env.example
  4) Sets PUBLIC_BASE_URL and NGINX_SERVER_NAME for library.rsalehin24.me
  5) Prompts you to edit .env
  6) Prompts you to start docker-compose
EOF
}

if [ "${1:-}" = "" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

TARGET="$1"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'main')"
BRANCH="${2:-$CURRENT_BRANCH}"
REPO_SSH="${REPO_SSH:-git@github.com:RSalehin24/ebook-scrapping.git}"
APP_DIR='~/library_app'
DOMAIN="${DOMAIN:-library.rsalehin24.me}"
REMOTE_APP_DIR='$HOME/library_app'

printf '\n[1/4] Syncing code on %s...\n' "$TARGET"
ssh -A "$TARGET" REPO_SSH="$REPO_SSH" BRANCH="$BRANCH" APP_DIR="$REMOTE_APP_DIR" DOMAIN="$DOMAIN" 'bash -s' <<'EOF'
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
set_or_append_env VITE_API_BASE_URL "/api" .env
set_or_append_env NGINX_PORT "80" .env

printf '\nRemote ready at %s\n' "$APP_DIR"
printf 'Branch: %s\n' "$BRANCH"
printf 'PUBLIC_BASE_URL and NGINX_SERVER_NAME set for %s\n' "$DOMAIN"
EOF

printf '\n[2/4] Open remote .env for editing now? [y/N]: '
read -r edit_now
case "${edit_now:-n}" in
  y|Y|yes|YES)
    ssh -t "$TARGET" "cd $APP_DIR && nano .env"
    ;;
  *)
    printf 'Skipped editor. You can edit later with: ssh %s "cd %s && nano .env"\n' "$TARGET" "$APP_DIR"
    ;;
esac

printf '\n[3/4] Start Library stack on EC2 now (docker-compose up -d --build)? [y/N]: '
read -r start_now
case "${start_now:-n}" in
  y|Y|yes|YES)
    ssh -t "$TARGET" "cd $APP_DIR && docker-compose up -d --build"
    ;;
  *)
    printf 'Start later with: ssh %s "cd %s && docker-compose up -d --build"\n' "$TARGET" "$APP_DIR"
    ;;
esac

printf '\n[4/4] Done.\n'
printf 'DNS requirement: point %s -> %s\n' "$DOMAIN" "$TARGET"
printf 'If another app uses port 80 on this host, use scripts/switch-app.sh on EC2 to swap.\n'
