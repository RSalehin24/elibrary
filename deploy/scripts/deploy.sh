#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
source "$(cd -- "$(dirname -- "${SCRIPT_PATH}")/../.." >/dev/null 2>&1 && pwd)/automation/lib/common.sh"
REPO_ROOT="$(repo_root_from "${SCRIPT_PATH}")"
export REPO_ROOT

HOST_ENV_TEMPLATE="${REPO_ROOT}/deploy/env/host.env.example"
HOST_ENV_FILE="${REPO_ROOT}/deploy/env/.host.env"
APP_ENV_TEMPLATE="${REPO_ROOT}/deploy/env/app.env.example"
REMOTE_APP_ENV_REL="deploy/env/.app.env"
DEPLOY_COMPOSE_REL="deploy/compose/docker-compose.yml"
REMOTE_SUPER_ADMIN_NOTICE_MARKER="deploy/env/.superadmin_credentials_noted"

usage() {
  cat <<'EOF'
Usage:
  deploy/scripts/deploy.sh [--env-name production|test] [--env-file /path/to/file] [--sync-mode push|preserve|prompt]

Examples:
  deploy/scripts/generate-env.sh production
  deploy/scripts/generate-env.sh host
  deploy/scripts/deploy.sh
  deploy/scripts/deploy.sh --env-name test --sync-mode preserve

On the first successful deployment to a remote app directory, the configured
super admin email and password are printed once so you can record them.
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
  [[ "${database_host}" == "postgres" ]] || die "Action required: DATABASE_URL host must be postgres for docker networking. Found: ${database_host:-<empty>}"

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
    FRONTEND_PORT="${FRONTEND_PORT}" \
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

mkdir -p deploy/env logs/local logs/remote app/backend/storage/staticfiles app/backend/storage/media app/backend/storage/media/scraped-books
python3 automation/lib/env_tools.py scaffold deploy/env/app.env.example deploy/env/.app.env
set_default_env PUBLIC_BASE_URL "https://${DOMAIN}" deploy/env/.app.env
set_default_env PUBLIC_API_ORIGIN "https://${DOMAIN}" deploy/env/.app.env
set_default_env FRONTEND_BASE_URL "https://${DOMAIN}" deploy/env/.app.env
set_default_env VITE_API_BASE_URL "/api" deploy/env/.app.env
set_default_env BACKEND_PORT "${BACKEND_PORT}" deploy/env/.app.env
set_default_env FRONTEND_PORT "${FRONTEND_PORT}" deploy/env/.app.env
set_default_env RUNTIME_STORAGE_DIR "/app/storage" deploy/env/.app.env

printf 'Remote repository ready at %s\n' "${APP_DIR}"
EOF
}

sync_workspace_files() {
  print_info "[3/8] Syncing workspace content to ${TARGET}"
  (
    cd "${REPO_ROOT}"
    COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar --no-mac-metadata -czf - \
      --exclude='.git' \
      --exclude='.DS_Store' \
      --exclude='venv' \
      --exclude='.venv' \
      --exclude='app/frontend/node_modules' \
      --exclude='app/frontend/dist' \
      --exclude='app/frontend/test-results' \
      --exclude='app/frontend/test-artifacts' \
      --exclude='app/backend/storage' \
      --exclude='app/backend/staticfiles' \
      --exclude='app/backend/celerybeat-schedule' \
      --exclude='app/backend/__pycache__' \
      --exclude='app/backend/apps/*/__pycache__' \
      --exclude='tests/backend/__pycache__' \
      --exclude='logs/**/*.log' \
      --exclude='test-artifacts' \
      --exclude='local/env/.env' \
      --exclude='deploy/env/.host.env' \
      --exclude='deploy/env/.production.env' \
      --exclude='deploy/env/.test.env' \
      --exclude='deploy/env/.app.env' \
      --exclude='*.pyc' \
      .
  ) | ssh "${TARGET}" "tar --warning=no-unknown-keyword --no-same-owner --no-same-permissions -xzf - -C '${REMOTE_APP_ABS_DIR}'"
}

