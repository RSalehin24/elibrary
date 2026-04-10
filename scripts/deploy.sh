#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${SCRIPT_PATH}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
export REPO_ROOT

# shellcheck source=./lib/common.sh
source "${REPO_ROOT}/scripts/lib/common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy.sh [--env-name production|test] [--env-file /path/to/file] [--sync-mode push|preserve|prompt]

Examples:
  scripts/generate-env.sh production
  scripts/generate-env.sh deploy
  scripts/deploy.sh
  scripts/deploy.sh --env-name test --sync-mode preserve
EOF
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

extract_database_url_host() {
  python3 - "$1" <<'PY'
from urllib.parse import urlparse
import sys

parsed = urlparse((sys.argv[1] or "").strip())
print(parsed.hostname or "")
PY
}

extract_database_url_user() {
  python3 - "$1" <<'PY'
from urllib.parse import urlparse
import sys

parsed = urlparse((sys.argv[1] or "").strip())
print(parsed.username or "")
PY
}

require_non_empty_env_key() {
  local env_file="${1:?env file is required}"
  local key_name="${2:?env key is required}"
  local value
  value="$(grep "^${key_name}=" "${env_file}" | tail -n 1 | cut -d '=' -f2- || true)"
  [[ -n "${value}" ]] || die "Action required: ${key_name} must be set in ${env_file}"
}

validate_local_database_env() {
  local env_file="${1:?env file is required}"
  local database_url database_host database_user postgres_user

  [[ -f "${env_file}" ]] || die "Action required: missing env file ${env_file}"
  database_url="$(grep '^DATABASE_URL=' "${env_file}" | tail -n 1 | cut -d '=' -f2- || true)"
  [[ -n "${database_url}" ]] || die "Action required: DATABASE_URL is missing in ${env_file}"

  database_host="$(extract_database_url_host "${database_url}")"
  [[ "${database_host}" == "postgres" ]] || die "Action required: DATABASE_URL host must be postgres for docker-compose networking. Found: ${database_host:-<empty>}"

  database_user="$(extract_database_url_user "${database_url}")"
  postgres_user="$(grep '^POSTGRES_USER=' "${env_file}" | tail -n 1 | cut -d '=' -f2- || true)"
  if [[ -n "${postgres_user}" && -n "${database_user}" && "${database_user}" != "${postgres_user}" ]]; then
    die "Action required: DATABASE_URL username (${database_user}) and POSTGRES_USER (${postgres_user}) must match in ${env_file}"
  fi
}

sync_remote_repository() {
  print_info "[2/8] Syncing repository on ${TARGET}"
  ssh -A "${TARGET}" \
    REPO_SSH="${REPO_SSH}" \
    BRANCH="${BRANCH}" \
    APP_DIR="${REMOTE_APP_DIR}" \
    DOMAIN="${DOMAIN}" \
    BACKEND_PORT="${BACKEND_PORT}" \
    'bash -s' <<'EOF'
set -euo pipefail

set_default_env() {
  local key="$1"
  local value="$2"
  local file="$3"

  if grep -q "^${key}=" "${file}"; then
    local current_value
    current_value="$(grep "^${key}=" "${file}" | head -n 1 | cut -d '=' -f2-)"
    if [[ -z "${current_value}" ]]; then
      sed -i "s|^${key}=.*|${key}=${value}|" "${file}"
    fi
  else
    printf '\n%s=%s\n' "${key}" "${value}" >>"${file}"
  fi
}

mkdir -p "${APP_DIR}"
if [[ -d "${APP_DIR}/.git" ]]; then
  cd "${APP_DIR}"
  git fetch origin "${BRANCH}"
  if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    git checkout "${BRANCH}"
  else
    git checkout -B "${BRANCH}" "origin/${BRANCH}"
  fi
  git reset --hard "origin/${BRANCH}"
else
  rm -rf "${APP_DIR}"
  git clone "${REPO_SSH}" "${APP_DIR}"
  cd "${APP_DIR}"
  git checkout -B "${BRANCH}" "origin/${BRANCH}"
fi

python3 scripts/env_tools.py scaffold .env.example .env
set_default_env PUBLIC_BASE_URL "https://${DOMAIN}" .env
set_default_env VITE_API_BASE_URL "/api" .env
set_default_env BACKEND_PORT "${BACKEND_PORT}" .env
set_default_env HOST_STATIC_DIR "./storage/staticfiles" .env
set_default_env HOST_MEDIA_DIR "./storage/media" .env

mkdir -p storage/staticfiles storage/media
printf 'Remote repository ready at %s\n' "${APP_DIR}"
EOF
}

