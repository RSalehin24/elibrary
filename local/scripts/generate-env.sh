#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
source "$(cd -- "$(dirname -- "${SCRIPT_PATH}")/../.." >/dev/null 2>&1 && pwd)/automation/lib/common.sh"
REPO_ROOT="$(repo_root_from "${SCRIPT_PATH}")"
export REPO_ROOT

usage() {
  cat <<'EOF'
Usage:
  local/scripts/generate-env.sh <target>

Targets:
  local        -> local/env/.env
  production   -> deploy/env/.production.env
  test         -> deploy/env/.test.env
  host         -> deploy/env/.host.env
  all          -> generate local, production, test, and host files
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
      generate_target "${REPO_ROOT}/local/env/app.env.example" "${REPO_ROOT}/local/env/.env"
      ;;
    production)
      generate_target "${REPO_ROOT}/deploy/env/app.env.example" "${REPO_ROOT}/deploy/env/.production.env"
      ;;
    test)
      generate_target "${REPO_ROOT}/deploy/env/app.env.example" "${REPO_ROOT}/deploy/env/.test.env"
      ;;
    host)
      generate_target "${REPO_ROOT}/deploy/env/host.env.example" "${REPO_ROOT}/deploy/env/.host.env"
      ;;
    all)
      run_target local
      run_target production
      run_target test
      run_target host
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
