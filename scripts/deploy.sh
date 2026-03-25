#!/bin/sh

set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy.sh

Example:
  cp .env.example .env.production
  nano .env.production
  scripts/deploy.sh

Optional env sync control:
  DEPLOY_ENV_SYNC_MODE=push       # default behavior (overwrite remote .env with local .env.production)
  DEPLOY_ENV_SYNC_MODE=preserve   # do not overwrite remote .env
  DEPLOY_ENV_SYNC_MODE=prompt     # ask during deploy when running interactively

What it does:
  1) Runs preflight checks (DNS/SSH/sudo/docker)
  2) Syncs code on the remote server
  3) Syncs local workspace files to remote app dir
  4) Builds frontend dist on the remote machine
  5) Starts Docker Compose app stack (without nginx)
  6) Configures host nginx + certbot automatically
  7) Verifies nginx loaded exact config file
  8) Verifies HTTPS endpoint
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
DEFAULT_ENV_FILE="$SCRIPT_DIR/.env.example"
LOCAL_PRODUCTION_ENV_FILE="$REPO_ROOT/.env.production"
LOCAL_DEFAULT_PRODUCTION_ENV_FILE="$REPO_ROOT/.env.example"

if [ ! -f "$LOCAL_PRODUCTION_ENV_FILE" ]; then
  if [ -f "$LOCAL_DEFAULT_PRODUCTION_ENV_FILE" ]; then
    cp "$LOCAL_DEFAULT_PRODUCTION_ENV_FILE" "$LOCAL_PRODUCTION_ENV_FILE"
    printf 'Created %s from %s\n' "$LOCAL_PRODUCTION_ENV_FILE" "$LOCAL_DEFAULT_PRODUCTION_ENV_FILE"
    if [ -t 0 ]; then
      printf 'Open %s now to edit values? [Y/n]: ' "$LOCAL_PRODUCTION_ENV_FILE"
      read -r local_edit_choice || true
      case "${local_edit_choice:-}" in
        N|n|no|NO) ;;
        *)
          LOCAL_EDITOR="${EDITOR:-nano}"
          "$LOCAL_EDITOR" "$LOCAL_PRODUCTION_ENV_FILE"
          ;;
      esac
    else
      printf 'Action required: update %s before deploying (non-interactive session).\n' "$LOCAL_PRODUCTION_ENV_FILE"
      exit 1
    fi
  else
    printf 'Missing %s\n' "$LOCAL_DEFAULT_PRODUCTION_ENV_FILE"
    exit 1
  fi
elif [ -t 0 ]; then
  printf 'Local %s exists. Edit now? [y/N]: ' "$LOCAL_PRODUCTION_ENV_FILE"
  read -r local_edit_choice || true
  case "${local_edit_choice:-}" in
    Y|y|yes|YES)
      LOCAL_EDITOR="${EDITOR:-nano}"
      "$LOCAL_EDITOR" "$LOCAL_PRODUCTION_ENV_FILE"
      ;;
    *) ;;
  esac
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
else
  printf 'Optional config not found: %s (using defaults or current shell env)\n' "$ENV_FILE"
fi

DEPLOY_USER_NAME="${DEPLOY_USER_NAME:-ubuntu}"
DEPLOY_IP="${DEPLOY_IP:-54.169.28.248}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-library.rsalehin24.me}"
DEPLOY_CERTBOT_EMAIL="${DEPLOY_CERTBOT_EMAIL:-rsalehin24@gmail.com}"
DEPLOY_NGINX_CONF_DIR="${DEPLOY_NGINX_CONF_DIR:-/etc/nginx/conf.d}"
DEPLOY_NGINX_CONFIG_NAME="${DEPLOY_NGINX_CONFIG_NAME:-library.salehin24.me.conf}"
DEPLOY_NGINX_VERSION="${DEPLOY_NGINX_VERSION:-1.29.4}"

case "$DEPLOY_NGINX_CONFIG_NAME" in
  *.conf) ;;
  *) DEPLOY_NGINX_CONFIG_NAME="${DEPLOY_NGINX_CONFIG_NAME}.conf" ;;