sync_workspace_files() {
  print_info "[3/8] Syncing workspace content to ${TARGET}"
  (
    cd "${REPO_ROOT}"
    COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar --no-mac-metadata -czf - \
      --exclude='.git' \
      --exclude='.env' \
      --exclude='.env.production' \
      --exclude='.env.test' \
      --exclude='scripts/.env' \
      --exclude='.DS_Store' \
      --exclude='venv' \
      --exclude='.venv' \
      --exclude='frontend/node_modules' \
      --exclude='frontend/dist' \
      --exclude='frontend/test-results' \
      --exclude='frontend/test-artifacts' \
      --exclude='storage' \
      --exclude='backend/storage' \
      --exclude='backend/staticfiles' \
      --exclude='backend/outputs' \
      --exclude='backend/celerybeat-schedule' \
      --exclude='backend/__pycache__' \
      --exclude='backend/apps/*/__pycache__' \
      --exclude='backend/tests/__pycache__' \
      --exclude='test-artifacts' \
      --exclude='*.pyc' \
      .
  ) | ssh "${TARGET}" "tar --warning=no-unknown-keyword --no-same-owner --no-same-permissions -xzf - -C '${REMOTE_APP_ABS_DIR}'"
}

sync_remote_env_file() {
  local sync_mode="${1:?sync mode is required}"

  print_info "Preparing remote environment file"
  if [[ "${sync_mode}" == "preserve" ]]; then
    print_info "Preserving remote .env values"
    return 0
  fi

  [[ -f "${LOCAL_ENV_FILE}" ]] || die "Action required: local env file not found: ${LOCAL_ENV_FILE}"

  scp "${LOCAL_ENV_FILE}" "${TARGET}:${REMOTE_APP_ABS_DIR}/.env.sync" >/dev/null
  ssh "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && python3 scripts/env_tools.py merge .env .env.sync .env.merged --non-empty-only && mv .env.merged .env && rm -f .env.sync"
  print_info "Merged non-empty values from $(basename "${LOCAL_ENV_FILE}") into remote .env"
}

ensure_remote_docker() {
  local needs_install

  needs_install="$(
    ssh "${TARGET}" "if ! command -v docker >/dev/null 2>&1; then echo yes; elif [ -n '${DEPLOY_DOCKER_VERSION}' ] && ! docker --version | grep -Fq '${DEPLOY_DOCKER_VERSION}'; then echo yes; else echo no; fi"
  )"

  if [[ "${needs_install}" == "yes" ]]; then
    print_info "[4/8] Installing or upgrading Docker on ${TARGET}"
    ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && sudo bash scripts/install-docker.sh '${DEPLOY_DOCKER_VERSION}'"
  else
    print_info "[4/8] Docker already satisfies deployment requirements"
  fi
}

build_frontend_dist() {
  print_info "[5/8] Building frontend bundle on ${TARGET}"
  ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && docker run --rm -v \"\$PWD/frontend:/app\" -w /app node:22-alpine sh -lc 'npm ci && npm run build'"
}

