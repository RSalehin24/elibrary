#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd -- "$(dirname -- "${SCRIPT_PATH}")/.." >/dev/null 2>&1 && pwd)"
export REPO_ROOT

# shellcheck source=./lib/common.sh
source "${REPO_ROOT}/scripts/lib/common.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/generate-env.sh <target>

Targets:
  local        -> .env
  production   -> .env.production
  test         -> .env.test
  deploy       -> scripts/.env
  backend      -> backend/.env
  frontend     -> frontend/.env
  all          -> generate local, production, deploy, backend, and frontend files
EOF
}

generate_target() {
  local template_file="$1"
  local target_file="$2"
  ensure_env_file "${template_file}" "${target_file}"
  print_info "Prepared ${target_file}"
}

run_target() {
  local target_name="${1:?target name is required}"

  case "${target_name}" in
    local)
      generate_target "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
      ;;
    production)
      generate_target "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env.production"
      ;;
    test)
      generate_target "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env.test"
      ;;
    deploy)
      generate_target "${REPO_ROOT}/scripts/.env.example" "${REPO_ROOT}/scripts/.env"
      ;;
    backend)
      generate_target "${REPO_ROOT}/backend/.env.example" "${REPO_ROOT}/backend/.env"
      ;;
    frontend)
      generate_target "${REPO_ROOT}/frontend/.env.example" "${REPO_ROOT}/frontend/.env"
      ;;
    all)
      run_target local
      run_target production
      run_target deploy
      run_target backend
      run_target frontend
      ;;
    *)
      usage
      die "Unsupported target: ${target_name}"
      ;;
  esac
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -eq 0 ]]; then
  usage
  exit 0
fi

run_target "$1"