sync_remote_env_file() {
  local sync_mode="${1:?sync mode is required}"

  print_info "[4/8] Syncing application env to ${TARGET}"
  if [[ "${sync_mode}" == "preserve" ]]; then
    print_info "Preserving remote ${REMOTE_APP_ENV_REL} values"
    return 0
  fi

  [[ -f "${LOCAL_ENV_FILE}" ]] || die "Action required: local env file not found: ${LOCAL_ENV_FILE}"

  scp "${LOCAL_ENV_FILE}" "${TARGET}:${REMOTE_APP_ABS_DIR}/deploy/env/.env.sync" >/dev/null
  ssh "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && python3 automation/lib/env_tools.py merge ${REMOTE_APP_ENV_REL} deploy/env/.env.sync deploy/env/.app.env.merged --non-empty-only && mv deploy/env/.app.env.merged ${REMOTE_APP_ENV_REL} && rm -f deploy/env/.env.sync"
  print_info "Merged non-empty values from $(basename "${LOCAL_ENV_FILE}") into ${REMOTE_APP_ENV_REL}"
}

ensure_remote_docker() {
  local needs_install

  needs_install="$(
    ssh "${TARGET}" "if ! command -v docker >/dev/null 2>&1; then echo yes; elif [ -n '${DEPLOY_DOCKER_VERSION}' ] && ! docker --version | grep -Fq '${DEPLOY_DOCKER_VERSION}'; then echo yes; else echo no; fi"
  )"

  if [[ "${needs_install}" == "yes" ]]; then
    print_info "[5/8] Installing or upgrading Docker on ${TARGET}"
    ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && sudo bash deploy/scripts/install-docker.sh '${DEPLOY_DOCKER_VERSION}'"
  else
    print_info "[5/8] Docker already satisfies deployment requirements"
  fi
}

start_remote_stack() {
  print_info "[6/8] Starting dockerized frontend and backend on ${TARGET}"
  ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && BACKEND_PORT='${BACKEND_PORT}' FRONTEND_PORT='${FRONTEND_PORT}' bash -s" <<'EOF'
set -euo pipefail

if docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose_cmd=(docker-compose)
else
  echo "Docker Compose is not available after Docker setup." >&2
  exit 1
fi

compose_args=(--env-file deploy/env/.app.env -f deploy/compose/docker-compose.yml)

"${compose_cmd[@]}" "${compose_args[@]}" down --remove-orphans || true
"${compose_cmd[@]}" "${compose_args[@]}" up -d --build --force-recreate

if ! "${compose_cmd[@]}" "${compose_args[@]}" exec -T worker python - <<'PY'
import socket

socket.getaddrinfo('ebanglalibrary.com', 443)
print('ok')
PY
then
  echo "Worker container could not resolve ebanglalibrary.com" >&2
  "${compose_cmd[@]}" "${compose_args[@]}" logs --tail=60 worker
  exit 1
fi

check_published_port() {
  local service="$1"
  local container_port="$2"
  local expected="127.0.0.1:$3"
  local published=""

  for _ in $(seq 1 20); do
    published="$("${compose_cmd[@]}" "${compose_args[@]}" port "${service}" "${container_port}" 2>/dev/null || true)"
    if [[ "${published}" == "${expected}" ]]; then
      return 0
    fi
    sleep 2
  done

  echo "Port binding mismatch for ${service}: expected ${expected}, got ${published:-<none>}" >&2
  "${compose_cmd[@]}" "${compose_args[@]}" ps
  return 1
}

check_published_port backend 8000 "${BACKEND_PORT}"
check_published_port frontend 80 "${FRONTEND_PORT}"
EOF
}

configure_remote_nginx() {
  print_info "[7/8] Configuring host nginx and certbot on ${TARGET}"
  ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && sudo bash deploy/scripts/setup-host-nginx.sh '${DOMAIN}' '${CERTBOT_EMAIL}' '${REMOTE_APP_ABS_DIR}' '${BACKEND_PORT}' '${FRONTEND_PORT}' '${DEPLOY_NGINX_CONFIG_NAME}' '${DEPLOY_NGINX_CONF_DIR}' '${DEPLOY_NGINX_VERSION}'"
}