start_remote_stack() {
  print_info "[6/8] Starting application services on ${TARGET}"
  ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && BACKEND_PORT='${BACKEND_PORT}' bash -s" <<'EOF'
set -euo pipefail

if docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose_cmd=(docker-compose)
else
  echo "Docker Compose is not available after Docker setup." >&2
  exit 1
fi

"${compose_cmd[@]}" down --remove-orphans || true
"${compose_cmd[@]}" up -d --build --force-recreate

if ! "${compose_cmd[@]}" exec -T worker python - <<'PY'
import socket

socket.getaddrinfo('ebanglalibrary.com', 443)
print('ok')
PY
then
  echo "Worker container could not resolve ebanglalibrary.com" >&2
  "${compose_cmd[@]}" logs --tail=60 worker
  exit 1
fi

expected_port="127.0.0.1:${BACKEND_PORT}"
published_port=""
for _ in $(seq 1 15); do
  published_port="$("${compose_cmd[@]}" port backend 8000 2>/dev/null || true)"
  if [[ "${published_port}" == "${expected_port}" ]]; then
    break
  fi
  sleep 2
done

if [[ "${published_port}" != "${expected_port}" ]]; then
  echo "Backend port binding mismatch: expected ${expected_port}, got ${published_port:-<none>}" >&2
  "${compose_cmd[@]}" ps
  exit 1
fi
EOF
}

configure_remote_nginx() {
  print_info "[7/8] Configuring host nginx and certbot on ${TARGET}"
  ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && sudo bash scripts/setup-host-nginx.sh '${DOMAIN}' '${CERTBOT_EMAIL}' '${REMOTE_APP_ABS_DIR}' '${BACKEND_PORT}' '${DEPLOY_NGINX_CONFIG_NAME}' '${DEPLOY_NGINX_CONF_DIR}' '${DEPLOY_NGINX_VERSION}'"
}

verify_deployment() {
  local remote_nginx_config_path="${DEPLOY_NGINX_CONF_DIR}/${DEPLOY_NGINX_CONFIG_NAME}"

  print_info "[8/8] Verifying nginx configuration and HTTPS reachability"
  ssh "${TARGET}" "sudo nginx -T 2>/dev/null | grep -Fq '${remote_nginx_config_path}'" || die "Expected nginx config was not loaded: ${remote_nginx_config_path}"
  ssh "${TARGET}" "if command -v curl >/dev/null 2>&1; then curl -fsSIL --max-time 20 https://${DOMAIN} >/dev/null; elif command -v wget >/dev/null 2>&1; then wget -q --spider --timeout=20 https://${DOMAIN}; else exit 127; fi" || die "HTTPS verification failed for https://${DOMAIN}"
  print_info "Deployment verification passed for https://${DOMAIN}"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ensure_env_file "${REPO_ROOT}/scripts/.env.example" "${REPO_ROOT}/scripts/.env"
load_env_if_present "${REPO_ROOT}/scripts/.env"

ENV_NAME="${DEPLOY_ENV_NAME:-production}"
LOCAL_ENV_FILE=""
SYNC_MODE="${DEPLOY_ENV_SYNC_MODE:-push}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-name)
      ENV_NAME="${2:?--env-name requires a value}"
      shift 2
      ;;
    --env-file)
      LOCAL_ENV_FILE="${2:?--env-file requires a value}"
      shift 2
      ;;
    --sync-mode)
      SYNC_MODE="${2:?--sync-mode requires a value}"
      shift 2
      ;;
    *)
      usage
      die "Unsupported argument: $1"
      ;;
  esac
done

if [[ -z "${LOCAL_ENV_FILE}" ]]; then
  LOCAL_ENV_FILE="${REPO_ROOT}/.env.${ENV_NAME}"
fi

local_env_created="no"
if [[ ! -f "${LOCAL_ENV_FILE}" ]]; then
  ensure_env_file "${REPO_ROOT}/.env.example" "${LOCAL_ENV_FILE}"
  local_env_created="yes"
fi

DEPLOY_USER_NAME="${DEPLOY_USER_NAME:-ubuntu}"
DEPLOY_IP="${DEPLOY_IP:-}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-}"
DEPLOY_CERTBOT_EMAIL="${DEPLOY_CERTBOT_EMAIL:-}"
DEPLOY_NGINX_CONF_DIR="${DEPLOY_NGINX_CONF_DIR:-/etc/nginx/conf.d}"
DEPLOY_NGINX_CONFIG_NAME="${DEPLOY_NGINX_CONFIG_NAME:-${DEPLOY_DOMAIN}.conf}"
DEPLOY_NGINX_VERSION="${DEPLOY_NGINX_VERSION:-1.29.4}"
DEPLOY_DOCKER_VERSION="${DEPLOY_DOCKER_VERSION:-}"
DEPLOY_REMOTE_EDITOR="${DEPLOY_REMOTE_EDITOR:-${EDITOR:-nano}}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
REPO_SSH="${REPO_SSH:-git@github.com:RSalehin24/ebook-scrapping.git}"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'main')"
BRANCH="${DEPLOY_BRANCH_NAME:-${CURRENT_BRANCH}}"
TARGET="${DEPLOY_USER_NAME}@${DEPLOY_IP}"
DOMAIN="${DEPLOY_DOMAIN}"
CERTBOT_EMAIL="${DEPLOY_CERTBOT_EMAIL}"
REMOTE_APP_DIR='~/library_app'
REMOTE_APP_ABS_DIR="${DEPLOY_REMOTE_APP_DIR:-/home/${DEPLOY_USER_NAME}/library_app}"

