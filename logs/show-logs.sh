#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd -- "$(dirname -- "${SCRIPT_PATH}")/.." >/dev/null 2>&1 && pwd)"
export REPO_ROOT

# shellcheck source=../scripts/lib/common.sh
source "${REPO_ROOT}/scripts/lib/common.sh"

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

if [[ -z "${service_name}" || "${service_name}" == "-h" || "${service_name}" == "--help" ]]; then
  usage
  exit 0
fi

case "${target_scope}" in
  local)
    if [[ "${service_name}" == "frontend" ]]; then
      compose -f "${REPO_ROOT}/docker-compose.yml" -f "${REPO_ROOT}/docker-compose.dev.yml" logs -f frontend
      exit 0
    fi

    if [[ "${service_name}" == "backend" ]]; then
      compose -f "${REPO_ROOT}/docker-compose.yml" -f "${REPO_ROOT}/docker-compose.dev.yml" logs -f backend worker beat
      exit 0
    fi

    usage
    die "Unsupported local log target: ${service_name}"
    ;;
  remote)
    load_env_if_present "${REPO_ROOT}/scripts/.env"
    remote_user="${DEPLOY_USER_NAME:-ubuntu}"
    remote_host="${DEPLOY_IP:-}"
    remote_app_dir="${DEPLOY_REMOTE_APP_DIR:-/home/${remote_user}/library_app}"
    [[ -n "${remote_host}" ]] || die "DEPLOY_IP must be set in scripts/.env for remote logs."
    remote_target="${remote_user}@${remote_host}"

    if [[ "${service_name}" == "frontend" ]]; then
      ssh -t "${remote_target}" "sudo tail -n 200 -f /var/log/nginx/access.log /var/log/nginx/error.log"
      exit 0
    fi

    if [[ "${service_name}" == "backend" ]]; then
      ssh -t "${remote_target}" "cd '${remote_app_dir}' && if docker compose version >/dev/null 2>&1; then docker compose logs -f backend worker beat; else docker-compose logs -f backend worker beat; fi"
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
