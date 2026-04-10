#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd -- "$(dirname -- "${SCRIPT_PATH}")/.." >/dev/null 2>&1 && pwd)"
export REPO_ROOT

# shellcheck source=./lib/common.sh
source "${REPO_ROOT}/scripts/lib/common.sh"

COMPOSE_ARGS=(-f "${REPO_ROOT}/docker-compose.yml" -f "${REPO_ROOT}/docker-compose.dev.yml")
DEFAULT_SERVICES=(postgres redis backend worker beat frontend)

usage() {
  cat <<'EOF'
Usage:
  scripts/dev.sh [up|down|restart|logs|ps] [service...]

Examples:
  scripts/dev.sh
  scripts/dev.sh up
  scripts/dev.sh logs backend
  scripts/dev.sh down
EOF
}

command_name="${1:-up}"
if [[ $# -gt 0 ]]; then
  shift
fi

ensure_env_file "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
load_env_if_present "${REPO_ROOT}/.env"

case "${command_name}" in
  up)
    print_info "Starting local development stack with watching enabled."
    compose "${COMPOSE_ARGS[@]}" up -d --build "${DEFAULT_SERVICES[@]}" "$@"
    cat <<EOF
Local development stack is running.

Frontend: http://127.0.0.1:${FRONTEND_PORT:-5173}
Backend:  http://127.0.0.1:${BACKEND_PORT:-8000}

Use:
  scripts/dev.sh logs frontend
  scripts/dev.sh logs backend
  scripts/dev.sh down
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