case "${DEPLOY_NGINX_CONFIG_NAME}" in
  *.conf) ;;
  *) DEPLOY_NGINX_CONFIG_NAME="${DEPLOY_NGINX_CONFIG_NAME}.conf" ;;
esac

require_cmd ssh
require_cmd scp
require_cmd git
require_cmd python3

[[ -n "${DEPLOY_IP}" ]] || die "DEPLOY_IP must be set in scripts/.env"
[[ -n "${DEPLOY_DOMAIN}" ]] || die "DEPLOY_DOMAIN must be set in scripts/.env"
[[ -n "${DEPLOY_CERTBOT_EMAIL}" ]] || die "DEPLOY_CERTBOT_EMAIL must be set in scripts/.env"

if [[ "${local_env_created}" == "yes" ]]; then
  choice="$(timed_prompt "Prepared ${LOCAL_ENV_FILE}. Edit it now? [y/N] (auto-continue in 5s): " 5 "n")"
  if [[ "${choice}" =~ ^[Yy]$ ]]; then
    "${EDITOR:-nano}" "${LOCAL_ENV_FILE}"
  fi
fi

validate_local_database_env "${LOCAL_ENV_FILE}"
require_non_empty_env_key "${LOCAL_ENV_FILE}" "DJANGO_SECRET_KEY"
require_non_empty_env_key "${LOCAL_ENV_FILE}" "SUPER_ADMIN_EMAIL"
require_non_empty_env_key "${LOCAL_ENV_FILE}" "SUPER_ADMIN_PASSWORD"

print_info "[1/8] Running deployment preflight checks"
resolved_ips="$(resolve_domain_ips "${DOMAIN}")"
if [[ -z "${resolved_ips}" || "$(printf '%s\n' "${resolved_ips}" | grep -Fx "${DEPLOY_IP}" || true)" == "" ]]; then
  die "DNS A record mismatch for ${DOMAIN}. Expected ${DEPLOY_IP}. Resolved: ${resolved_ips:-<none>}"
fi

ssh -o BatchMode=yes -o ConnectTimeout=10 "${TARGET}" "echo connected" >/dev/null 2>&1 || die "SSH key access to ${TARGET} is not working."
ssh -o BatchMode=yes "${TARGET}" "sudo -n true" >/dev/null 2>&1 || die "Passwordless sudo is required for fully automated deployment on ${TARGET}."

sync_remote_repository
sync_workspace_files

case "${SYNC_MODE}" in
  push|preserve) ;;
  prompt)
    SYNC_MODE="$(timed_prompt "Remote env sync mode [push/preserve] (default preserve, auto-continue in 5s): " 5 "preserve")"
    [[ "${SYNC_MODE}" == "push" || "${SYNC_MODE}" == "preserve" ]] || SYNC_MODE="preserve"
    ;;
  *)
    die "Unsupported sync mode: ${SYNC_MODE}"
    ;;
esac

sync_remote_env_file "${SYNC_MODE}"

remote_env_choice="$(timed_prompt "Edit remote .env now? [y/N] (auto-continue in 5s): " 5 "n")"
if [[ "${remote_env_choice}" =~ ^[Yy]$ ]]; then
  ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && ${DEPLOY_REMOTE_EDITOR} .env"
fi

ensure_remote_docker
build_frontend_dist
start_remote_stack
configure_remote_nginx
verify_deployment
