#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
source "$(cd -- "$(dirname -- "${SCRIPT_PATH}")/.." >/dev/null 2>&1 && pwd)/automation/lib/common.sh"
REPO_ROOT="$(repo_root_from "${SCRIPT_PATH}")"
export REPO_ROOT

usage() {
  cat <<'EOF'
Usage:
  logs/show-logs.sh <frontend|backend> [local|remote]

Examples:
  logs/show-logs.sh frontend
  logs/show-logs.sh backend local
  logs/show-logs.sh backend remote
EOF
}

service_name="${1:-}"
target_scope="${2:-local}"
log_file=""

if [[ -z "${service_name}" || "${service_name}" == "-h" || "${service_name}" == "--help" ]]; then
  usage
  exit 0
fi

case "${target_scope}" in
  local)
    ensure_env_file "${REPO_ROOT}/local/env/app.env.example" "${REPO_ROOT}/local/env/.env"
    if [[ "${service_name}" == "frontend" ]]; then
      log_file="${REPO_ROOT}/logs/local/frontend/frontend.log"
      prepare_log_file "${log_file}"
      tail -n 200 -F "${log_file}"
      exit 0
    fi

    if [[ "${service_name}" == "backend" ]]; then
      prepare_log_file "${REPO_ROOT}/logs/local/backend/backend.log"
      prepare_log_file "${REPO_ROOT}/logs/local/celery/worker.log"
      prepare_log_file "${REPO_ROOT}/logs/local/celery/beat.log"
      tail -n 200 -F \
        "${REPO_ROOT}/logs/local/backend/backend.log" \
        "${REPO_ROOT}/logs/local/celery/worker.log" \
        "${REPO_ROOT}/logs/local/celery/beat.log"
      exit 0
    fi

    usage
    die "Unsupported local log target: ${service_name}"
    ;;
  remote)
    load_env_if_present "${REPO_ROOT}/deploy/env/.host.env"
    remote_user="${DEPLOY_USER_NAME:-ubuntu}"
    remote_host="${DEPLOY_IP:-}"
    remote_app_dir="${DEPLOY_REMOTE_APP_DIR:-/home/${remote_user}/library_app}"
    [[ -n "${remote_host}" ]] || die "DEPLOY_IP must be set in deploy/env/.host.env for remote logs."
    remote_target="${remote_user}@${remote_host}"
    log_file="${REPO_ROOT}/logs/remote/${service_name}/${service_name}.log"
    prepare_log_file "${log_file}"

    if [[ "${service_name}" == "frontend" ]]; then
      ssh "${remote_target}" "sudo tail -n 200 -f /var/log/nginx/access.log /var/log/nginx/error.log" 2>&1 | tee -a "${log_file}"
      exit 0
    fi

    if [[ "${service_name}" == "backend" ]]; then
      ssh "${remote_target}" "cd '${remote_app_dir}' && if docker compose version >/dev/null 2>&1; then docker compose --env-file deploy/env/.app.env -f deploy/compose/docker-compose.yml logs -f backend worker beat; else docker-compose --env-file deploy/env/.app.env -f deploy/compose/docker-compose.yml logs -f backend worker beat; fi" 2>&1 | tee -a "${log_file}"
      exit 0
    fi

    usage
    die "Unsupported remote log target: ${service_name}"
    ;;
  *)
    usage
    die "Unsupported log scope: ${target_scope}"
    ;;
esac
