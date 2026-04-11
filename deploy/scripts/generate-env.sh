#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
source "$(cd -- "$(dirname -- "${SCRIPT_PATH}")/../.." >/dev/null 2>&1 && pwd)/automation/lib/common.sh"
REPO_ROOT="$(repo_root_from "${SCRIPT_PATH}")"

usage() {
  cat <<'EOF'
Usage:
  deploy/scripts/generate-env.sh <target>

Targets:
  production   -> deploy/env/.production.env
  test         -> deploy/env/.test.env
  host         -> deploy/env/.host.env
  all          -> generate production, test, and host files
EOF
}

main() {
  local target_name="${1:-}"

  case "${target_name}" in
    production|test|host|all)
      ;;
    -h|--help|"")
      usage
      exit 0
      ;;
    *)
      usage
      die "Unsupported target: ${target_name}"
      ;;
  esac

  exec "${REPO_ROOT}/local/scripts/generate-env.sh" "${target_name}"
}

main "$@"
