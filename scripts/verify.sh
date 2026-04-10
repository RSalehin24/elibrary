#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd -- "$(dirname -- "${SCRIPT_PATH}")/.." >/dev/null 2>&1 && pwd)"
export REPO_ROOT

# shellcheck source=./lib/common.sh
source "${REPO_ROOT}/scripts/lib/common.sh"

repeat_count=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repeat)
      repeat_count="${2:?--repeat requires a count}"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage:
  scripts/verify.sh [--repeat N]

Runs backend tests, frontend build, and browser tests.
EOF
      exit 0
      ;;
    *)
      die "Unsupported argument: $1"
      ;;
  esac
done

require_cmd npm
require_cmd curl

pytest_bin="${REPO_ROOT}/.venv/bin/pytest"
if [[ ! -x "${pytest_bin}" ]]; then
  die "Missing ${pytest_bin}. Create the repo virtualenv before running scripts/verify.sh."
fi

wait_for_url() {
  local url="${1:?url is required}"
  local timeout_seconds="${2:-30}"
  local started_at
  started_at="$(date +%s)"

  while true; do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi

    if (( $(date +%s) - started_at >= timeout_seconds )); then
      return 1
    fi

    sleep 1
  done
}

run_browser_suite() {
  local attempt
  local browser_test_args="${PLAYWRIGHT_VERIFY_ARGS:---workers=1}"
  local shell_bin="${SHELL:-/bin/zsh}"
  local playwright_port="${PLAYWRIGHT_VERIFY_PORT:-4173}"
  local dev_server_pid=""
  local dev_server_log=""

  if [[ "${PLAYWRIGHT_USE_EXISTING_SERVER:-0}" == "1" ]]; then
    "${shell_bin}" -lc "cd '${REPO_ROOT}/frontend' && npm run test:e2e -- ${browser_test_args}"
    return $?
  fi

  cleanup_dev_server() {
    if [[ -n "${dev_server_pid}" ]] && kill -0 "${dev_server_pid}" >/dev/null 2>&1; then
      kill "${dev_server_pid}" >/dev/null 2>&1 || true
      wait "${dev_server_pid}" >/dev/null 2>&1 || true
    fi
    dev_server_pid=""
  }

  for attempt in 1 2; do
    dev_server_log="$(mktemp "${TMPDIR:-/tmp}/verify-playwright-dev.XXXX.log")"
    (
      cd "${REPO_ROOT}/frontend"
      npm run dev -- --host 127.0.0.1 --port "${playwright_port}" >"${dev_server_log}" 2>&1
    ) &
    dev_server_pid=$!

    if ! wait_for_url "http://127.0.0.1:${playwright_port}" 30; then
      cleanup_dev_server
      print_warn "Timed out waiting for the Vite verification server on port ${playwright_port}."
      cat "${dev_server_log}" >&2
      rm -f "${dev_server_log}"
      dev_server_log=""
      continue
    fi

    if PLAYWRIGHT_USE_EXISTING_SERVER=1 \
      PLAYWRIGHT_BASE_URL="http://127.0.0.1:${playwright_port}" \
      "${shell_bin}" -lc "cd '${REPO_ROOT}/frontend' && npm run test:e2e -- ${browser_test_args}"
    then
      cleanup_dev_server
      rm -f "${dev_server_log}"
      return 0
    fi

    cleanup_dev_server
    rm -f "${dev_server_log}"
    dev_server_log=""

    if [[ "${attempt}" -eq 1 ]]; then
      print_warn "Browser suite failed on the first attempt. Retrying once."
      sleep 2
    fi
  done

  return 1
}

for run_index in $(seq 1 "${repeat_count}"); do
  print_info "Verification run ${run_index}/${repeat_count}: backend tests"
  "${pytest_bin}" backend -q

  print_info "Verification run ${run_index}/${repeat_count}: frontend build"
  (
    cd "${REPO_ROOT}/frontend"
    npm run build
  )

  print_info "Verification run ${run_index}/${repeat_count}: browser suite"
  run_browser_suite
done