verify_deployment() {
  local remote_nginx_config_path="${DEPLOY_NGINX_CONF_DIR}/${DEPLOY_NGINX_CONFIG_NAME}"

  print_info "[8/8] Verifying nginx configuration and HTTPS reachability"
  ssh "${TARGET}" "sudo nginx -T 2>/dev/null | grep -Fq '${remote_nginx_config_path}'" || die "Expected nginx config was not loaded: ${remote_nginx_config_path}"
  ssh "${TARGET}" "if command -v curl >/dev/null 2>&1; then curl -fsSIL --max-time 20 https://${DOMAIN}/ >/dev/null && curl -fsSI --max-time 20 https://${DOMAIN}/api/csrf/ >/dev/null; elif command -v wget >/dev/null 2>&1; then wget -q --spider --timeout=20 https://${DOMAIN}/ && wget -q --spider --timeout=20 https://${DOMAIN}/api/csrf/; else exit 127; fi" || die "HTTPS verification failed for https://${DOMAIN}"
  print_info "Deployment verification passed for https://${DOMAIN}"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ensure_env_file "${HOST_ENV_TEMPLATE}" "${HOST_ENV_FILE}"
load_env_if_present "${HOST_ENV_FILE}"

ENV_NAME="${DEPLOY_ENV_NAME:-production}"
LOCAL_ENV_FILE=""
SYNC_MODE="${DEPLOY_ENV_SYNC_MODE:-push}"
SHOW_REMOTE_SUPER_ADMIN_NOTICE="no"
LOCAL_SUPER_ADMIN_EMAIL=""
LOCAL_SUPER_ADMIN_PASSWORD=""

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
  LOCAL_ENV_FILE="${REPO_ROOT}/deploy/env/.${ENV_NAME}.env"
fi

local_env_created="no"
if [[ ! -f "${LOCAL_ENV_FILE}" ]]; then
  ensure_env_file "${APP_ENV_TEMPLATE}" "${LOCAL_ENV_FILE}"
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
FRONTEND_PORT="${FRONTEND_PORT:-4173}"
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

[[ -n "${DEPLOY_IP}" ]] || die "DEPLOY_IP must be set in deploy/env/.host.env"
[[ -n "${DEPLOY_DOMAIN}" ]] || die "DEPLOY_DOMAIN must be set in deploy/env/.host.env"
[[ -n "${DEPLOY_CERTBOT_EMAIL}" ]] || die "DEPLOY_CERTBOT_EMAIL must be set in deploy/env/.host.env"

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

LOCAL_SUPER_ADMIN_EMAIL="$(read_env_value_from_file "${LOCAL_ENV_FILE}" "SUPER_ADMIN_EMAIL")"
LOCAL_SUPER_ADMIN_PASSWORD="$(read_env_value_from_file "${LOCAL_ENV_FILE}" "SUPER_ADMIN_PASSWORD")"

print_info "[1/8] Running deployment preflight checks"
resolved_ips="$(resolve_domain_ips "${DOMAIN}")"
if [[ -z "${resolved_ips}" || "$(printf '%s\n' "${resolved_ips}" | grep -Fx "${DEPLOY_IP}" || true)" == "" ]]; then
  die "DNS A record mismatch for ${DOMAIN}. Expected ${DEPLOY_IP}. Resolved: ${resolved_ips:-<none>}"
fi

ssh -o BatchMode=yes -o ConnectTimeout=10 "${TARGET}" "echo connected" >/dev/null 2>&1 || die "SSH key access to ${TARGET} is not working."
ssh -o BatchMode=yes "${TARGET}" "sudo -n true" >/dev/null 2>&1 || die "Passwordless sudo is required for fully automated deployment on ${TARGET}."

sync_remote_repository
sync_workspace_files

if ssh "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && test -f '${REMOTE_SUPER_ADMIN_NOTICE_MARKER}'" >/dev/null 2>&1; then
  SHOW_REMOTE_SUPER_ADMIN_NOTICE="no"
else
  SHOW_REMOTE_SUPER_ADMIN_NOTICE="yes"
fi

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

remote_env_choice="$(timed_prompt "Edit remote deploy/env/.app.env now? [y/N] (auto-continue in 5s): " 5 "n")"
if [[ "${remote_env_choice}" =~ ^[Yy]$ ]]; then
  ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && ${DEPLOY_REMOTE_EDITOR} ${REMOTE_APP_ENV_REL}"
fi

ensure_remote_docker
start_remote_stack
configure_remote_nginx
verify_deployment

if [[ "${SHOW_REMOTE_SUPER_ADMIN_NOTICE}" == "yes" ]]; then
  print_super_admin_credentials \
    "${LOCAL_SUPER_ADMIN_EMAIL}" \
    "${LOCAL_SUPER_ADMIN_PASSWORD}" \
    "First remote deployment super admin credentials" \
    "Note these credentials down carefully for future usage. This deployment script will not show them again for this remote target."
  ssh "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && touch '${REMOTE_SUPER_ADMIN_NOTICE_MARKER}'"
fi
