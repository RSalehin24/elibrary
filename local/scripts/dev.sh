#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
source "$(cd -- "$(dirname -- "${SCRIPT_PATH}")/../.." >/dev/null 2>&1 && pwd)/automation/lib/common.sh"
REPO_ROOT="$(repo_root_from "${SCRIPT_PATH}")"
export REPO_ROOT

APP_ENV_FILE="${REPO_ROOT}/local/env/.env"
COMPOSE_ENV_FILE="${REPO_ROOT}/local/env/.compose.env"
COMPOSE_ARGS=(--env-file "${COMPOSE_ENV_FILE}" -f "${REPO_ROOT}/local/compose/docker-compose.yml")
DEFAULT_SERVICES=(postgres redis backend worker beat frontend)

usage() {
  cat <<'EOF'
Usage:
  local/scripts/dev.sh [up|down|restart|logs|ps] [service...]

Examples:
  local/scripts/dev.sh
  local/scripts/dev.sh up
  local/scripts/dev.sh logs backend
  local/scripts/dev.sh down

Every non-help run prints the effective local super admin email and password.
EOF
}

command_name="${1:-up}"
if [[ $# -gt 0 ]]; then
  shift
fi

ensure_env_file "${REPO_ROOT}/local/env/app.env.example" "${APP_ENV_FILE}"
load_env_if_present "${APP_ENV_FILE}"
prepare_compose_env_file "${APP_ENV_FILE}" "${COMPOSE_ENV_FILE}"

SUPER_ADMIN_EMAIL_EFFECTIVE="$(effective_env_value SUPER_ADMIN_EMAIL "admin@example.com")"
SUPER_ADMIN_PASSWORD_EFFECTIVE="$(effective_env_value SUPER_ADMIN_PASSWORD "changeme")"

if [[ "${command_name}" != "-h" && "${command_name}" != "--help" && "${command_name}" != "help" ]]; then
  print_super_admin_credentials \
    "${SUPER_ADMIN_EMAIL_EFFECTIVE}" \
    "${SUPER_ADMIN_PASSWORD_EFFECTIVE}" \
    "Local super admin credentials" \
    "Keep these credentials available for local access and browser testing."
fi

case "${command_name}" in
  up)
    print_info "Starting local development stack with watching enabled."
    compose "${COMPOSE_ARGS[@]}" up --build "${DEFAULT_SERVICES[@]}" "$@"
    cat <<EOF
Local development stack is running.

Frontend: http://127.0.0.1:${FRONTEND_PORT:-5173}
Backend:  http://127.0.0.1:${BACKEND_PORT:-8000}

Use:
  local/scripts/dev.sh logs frontend
  local/scripts/dev.sh logs backend
  local/scripts/dev.sh down
EOF
    ;;
  down)
    print_info "Stopping local development stack."
    compose "${COMPOSE_ARGS[@]}" down --remove-orphans
    ;;
  restart)
    print_info "Restarting selected services."
    if [[ $# -gt 0 ]]; then
      compose "${COMPOSE_ARGS[@]}" restart "$@"
    else
      compose "${COMPOSE_ARGS[@]}" restart "${DEFAULT_SERVICES[@]}"
    fi
    ;;
  logs)
    if [[ $# -eq 0 ]]; then
      usage
      die "Select a service group for logs: frontend or backend"
    fi
    service_group="$(service_group_for_logs "$1")" || die "Unsupported service group: $1"
    # shellcheck disable=SC2086
    compose "${COMPOSE_ARGS[@]}" logs -f ${service_group}
    ;;
  ps)
    compose "${COMPOSE_ARGS[@]}" ps
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    die "Unsupported command: ${command_name}"
    ;;
esac