esac

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
REMOTE_APP_ABS_DIR="/home/${DEPLOY_USER_NAME}/library_app"
REMOTE_NGINX_CONFIG_PATH="${DEPLOY_NGINX_CONF_DIR}/${DEPLOY_NGINX_CONFIG_NAME}"
DEPLOY_ENV_SYNC_MODE="${DEPLOY_ENV_SYNC_MODE:-push}"
REMOTE_EDITOR="${DEPLOY_REMOTE_EDITOR:-${EDITOR:-nano}}"

require_cmd() {
  cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'Action required: install `%s` on local machine and rerun.\n' "$cmd"
    exit 1
  fi
}

resolve_domain_ips() {
  python3 - "$1" <<'PY'
import socket
import sys

domain = sys.argv[1]
try:
    _name, _aliases, ips = socket.gethostbyname_ex(domain)
except Exception:
    ips = []

print("\n".join(sorted(set(ips))))
PY
}

require_cmd ssh
require_cmd scp
require_cmd python3
require_cmd git

printf '\n[1/8] Running preflight checks...\n'

resolved_ips="$(resolve_domain_ips "$DOMAIN")"
if [ -z "$resolved_ips" ] || ! printf '%s\n' "$resolved_ips" | grep -Fxq "$DEPLOY_IP"; then
  printf 'Action required: DNS A record mismatch for %s.\n' "$DOMAIN"
  printf 'Expected IP: %s\n' "$DEPLOY_IP"
  printf 'Resolved IPs:\n%s\n' "${resolved_ips:-<none>}"
  printf 'Update DNS and rerun: bash scripts/deploy.sh\n'
  exit 1
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" "echo connected" >/dev/null 2>&1; then
  printf 'Action required: SSH key access to %s is not working.\n' "$TARGET"
  printf 'Fix SSH auth (or host reachability) and rerun: bash scripts/deploy.sh\n'
  exit 1
fi

if ! ssh -o BatchMode=yes "$TARGET" "sudo -n true" >/dev/null 2>&1; then
  printf 'Action required: passwordless sudo is required for fully automated deploy on %s.\n' "$TARGET"
  printf 'Grant NOPASSWD sudo for this user, then rerun: bash scripts/deploy.sh\n'
  exit 1
fi

if ! ssh "$TARGET" "command -v docker >/dev/null 2>&1"; then
  printf 'Action required: Docker is not installed on %s.\n' "$TARGET"
  printf 'Install Docker, then rerun: bash scripts/deploy.sh\n'
  exit 1
fi

if ! ssh "$TARGET" "docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1"; then
  printf 'Action required: Docker Compose is not available on %s.\n' "$TARGET"
  printf 'Install docker compose plugin or docker-compose binary, then rerun: bash scripts/deploy.sh\n'
  exit 1
fi

if [ -f "$SCRIPT_DIR/switch-app.sh" ]; then
  scp "$SCRIPT_DIR/switch-app.sh" "$TARGET:~/switch-app.sh" >/dev/null
  ssh "$TARGET" "chmod +x ~/switch-app.sh"
fi

remote_has_env_before='no'
if ssh "$TARGET" "test -f '$REMOTE_APP_ABS_DIR/.env'" >/dev/null 2>&1; then
  remote_has_env_before='yes'
fi

printf '\n[2/8] Syncing code on %s...\n' "$TARGET"
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
  git fetch origin "$BRANCH"
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git checkout "$BRANCH"
  else
    git checkout -B "$BRANCH" "origin/$BRANCH"
  fi
  git reset --hard "origin/$BRANCH"
else
  rm -rf "$APP_DIR"
  git clone "$REPO_SSH" "$APP_DIR"
  cd "$APP_DIR"
  git checkout -B "$BRANCH" "origin/$BRANCH"
fi

if [ ! -f .env ]; then
  cp .env.example .env
fi

set_default_env PUBLIC_BASE_URL "https://${DOMAIN}" .env
set_default_env VITE_API_BASE_URL "/api" .env
set_default_env BACKEND_PORT "$BACKEND_PORT" .env
set_default_env HOST_STATIC_DIR "./storage/staticfiles" .env
set_default_env HOST_MEDIA_DIR "./storage/media" .env

detected_dns="$(awk '/^nameserver / && $2 !~ /^127\./ {print $2; exit}' /run/systemd/resolve/resolv.conf 2>/dev/null || true)"
if [ -z "$detected_dns" ]; then
  detected_dns="169.254.169.253"
