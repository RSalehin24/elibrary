#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
source "$(cd -- "$(dirname -- "${SCRIPT_PATH}")/../.." >/dev/null 2>&1 && pwd)/automation/lib/common.sh"
REPO_ROOT="$(repo_root_from "${SCRIPT_PATH}")"
export REPO_ROOT

APP_ENV_FILE="${REPO_ROOT}/local/env/.env"
COMPOSE_FILE="${REPO_ROOT}/local/compose/docker-compose.yml"

ensure_env_file "${REPO_ROOT}/local/env/app.env.example" "${APP_ENV_FILE}"
load_env_if_present "${APP_ENV_FILE}"

print_info "Seeding deterministic live E2E data inside the local backend container."
compose --env-file "${APP_ENV_FILE}" -f "${COMPOSE_FILE}" exec -T backend python manage.py seed_e2e_data