fi
set_default_env CONTAINER_DNS "$detected_dns" .env
set_default_env CONTAINER_DNS_FALLBACK "8.8.8.8" .env

mkdir -p storage/staticfiles storage/media

printf '\nRemote ready at %s\n' "$APP_DIR"
printf 'Branch: %s\n' "$BRANCH"
printf 'Remote .env defaults ensured (existing values preserved)\n'
EOF

printf '\n[3/8] Syncing local workspace to %s...\n' "$TARGET"
sync_remote_env='preserve'
case "$DEPLOY_ENV_SYNC_MODE" in
  push|preserve)
    sync_remote_env="$DEPLOY_ENV_SYNC_MODE"
    ;;
  prompt)
    if [ -t 0 ]; then
      printf 'Remote .env sync mode [P]reserve/[U]push local (default P): '
      read -r env_sync_choice || true
      case "${env_sync_choice:-}" in
        U|u|push|PUSH) sync_remote_env='push' ;;
        *) sync_remote_env='preserve' ;;
      esac
    fi
    ;;
  *)
    printf 'Action required: invalid DEPLOY_ENV_SYNC_MODE=%s (allowed: preserve|push|prompt)\n' "$DEPLOY_ENV_SYNC_MODE"
    exit 1
    ;;
esac

if [ "$sync_remote_env" = 'push' ]; then
  if [ ! -f "$LOCAL_PRODUCTION_ENV_FILE" ]; then
    printf 'Action required: local %s not found, cannot push env to remote.\n' "$LOCAL_PRODUCTION_ENV_FILE"
    exit 1
  fi
  printf 'Applying local %s to remote .env\n' "$LOCAL_PRODUCTION_ENV_FILE"
  scp "$LOCAL_PRODUCTION_ENV_FILE" "$TARGET:$REMOTE_APP_ABS_DIR/.env" >/dev/null
else
  printf 'Preserving remote .env (no overwrite)\n'
fi

if ! ssh "$TARGET" "test -f '$REMOTE_APP_ABS_DIR/.env'" >/dev/null 2>&1; then
  printf 'Action required: remote .env is missing at %s/.env\n' "$REMOTE_APP_ABS_DIR"
  exit 1
fi

if [ -t 0 ]; then
  edit_remote_env='no'
  if [ "$sync_remote_env" = 'push' ]; then
    printf 'Remote .env was updated from local .env.production. Edit remote .env now? [y/N]: '
    read -r edit_env_choice || true
    case "${edit_env_choice:-}" in
      Y|y|yes|YES) edit_remote_env='yes' ;;
      *) edit_remote_env='no' ;;
    esac
  elif [ "$remote_has_env_before" = 'yes' ]; then
    printf 'Remote .env already exists. Edit remote .env now? [y/N]: '
    read -r edit_env_choice || true
    case "${edit_env_choice:-}" in
      Y|y|yes|YES) edit_remote_env='yes' ;;
      *) edit_remote_env='no' ;;
    esac
  else
    printf 'Remote .env was created from .env.example. Input values now by editing remote .env? [Y/n]: '
    read -r edit_env_choice || true
    case "${edit_env_choice:-}" in
      N|n|no|NO) edit_remote_env='no' ;;
      *) edit_remote_env='yes' ;;
    esac
  fi

  if [ "$edit_remote_env" = 'yes' ]; then
    printf 'Opening remote .env using %s\n' "$REMOTE_EDITOR"
    ssh -t "$TARGET" "cd '$REMOTE_APP_ABS_DIR' && $REMOTE_EDITOR .env"
  fi
else
  printf 'Non-interactive session: skipped remote .env edit prompt.\n'
fi

(cd "$REPO_ROOT" && COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar --no-mac-metadata -czf - \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='.env.production' \
  --exclude='scripts/.env' \
  --exclude='.DS_Store' \
  --exclude='venv' \
  --exclude='.venv' \
  --exclude='frontend/node_modules' \
  --exclude='frontend/dist' \
  --exclude='storage' \
  --exclude='backend/storage' \
  --exclude='backend/staticfiles' \
  --exclude='backend/outputs' \
  --exclude='backend/celerybeat-schedule' \
  --exclude='backend/__pycache__' \
  --exclude='backend/apps/*/__pycache__' \
  --exclude='backend/tests/__pycache__' \
  --exclude='*.pyc' \
  .) | ssh "$TARGET" "tar --warning=no-unknown-keyword --no-same-owner --no-same-permissions -xzf - -C '$REMOTE_APP_ABS_DIR'"

printf '\n[4/8] Building frontend dist on %s...\n' "$TARGET"
ssh -t "$TARGET" "cd $APP_DIR && \
  docker run --rm -v \"\$PWD/frontend:/app\" -w /app node:22-alpine sh -lc 'npm ci && npm run build'"

printf '\n[5/8] Starting app stack on %s...\n' "$TARGET"
ssh -t "$TARGET" "cd $APP_DIR && BACKEND_PORT='$BACKEND_PORT' sh -s" <<'EOF'
set -eu

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD='docker compose'
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD='docker-compose'
else
  echo 'Docker Compose not found. Install docker compose plugin or docker-compose binary.'
  exit 127
fi

$COMPOSE_CMD down --remove-orphans || true
$COMPOSE_CMD up -d --build --force-recreate

if ! $COMPOSE_CMD exec -T worker python - <<'PY'
import socket

socket.getaddrinfo('ebanglalibrary.com', 443)
print('ok')
PY
then
  echo "Action required: worker container DNS cannot resolve ebanglalibrary.com"
  echo "Check server resolver/network egress and rerun: bash scripts/deploy.sh"
  $COMPOSE_CMD logs --tail=60 worker
  exit 1
fi

published_port=''
attempt=0
while [ "$attempt" -lt 15 ]; do
  published_port="$($COMPOSE_CMD port backend 8000 2>/dev/null || true)"
  if [ "$published_port" = "127.0.0.1:${BACKEND_PORT}" ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done

if [ "$published_port" != "127.0.0.1:${BACKEND_PORT}" ]; then
  echo "Action required: backend port binding mismatch. Expected 127.0.0.1:${BACKEND_PORT}, got '${published_port:-<none>}'"
  echo "Compose resolved backend ports:"
  $COMPOSE_CMD config | sed -n '/backend:/,/^[^[:space:]]/p' | sed -n '/ports:/,/^[^[:space:]]/p' || true
  $COMPOSE_CMD ps
  exit 1
fi
EOF

printf '\n[6/8] Configuring host nginx + certbot on %s...\n' "$TARGET"
ssh -t "$TARGET" "cd $APP_DIR && sudo sh scripts/setup-host-nginx.sh '$DOMAIN' '$CERTBOT_EMAIL' '$REMOTE_APP_ABS_DIR' '$BACKEND_PORT' '$DEPLOY_NGINX_CONFIG_NAME' '$DEPLOY_NGINX_CONF_DIR' '$DEPLOY_NGINX_VERSION'"

printf '\n[7/8] Verifying nginx loaded config path...\n'
if ! ssh "$TARGET" "sudo nginx -T 2>/dev/null | grep -Fq '$REMOTE_NGINX_CONFIG_PATH'"; then
  printf 'Action required: nginx did not load expected config file %s\n' "$REMOTE_NGINX_CONFIG_PATH"
  printf 'Check include directives and conf directory, then rerun: bash scripts/deploy.sh\n'
  exit 1
fi
printf 'OK: nginx loaded config file %s\n' "$REMOTE_NGINX_CONFIG_PATH"

printf '\n[8/8] Verifying HTTPS endpoint...\n'
if ! ssh "$TARGET" "if command -v curl >/dev/null 2>&1; then curl -fsSIL --max-time 20 https://$DOMAIN >/dev/null; elif command -v wget >/dev/null 2>&1; then wget -q --spider --timeout=20 https://$DOMAIN; else exit 127; fi"; then
  printf 'Action required: HTTPS verification failed for https://%s\n' "$DOMAIN"
  printf 'If curl/wget is missing on server, install one and rerun.\n'
  printf 'Check remote logs: sudo nginx -t && sudo systemctl status nginx --no-pager && sudo journalctl -u nginx -n 100 --no-pager\n'
  exit 1
fi
printf 'OK: HTTPS endpoint reachable at https://%s\n' "$DOMAIN"
