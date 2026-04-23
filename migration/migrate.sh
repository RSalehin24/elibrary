#!/usr/bin/env bash

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
MIGRATION_DIR="$(cd -- "$(dirname -- "${SCRIPT_PATH}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "${MIGRATION_DIR}/.." >/dev/null 2>&1 && pwd)"
export REPO_ROOT

source "${MIGRATION_DIR}/lib/logging.sh"
source "${MIGRATION_DIR}/lib/config.sh"
source "${MIGRATION_DIR}/lib/ssh.sh"
source "${MIGRATION_DIR}/lib/bundle.sh"
source "${MIGRATION_DIR}/lib/compose.sh"

usage() {
  cat <<'EOF'
Usage:
  migration/migrate.sh [--config migration/config/migrate.env] [--phase preflight|snapshot|restore|verify|full] [--dry-run] [--resume] [--keep-staging] [--allow-target-reset] [--skip-edge]

Examples:
  migration/migrate.sh --phase preflight --dry-run
  migration/migrate.sh --config migration/config/migrate.env --phase full
  migration/migrate.sh --phase restore --resume
EOF
}

q() {
  printf '%q' "$1"
}

CONFIG_FILE="${MIGRATION_DIR}/config/migrate.env"
CONFIG_EXAMPLE_FILE="${MIGRATION_DIR}/config/migrate.env.example"
PHASE="full"
DRY_RUN=0
RESUME=0
KEEP_STAGING_FLAG=""
ALLOW_TARGET_RESET_FLAG=""
SKIP_EDGE_FLAG=""
SOURCE_FROZEN=0
SOURCE_RESTARTED=0
EDGE_SETUP_READY=0
EDGE_SETUP_REASON="disabled"
FINAL_SUCCESS=0

APP_ARCHIVE_FILE=""
STORAGE_ARCHIVE_FILE=""
POSTGRES_DUMP_FILE=""
REDIS_DUMP_FILE=""
APP_ENV_BUNDLE_FILE=""
TARGET_OVERRIDE_FILE=""
METADATA_FILE=""
CHECKSUMS_FILE=""
LOG_FILE=""

apply_deploy_defaults() {
  local deploy_host_env_file="${REPO_ROOT}/deploy/env/.host.env"
  local deploy_user=""
  local deploy_ip=""
  local deploy_remote_app_dir=""
  local deploy_domain=""
  local deploy_certbot_email=""
  local deploy_backend_port=""
  local deploy_frontend_port=""
  local deploy_docker_version=""
  local deploy_nginx_version=""
  local deploy_nginx_conf_dir=""
  local deploy_nginx_config_name=""

  if [[ -f "${deploy_host_env_file}" ]]; then
    deploy_user="$(read_env_value_from_file "${deploy_host_env_file}" "DEPLOY_USER_NAME")"
    deploy_ip="$(read_env_value_from_file "${deploy_host_env_file}" "DEPLOY_IP")"
    deploy_remote_app_dir="$(read_env_value_from_file "${deploy_host_env_file}" "DEPLOY_REMOTE_APP_DIR")"
    deploy_domain="$(read_env_value_from_file "${deploy_host_env_file}" "DEPLOY_DOMAIN")"
    deploy_certbot_email="$(read_env_value_from_file "${deploy_host_env_file}" "DEPLOY_CERTBOT_EMAIL")"
    deploy_backend_port="$(read_env_value_from_file "${deploy_host_env_file}" "BACKEND_PORT")"
    deploy_frontend_port="$(read_env_value_from_file "${deploy_host_env_file}" "FRONTEND_PORT")"
    deploy_docker_version="$(read_env_value_from_file "${deploy_host_env_file}" "DEPLOY_DOCKER_VERSION")"
    deploy_nginx_version="$(read_env_value_from_file "${deploy_host_env_file}" "DEPLOY_NGINX_VERSION")"
    deploy_nginx_conf_dir="$(read_env_value_from_file "${deploy_host_env_file}" "DEPLOY_NGINX_CONF_DIR")"
    deploy_nginx_config_name="$(read_env_value_from_file "${deploy_host_env_file}" "DEPLOY_NGINX_CONFIG_NAME")"
  fi

  default_if_empty SOURCE_HOST "${deploy_ip}"
  default_if_empty SOURCE_USER "${deploy_user}"
  if [[ -n "${deploy_remote_app_dir}" ]]; then
    default_if_empty SOURCE_REMOTE_APP_DIR "${deploy_remote_app_dir}"
  fi

  default_if_empty TARGET_USER "${deploy_user}"
  default_if_empty TARGET_REMOTE_APP_DIR "${deploy_remote_app_dir}"
  default_if_empty TARGET_DOMAIN "${deploy_domain}"
  default_if_empty TARGET_CERTBOT_EMAIL "${deploy_certbot_email}"
  default_if_empty BACKEND_PORT "${deploy_backend_port}"
  default_if_empty FRONTEND_PORT "${deploy_frontend_port}"
  default_if_empty DEPLOY_DOCKER_VERSION "${deploy_docker_version}"
  default_if_empty DEPLOY_NGINX_VERSION "${deploy_nginx_version}"
  default_if_empty DEPLOY_NGINX_CONF_DIR "${deploy_nginx_conf_dir}"
  default_if_empty DEPLOY_NGINX_CONFIG_NAME "${deploy_nginx_config_name}"
}

log_layout_defaults() {
  if [[ "${TARGET_REMOTE_APP_DIR}" == "${SOURCE_REMOTE_APP_DIR}" ]]; then
    log_info "The application will use the same folder path and repository structure on the new server: ${TARGET_REMOTE_APP_DIR}"
  else
    log_info "The target application path is overridden to ${TARGET_REMOTE_APP_DIR}"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --config)
        CONFIG_FILE="${2:?--config requires a value}"
        shift 2
        ;;
      --phase)
        PHASE="${2:?--phase requires a value}"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --resume)
        RESUME=1
        shift
        ;;
      --keep-staging)
        KEEP_STAGING_FLAG="1"
        shift
        ;;
      --allow-target-reset)
        ALLOW_TARGET_RESET_FLAG="1"
        shift
        ;;
      --skip-edge)
        SKIP_EDGE_FLAG="1"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        usage
        die "Unsupported argument: $1"
        ;;
    esac
  done

  case "${PHASE}" in
    preflight|snapshot|restore|verify|full)
      ;;
    *)
      die "Unsupported phase: ${PHASE}"
      ;;
  esac
}

initialize_config() {
  ensure_config_file "${CONFIG_EXAMPLE_FILE}" "${CONFIG_FILE}"
  load_config_file "${CONFIG_FILE}"

  default_if_empty SOURCE_PORT "22"
  default_if_empty TARGET_PORT "22"
  apply_deploy_defaults
  default_if_empty SOURCE_USER "ubuntu"
  default_if_empty SOURCE_REMOTE_APP_DIR "/home/${SOURCE_USER}/library_app"
  default_if_empty TARGET_USER "${SOURCE_USER}"
  default_if_empty TARGET_REMOTE_APP_DIR "${SOURCE_REMOTE_APP_DIR}"
  default_if_empty BACKEND_PORT "8000"
  default_if_empty FRONTEND_PORT "4173"
  default_if_empty DEPLOY_NGINX_VERSION "1.29.4"
  default_if_empty DEPLOY_NGINX_CONF_DIR "/etc/nginx/conf.d"
  default_if_empty STRICT_HOST_KEY_MODE "accept-new"
  default_if_empty LOCAL_STAGING_DIR "${MIGRATION_DIR}/runtime"
  default_if_empty DRAIN_TIMEOUT_SECONDS "900"
  default_if_empty HEALTHCHECK_TIMEOUT_SECONDS "240"
  default_if_empty KEEP_SOURCE_DOWN_ON_SUCCESS "0"
  default_if_empty ALLOW_TARGET_RESET "0"
  default_if_empty SKIP_EDGE_SETUP "0"
  default_if_empty KEEP_STAGING "1"

  normalize_bool_var KEEP_SOURCE_DOWN_ON_SUCCESS "0"
  normalize_bool_var ALLOW_TARGET_RESET "0"
  normalize_bool_var SKIP_EDGE_SETUP "0"
  normalize_bool_var KEEP_STAGING "1"

  if [[ -n "${KEEP_STAGING_FLAG}" ]]; then
    KEEP_STAGING=1
  fi
  if [[ -n "${ALLOW_TARGET_RESET_FLAG}" ]]; then
    ALLOW_TARGET_RESET=1
  fi
  if [[ -n "${SKIP_EDGE_FLAG}" ]]; then
    SKIP_EDGE_SETUP=1
  fi

  if [[ -z "${DEPLOY_NGINX_CONFIG_NAME:-}" && -n "${TARGET_DOMAIN:-}" ]]; then
    DEPLOY_NGINX_CONFIG_NAME="${TARGET_DOMAIN}.conf"
  fi

  mkdir -p "${LOCAL_STAGING_DIR}"

  if [[ -z "${BUNDLE_ID:-}" ]]; then
    if [[ "${RESUME}" == "1" ]]; then
      BUNDLE_ID="$(latest_bundle_id "${LOCAL_STAGING_DIR}")"
    else
      BUNDLE_ID="migration-$(date -u +%Y%m%d-%H%M%S)"
    fi
  fi

  [[ -n "${BUNDLE_ID}" ]] || die "Unable to determine BUNDLE_ID. Set it in the config or create a bundle first."

  BUNDLE_DIR="${LOCAL_STAGING_DIR}/${BUNDLE_ID}"
  mkdir -p "${BUNDLE_DIR}"

  LOG_FILE="${BUNDLE_DIR}/migration.log"
  touch "${LOG_FILE}"

  APP_ARCHIVE_FILE="${BUNDLE_DIR}/app.tar.gz"
  STORAGE_ARCHIVE_FILE="${BUNDLE_DIR}/storage.tar.gz"
  POSTGRES_DUMP_FILE="${BUNDLE_DIR}/postgres.sql.gz"
  REDIS_DUMP_FILE="${BUNDLE_DIR}/redis-dump.rdb"
  APP_ENV_BUNDLE_FILE="${BUNDLE_DIR}/app.env"
  TARGET_OVERRIDE_FILE="${BUNDLE_DIR}/target-env-overrides.env"
  METADATA_FILE="${BUNDLE_DIR}/metadata.env"
  CHECKSUMS_FILE="${BUNDLE_DIR}/checksums.sha256"
  TARGET_REMOTE_BUNDLE_DIR="/tmp/${BUNDLE_ID}"
  TARGET_RESET_ALLOWED=0

  if [[ "${RESUME}" == "1" && ! -d "${BUNDLE_DIR}" ]]; then
    die "Bundle directory does not exist for resume: ${BUNDLE_DIR}"
  fi

  log_layout_defaults
}

validate_required_config() {
  local required_keys=(
    SOURCE_HOST
    SOURCE_USER
    SOURCE_REMOTE_APP_DIR
    TARGET_HOST
    TARGET_USER
    TARGET_REMOTE_APP_DIR
    TARGET_IP
  )
  local key
  for key in "${required_keys[@]}"; do
    [[ -n "${!key:-}" ]] || die "Missing required config value: ${key}"
  done
}

write_target_override_bundle() {
  : >"${TARGET_OVERRIDE_FILE}"
  printf 'BACKEND_PORT=%s\n' "${BACKEND_PORT}" >>"${TARGET_OVERRIDE_FILE}"
  printf 'FRONTEND_PORT=%s\n' "${FRONTEND_PORT}" >>"${TARGET_OVERRIDE_FILE}"
  if [[ -n "${TARGET_PUBLIC_BASE_URL:-}" ]]; then
    printf 'PUBLIC_BASE_URL=%s\n' "${TARGET_PUBLIC_BASE_URL}" >>"${TARGET_OVERRIDE_FILE}"
  fi
  if [[ -n "${TARGET_PUBLIC_API_ORIGIN:-}" ]]; then
    printf 'PUBLIC_API_ORIGIN=%s\n' "${TARGET_PUBLIC_API_ORIGIN}" >>"${TARGET_OVERRIDE_FILE}"
  fi
  if [[ -n "${TARGET_FRONTEND_BASE_URL:-}" ]]; then
    printf 'FRONTEND_BASE_URL=%s\n' "${TARGET_FRONTEND_BASE_URL}" >>"${TARGET_OVERRIDE_FILE}"
  fi
}

require_local_tools() {
  local tools=(bash ssh scp tar gzip python3)
  local tool
  for tool in "${tools[@]}"; do
    command -v "${tool}" >/dev/null 2>&1 || die "Missing required local tool: ${tool}"
  done

  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    die "Missing required local checksum tool: sha256sum or shasum"
  fi

  if [[ -n "${SOURCE_SSH_PASSWORD:-}" || -n "${TARGET_SSH_PASSWORD:-}" ]]; then
    command -v sshpass >/dev/null 2>&1 || die "Password-based SSH requires local sshpass"
  fi
}

resolve_domain_ips() {
  local domain_name="${1:?domain is required}"
  python3 - "${domain_name}" <<'PY'
import socket
import sys

domain = sys.argv[1]
try:
    _name, _aliases, ips = socket.gethostbyname_ex(domain)
except Exception:
    ips = []

for ip in sorted(set(ips)):
    print(ip)
PY
}

preflight_edge_setup() {
  EDGE_SETUP_READY=0
  EDGE_SETUP_REASON="skipped"

  if [[ "${SKIP_EDGE_SETUP}" == "1" ]]; then
    EDGE_SETUP_REASON="disabled"
    return 0
  fi

  if [[ -z "${TARGET_DOMAIN:-}" || -z "${TARGET_CERTBOT_EMAIL:-}" ]]; then
    EDGE_SETUP_REASON="missing_domain_or_certbot_email"
    return 0
  fi

  local resolved_ips
  resolved_ips="$(resolve_domain_ips "${TARGET_DOMAIN}")"
  if [[ -z "${resolved_ips}" ]]; then
    EDGE_SETUP_REASON="dns_unresolved"
    return 0
  fi
  if ! printf '%s\n' "${resolved_ips}" | grep -Fxq "${TARGET_IP}"; then
    EDGE_SETUP_REASON="dns_mismatch"
    log_warn "Skipping edge setup because ${TARGET_DOMAIN} does not resolve to ${TARGET_IP}."
    return 0
  fi

  EDGE_SETUP_READY=1
  EDGE_SETUP_REASON="ready"
}

maybe_prompt_for_cloudflare_change() {
  if [[ -z "${TARGET_DOMAIN:-}" || -z "${TARGET_IP:-}" ]]; then
    return 0
  fi

  local choice
  choice="$(timed_prompt_local "You have to configure the domain ${TARGET_DOMAIN} to point to the target host IP ${TARGET_IP}. Have you done it? [y/N] (auto-continue in 10s): " 10 "n")"
  [[ "${choice}" =~ ^([Yy]|[Yy][Ee][Ss])$ ]]
}

remote_connectivity_check() {
  local role="${1:?role is required}"
  local label endpoint output
  label="$(tr '[:lower:]' '[:upper:]' <<<"${role:0:1}")${role:1}"
  endpoint="$(role_value "${role}" user)@$(role_value "${role}" host):$(role_value "${role}" port)"

  if ! output="$(check_ssh_connection "${role}" 2>&1)"; then
    die "Please configure the ssh authentication for ${label} host (${endpoint}). SSH check failed: ${output}"
  fi

  log_info "${label} host SSH connection verified: ${endpoint}"
}

remote_os_check() {
  local role="${1:?role is required}"
  local os_id
  os_id="$(remote_run "${role}" "$(cat <<'EOF'
source /etc/os-release
printf '%s\n' "${ID}"
EOF
)"
  case "${os_id}" in
    ubuntu|debian)
      ;;
    *)
      die "Remote ${role} host must be Ubuntu-like. Found: ${os_id}"
      ;;
  esac
}

remote_sudo_check() {
  local role="${1:?role is required}"
  if [[ -n "$(role_value "${role}" sudo_password)" ]]; then
    remote_sudo "${role}" "true" >/dev/null
  else
    remote_run "${role}" "sudo -n true" >/dev/null 2>&1 || die "Remote ${role} host requires passwordless sudo or ${role^^}_SUDO_PASSWORD"
  fi
}

source_layout_check() {
  remote_run source "$(app_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
test -f deploy/compose/docker-compose.yml
test -f deploy/scripts/install-docker.sh
test -f deploy/scripts/setup-host-nginx.sh
test -f automation/lib/common.sh
test -d app/backend/storage
test -f deploy/env/.app.env
EOF
)")" >/dev/null
}

container_status_report_script() {
  cat <<'EOF'
service_status() {
  local service_name="$1"
  local required_health="$2"
  local container_id
  container_id="$(compose "${COMPOSE_ARGS[@]}" ps -q "${service_name}")"
  [[ -n "${container_id}" ]] || {
    echo "missing:${service_name}"
    return 1
  }
  local status health
  status="$(docker inspect -f '{{.State.Status}}' "${container_id}")"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "${container_id}")"
  if [[ "${status}" != "running" ]]; then
    echo "not-running:${service_name}:${status}"
    return 1
  fi
  if [[ "${required_health}" == "1" && -n "${health}" && "${health}" != "healthy" ]]; then
    echo "not-healthy:${service_name}:${health}"
    return 1
  fi
}
EOF
}

source_stack_health_check() {
  local check_script
  check_script="$(cat <<EOF
$(container_status_report_script)
service_status postgres 1
service_status redis 1
service_status backend 1
service_status frontend 0
service_status worker 0
service_status processing-worker 0
service_status beat 0
python3 - <<'PY'
import os
import urllib.request

backend_port = os.environ.get("BACKEND_PORT", "${BACKEND_PORT}")
frontend_port = os.environ.get("FRONTEND_PORT", "${FRONTEND_PORT}")
urllib.request.urlopen(f"http://127.0.0.1:{backend_port}/api/csrf/", timeout=15)
urllib.request.urlopen(f"http://127.0.0.1:{frontend_port}/", timeout=15)
print("ok")
PY
EOF
)"
  remote_run source "$(compose_remote_script "${SOURCE_REMOTE_APP_DIR}" "${check_script}")" >/dev/null
}

target_ports_check() {
  local ports_to_check=("${BACKEND_PORT}" "${FRONTEND_PORT}" "80" "443")
  local port_list
  port_list="$(IFS=,; printf '%s' "${ports_to_check[*]}")"
  remote_run target "$(cat <<EOF
python3 - "${port_list}" <<'PY'
import socket
import sys

ports = [int(item) for item in sys.argv[1].split(",") if item]
for port in ports:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("0.0.0.0", port))
    except OSError:
        raise SystemExit(f"port-in-use:{port}")
    finally:
        sock.close()
print("ok")
PY
EOF
)" >/dev/null
}

target_directory_state_check() {
  local state_output
  state_output="$(remote_run target "$(cat <<EOF
app_dir=$(q "${TARGET_REMOTE_APP_DIR}")
bundle_id=$(q "${BUNDLE_ID}")
allow_reset=$(q "${ALLOW_TARGET_RESET}")
python3 - "${TARGET_REMOTE_APP_DIR}" "${BUNDLE_ID}" "${ALLOW_TARGET_RESET}" <<'PY'
import os
import sys

app_dir, bundle_id, allow_reset = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
if not os.path.exists(app_dir):
    print("TARGET_STATE=missing")
    sys.exit(0)
entries = [entry for entry in os.listdir(app_dir) if entry not in (".", "..")]
if not entries:
    print("TARGET_STATE=empty")
    sys.exit(0)
marker_path = os.path.join(app_dir, ".migration-state", "bundle-id")
if os.path.exists(marker_path):
    current = open(marker_path, "r", encoding="utf-8").read().strip()
    if current == bundle_id:
        print("TARGET_STATE=resumable")
        sys.exit(0)
if allow_reset:
    print("TARGET_STATE=resettable")
    sys.exit(0)
print("TARGET_STATE=occupied")
sys.exit(3)
PY
EOF
)")" || true

  if printf '%s\n' "${state_output}" | grep -Fq 'TARGET_STATE=occupied'; then
    die "Target app directory is not empty and is not a recognized resumable restore. Use --allow-target-reset if you intend to wipe it."
  fi

  TARGET_RESET_ALLOWED=0
  if printf '%s\n' "${state_output}" | grep -Eq 'TARGET_STATE=(resumable|resettable)'; then
    TARGET_RESET_ALLOWED=1
  fi
}

source_size_metrics() {
  remote_run source "$(cat <<EOF
python3 - "${SOURCE_REMOTE_APP_DIR}" <<'PY'
import os
import subprocess
import sys

app_dir = sys.argv[1]

def run_du(path, exclude_storage=False):
    cmd = ["du", "-sk"]
    if exclude_storage:
        cmd.append("--exclude=app/backend/storage")
    cmd.append(path)
    result = subprocess.check_output(cmd, text=True)
    return int(result.split()[0])

print(f"APP_KB={run_du(app_dir, exclude_storage=True)}")
print(f"STORAGE_KB={run_du(os.path.join(app_dir, 'app/backend/storage'))}")
PY
EOF
)")"
}

postgres_data_kb() {
  remote_run source "$(compose_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
compose "${COMPOSE_ARGS[@]}" exec -T postgres sh -lc 'du -sk /var/lib/postgresql/data | awk "{print \$1}"'
EOF
)")"
}

redis_data_kb() {
  remote_run source "$(compose_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
compose "${COMPOSE_ARGS[@]}" exec -T redis sh -lc 'du -sk /data | awk "{print \$1}"'
EOF
)")"
}

disk_space_check() {
  local source_sizes pg_kb redis_kb
  source_sizes="$(source_size_metrics)"
  pg_kb="$(postgres_data_kb)"
  redis_kb="$(redis_data_kb)"

  local source_app_kb=0 source_storage_kb=0
  while IFS='=' read -r key value; do
    case "${key}" in
      APP_KB) source_app_kb="${value}" ;;
      STORAGE_KB) source_storage_kb="${value}" ;;
    esac
  done <<<"${source_sizes}"

  local raw_total_kb=$((source_app_kb + source_storage_kb + pg_kb + redis_kb))
  local local_required_kb=$((raw_total_kb + (raw_total_kb / 4) + 102400))
  local target_required_kb=$((raw_total_kb * 2 + 102400))

  local local_free_kb target_free_kb
  local_free_kb="$(free_kb_for_path "${LOCAL_STAGING_DIR}")"
  target_free_kb="$(remote_run target "df -Pk $(q "$(dirname -- "${TARGET_REMOTE_APP_DIR}")") | awk 'NR==2 {print \$4}'")"

  [[ "${local_free_kb}" =~ ^[0-9]+$ ]] || die "Unable to determine local free disk space."
  [[ "${target_free_kb}" =~ ^[0-9]+$ ]] || die "Unable to determine target free disk space."

  if (( local_free_kb < local_required_kb )); then
    die "Local staging path does not have enough free space. Need ~${local_required_kb}KB, found ${local_free_kb}KB."
  fi
  if (( target_free_kb < target_required_kb )); then
    die "Target host does not have enough free space. Need ~${target_required_kb}KB, found ${target_free_kb}KB."
  fi
}

run_preflight() {
  log_info "Running migration preflight checks."
  validate_required_config
  require_local_tools
  remote_connectivity_check source
  remote_connectivity_check target
  if ! maybe_prompt_for_cloudflare_change; then
    log_warn "The domain confirmation was not acknowledged. Migration will continue, but edge setup may be skipped until DNS points at the target host."
  fi
  remote_os_check source
  remote_os_check target
  remote_sudo_check source
  remote_sudo_check target
  source_layout_check
  source_stack_health_check
  target_ports_check
  target_directory_state_check
  disk_space_check
  preflight_edge_setup
  write_target_override_bundle
  mark_phase_done preflight
  log_info "Preflight completed."
}

restart_source_stack() {
  log_info "Starting source services again."
  if [[ "${DRY_RUN}" == "1" ]]; then
    log_info "DRY RUN: skipping source restart."
    SOURCE_RESTARTED=1
    SOURCE_FROZEN=0
    return 0
  fi

  remote_run source "$(compose_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
compose "${COMPOSE_ARGS[@]}" up -d backend frontend worker processing-worker beat
EOF
)")"
  SOURCE_RESTARTED=1
  SOURCE_FROZEN=0
}

freeze_source_stack() {
  SOURCE_FROZEN=1
  log_info "Stopping source beat, backend, and frontend to freeze writes."
  remote_run source "$(compose_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
compose "${COMPOSE_ARGS[@]}" stop beat frontend backend
EOF
)")"
}

source_drain_report() {
  remote_run source "$(compose_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
cat <<'PY' | compose "${COMPOSE_ARGS[@]}" exec -T worker python
from config.celery import app

def count_entries(payload):
    total = 0
    for entries in (payload or {}).values():
        total += len(entries or [])
    return total

inspect = app.control.inspect(timeout=2.0)
active = count_entries(inspect.active())
reserved = count_entries(inspect.reserved())
scheduled = count_entries(inspect.scheduled())
print(f"ACTIVE={active}")
print(f"RESERVED={reserved}")
print(f"SCHEDULED={scheduled}")
PY
printf 'QUEUE_CELERY=%s\n' "$(compose "${COMPOSE_ARGS[@]}" exec -T redis redis-cli --raw LLEN celery)"
printf 'QUEUE_PROCESSING=%s\n' "$(compose "${COMPOSE_ARGS[@]}" exec -T redis redis-cli --raw LLEN processing)"
EOF
)")"
}

wait_for_source_drain() {
  log_info "Waiting for source workers and queues to drain."
  local started_at now elapsed
  started_at="$(date +%s)"

  while true; do
    local report active=1 reserved=1 scheduled=1 queue_celery=1 queue_processing=1
    report="$(source_drain_report)"
    while IFS='=' read -r key value; do
      case "${key}" in
        ACTIVE) active="${value}" ;;
        RESERVED) reserved="${value}" ;;
        SCHEDULED) scheduled="${value}" ;;
        QUEUE_CELERY) queue_celery="${value}" ;;
        QUEUE_PROCESSING) queue_processing="${value}" ;;
      esac
    done <<<"${report}"

    if [[ "${active}" == "0" && "${reserved}" == "0" && "${scheduled}" == "0" && "${queue_celery}" == "0" && "${queue_processing}" == "0" ]]; then
      log_info "Source queues are drained."
      return 0
    fi

    now="$(date +%s)"
    elapsed=$((now - started_at))
    if (( elapsed >= DRAIN_TIMEOUT_SECONDS )); then
      restart_source_stack
      die "Timed out waiting for the source queues to drain."
    fi

    sleep 5
  done
}

stop_source_workers() {
  log_info "Stopping source workers after drain."
  remote_run source "$(compose_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
compose "${COMPOSE_ARGS[@]}" stop worker processing-worker
EOF
)")"
}

capture_source_env() {
  log_info "Capturing source deploy env."
  run_scp_from source "$(q "${SOURCE_REMOTE_APP_DIR}/deploy/env/.app.env")" "${APP_ENV_BUNDLE_FILE}"
}

capture_source_app_archive() {
  log_info "Streaming source application snapshot."
  run_ssh source "$(app_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
tar -czf - \
  --exclude=.git \
  --exclude=app/backend/storage \
  --exclude=deploy/env/.app.env \
  --exclude=deploy/env/.app.compose.env \
  --exclude=app/frontend/node_modules \
  --exclude=app/frontend/dist \
  --exclude=app/frontend/test-results \
  --exclude=app/frontend/test-artifacts \
  --exclude=test-artifacts \
  --exclude=logs/local/*.log \
  --exclude=logs/remote/*.log \
  --exclude=migration/runtime \
  .
EOF
)")" >"${APP_ARCHIVE_FILE}"
}

capture_source_storage_archive() {
  log_info "Streaming source storage snapshot."
  run_ssh source "$(app_remote_script "${SOURCE_REMOTE_APP_DIR}/app/backend" "$(cat <<'EOF'
tar -czf - storage
EOF
)")" >"${STORAGE_ARCHIVE_FILE}"
}

capture_source_postgres_dump() {
  log_info "Streaming PostgreSQL cluster dump."
  run_ssh source "$(compose_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

compose "${COMPOSE_ARGS[@]}" exec -T postgres sh -lc '
  set -e
  pg_dumpall --globals-only -U "${POSTGRES_USER:-postgres}"
' > "${tmp_dir}/globals.sql"

compose "${COMPOSE_ARGS[@]}" exec -T postgres sh -lc '
  set -e
  pg_dump --clean --if-exists --create -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-bangla_library}"
' > "${tmp_dir}/database.sql"

bootstrap_role="${POSTGRES_USER:-postgres}"
awk -v bootstrap_role="${bootstrap_role}" '
  $0 == "CREATE ROLE " bootstrap_role ";" { next }
  index($0, "ALTER ROLE " bootstrap_role " ") == 1 { next }
  { print }
' "${tmp_dir}/globals.sql" "${tmp_dir}/database.sql" | gzip -1
EOF
)")" >"${POSTGRES_DUMP_FILE}"
}

capture_source_redis_dump() {
  log_info "Streaming Redis RDB snapshot."
  run_ssh source "$(compose_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
compose "${COMPOSE_ARGS[@]}" exec -T redis redis-cli SAVE >/dev/null
compose "${COMPOSE_ARGS[@]}" exec -T redis sh -lc 'cat /data/dump.rdb'
EOF
)")" >"${REDIS_DUMP_FILE}"
}

capture_source_git_commit() {
  remote_run source "$(app_remote_script "${SOURCE_REMOTE_APP_DIR}" "$(cat <<'EOF'
git rev-parse HEAD 2>/dev/null || true
EOF
)")"
}

capture_db_summary() {
  local role="${1:?role is required}"
  local app_dir="${2:?app dir is required}"
  remote_run "${role}" "$(compose_remote_script "${app_dir}" "$(cat <<'EOF'
table_counts="$(
  cat <<'SQL' | compose "${COMPOSE_ARGS[@]}" exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-bangla_library}" -At
CREATE OR REPLACE FUNCTION pg_temp.migration_table_counts()
RETURNS TABLE(table_name text, row_count bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT schemaname, relname
    FROM pg_stat_user_tables
    ORDER BY schemaname, relname
  LOOP
    RETURN QUERY EXECUTE format(
      'SELECT %L::text, count(*)::bigint FROM %I.%I',
      item.schemaname || '.' || item.relname,
      item.schemaname,
      item.relname
    );
  END LOOP;
END;
$$;
SELECT table_name || '=' || row_count
FROM pg_temp.migration_table_counts()
ORDER BY table_name;
SQL
)"

table_count="$(printf '%s\n' "${table_counts}" | sed '/^$/d' | wc -l | tr -d ' ')"
row_total="$(printf '%s\n' "${table_counts}" | awk -F= 'NF == 2 { total += $2 } END { printf "%.0f\n", total + 0 }')"
row_hash="$(printf '%s\n' "${table_counts}" | sed '/^$/d' | sha256sum | awk '{print $1}')"
role_count="$(
  cat <<'SQL' | compose "${COMPOSE_ARGS[@]}" exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-bangla_library}" -At
SELECT count(*) FROM pg_roles;
SQL
)"

printf 'DB_TABLE_COUNT=%s\n' "${table_count}"
printf 'DB_ROW_TOTAL=%s\n' "${row_total}"
printf 'DB_ROLE_COUNT=%s\n' "${role_count}"
printf 'DB_TABLE_ROWS_SHA256=%s\n' "${row_hash}"
EOF
)")"
}

capture_redis_summary() {
  local role="${1:?role is required}"
  local app_dir="${2:?app dir is required}"
  remote_run "${role}" "$(compose_remote_script "${app_dir}" "$(cat <<'EOF'
printf 'REDIS_DBSIZE=%s\n' "$(compose "${COMPOSE_ARGS[@]}" exec -T redis redis-cli --raw DBSIZE)"
printf 'REDIS_QUEUE_CELERY=%s\n' "$(compose "${COMPOSE_ARGS[@]}" exec -T redis redis-cli --raw LLEN celery)"
printf 'REDIS_QUEUE_PROCESSING=%s\n' "$(compose "${COMPOSE_ARGS[@]}" exec -T redis redis-cli --raw LLEN processing)"
printf 'REDIS_USED_MEMORY=%s\n' "$(compose "${COMPOSE_ARGS[@]}" exec -T redis redis-cli --raw INFO memory | awk -F: '/^used_memory:/{print $2}' | tr -d '\r')"
EOF
)")"
}

capture_storage_summary() {
  local role="${1:?role is required}"
  local storage_root="${2:?storage root is required}"
  remote_run "${role}" "$(cat <<EOF
python3 - "${storage_root}" <<'PY'
import os
import sys

root = sys.argv[1]
file_count = 0
total_bytes = 0
for base, _dirs, files in os.walk(root):
    for name in files:
        path = os.path.join(base, name)
        try:
            stat = os.stat(path, follow_symlinks=False)
        except FileNotFoundError:
            continue
        file_count += 1
        total_bytes += stat.st_size

print(f"STORAGE_FILE_COUNT={file_count}")
print(f"STORAGE_TOTAL_BYTES={total_bytes}")
PY
EOF
)"
}

write_source_metadata() {
  log_info "Writing source metadata manifest."
  : >"${METADATA_FILE}"
  append_metadata BUNDLE_ID "${BUNDLE_ID}"
  append_metadata SOURCE_HOST "${SOURCE_HOST}"
  append_metadata TARGET_HOST "${TARGET_HOST}"
  append_metadata EDGE_SETUP_READY "${EDGE_SETUP_READY}"
  append_metadata EDGE_SETUP_REASON "${EDGE_SETUP_REASON}"
  append_metadata SOURCE_GIT_COMMIT "$(capture_source_git_commit)"
  append_metadata SNAPSHOT_COMPLETED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  append_metadata SOURCE_ENV_SHA256 "$(hash_file "${APP_ENV_BUNDLE_FILE}")"
  append_metadata APP_ARCHIVE_SHA256 "$(hash_file "${APP_ARCHIVE_FILE}")"
  append_metadata STORAGE_ARCHIVE_SHA256 "$(hash_file "${STORAGE_ARCHIVE_FILE}")"
  append_metadata POSTGRES_DUMP_SHA256 "$(hash_file "${POSTGRES_DUMP_FILE}")"
  append_metadata REDIS_DUMP_SHA256 "$(hash_file "${REDIS_DUMP_FILE}")"

  local line
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    append_metadata "SOURCE_${line%%=*}" "${line#*=}"
  done < <(capture_db_summary source "${SOURCE_REMOTE_APP_DIR}")

  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    append_metadata "SOURCE_${line%%=*}" "${line#*=}"
  done < <(capture_redis_summary source "${SOURCE_REMOTE_APP_DIR}")

  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    append_metadata "SOURCE_${line%%=*}" "${line#*=}"
  done < <(capture_storage_summary source "${SOURCE_REMOTE_APP_DIR}/app/backend/storage")
}

write_bundle_checksums() {
  log_info "Writing bundle checksums."
  write_checksums_manifest \
    "${CHECKSUMS_FILE}" \
    "${APP_ARCHIVE_FILE}" \
    "${STORAGE_ARCHIVE_FILE}" \
    "${POSTGRES_DUMP_FILE}" \
    "${REDIS_DUMP_FILE}" \
    "${APP_ENV_BUNDLE_FILE}" \
    "${TARGET_OVERRIDE_FILE}"
}

run_snapshot() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log_info "DRY RUN: snapshot would freeze the source and create bundle artifacts under ${BUNDLE_DIR}."
    mark_phase_done snapshot
    return 0
  fi

  freeze_source_stack
  wait_for_source_drain
  stop_source_workers
  capture_source_env
  capture_source_app_archive
  capture_source_storage_archive
  capture_source_postgres_dump
  capture_source_redis_dump
  write_source_metadata
  write_bundle_checksums
  verify_local_checksums "${BUNDLE_DIR}" || die "Local bundle checksum verification failed after snapshot."
  mark_phase_done snapshot
  log_info "Snapshot completed."

  if [[ "${PHASE}" == "snapshot" && "${KEEP_SOURCE_DOWN_ON_SUCCESS}" == "0" ]]; then
    restart_source_stack
  fi
}

verify_bundle_ready_for_restore() {
  local required_files=(
    "${APP_ARCHIVE_FILE}"
    "${STORAGE_ARCHIVE_FILE}"
    "${POSTGRES_DUMP_FILE}"
    "${REDIS_DUMP_FILE}"
    "${APP_ENV_BUNDLE_FILE}"
    "${TARGET_OVERRIDE_FILE}"
    "${METADATA_FILE}"
    "${CHECKSUMS_FILE}"
  )
  local file_path
  for file_path in "${required_files[@]}"; do
    [[ -f "${file_path}" ]] || die "Missing required bundle artifact: ${file_path}"
  done
  verify_local_checksums "${BUNDLE_DIR}" || die "Local bundle checksum verification failed."
  # shellcheck disable=SC1090
  source "${METADATA_FILE}"
}

upload_bundle_to_target() {
  log_info "Uploading bundle to target staging path ${TARGET_REMOTE_BUNDLE_DIR}."
  remote_run target "rm -rf $(q "${TARGET_REMOTE_BUNDLE_DIR}") && mkdir -p $(q "${TARGET_REMOTE_BUNDLE_DIR}")"
  run_scp_to target "${APP_ARCHIVE_FILE}" "${TARGET_REMOTE_BUNDLE_DIR}/app.tar.gz"
  run_scp_to target "${STORAGE_ARCHIVE_FILE}" "${TARGET_REMOTE_BUNDLE_DIR}/storage.tar.gz"
  run_scp_to target "${POSTGRES_DUMP_FILE}" "${TARGET_REMOTE_BUNDLE_DIR}/postgres.sql.gz"
  run_scp_to target "${REDIS_DUMP_FILE}" "${TARGET_REMOTE_BUNDLE_DIR}/redis-dump.rdb"
  run_scp_to target "${APP_ENV_BUNDLE_FILE}" "${TARGET_REMOTE_BUNDLE_DIR}/app.env"
  run_scp_to target "${TARGET_OVERRIDE_FILE}" "${TARGET_REMOTE_BUNDLE_DIR}/target-env-overrides.env"
  run_scp_to target "${METADATA_FILE}" "${TARGET_REMOTE_BUNDLE_DIR}/metadata.env"
  run_scp_to target "${CHECKSUMS_FILE}" "${TARGET_REMOTE_BUNDLE_DIR}/checksums.sha256"
}

verify_remote_bundle_checksums() {
  log_info "Verifying transferred bundle checksums on target."
  remote_run target "cd $(q "${TARGET_REMOTE_BUNDLE_DIR}") && sha256sum -c checksums.sha256 >/dev/null"
}

prepare_target_app_directory() {
  local reset_ok="${ALLOW_TARGET_RESET}"
  if [[ "${TARGET_RESET_ALLOWED}" == "1" ]]; then
    reset_ok="1"
  fi
  log_info "Preparing target application directory ${TARGET_REMOTE_APP_DIR}."
  remote_sudo target "$(cat <<EOF
app_dir=$(q "${TARGET_REMOTE_APP_DIR}")
parent_dir=\$(dirname -- "${TARGET_REMOTE_APP_DIR}")
user_name=$(q "${TARGET_USER}")
reset_ok=$(q "${reset_ok}")
if [[ -d "\${app_dir}" ]]; then
  if [[ "\${reset_ok}" == "1" ]]; then
    rm -rf "\${app_dir}"
  else
    if find "\${app_dir}" -mindepth 1 -maxdepth 1 | grep -q .; then
      echo "Target app dir is not empty and reset is not allowed." >&2
      exit 1
    fi
  fi
fi
mkdir -p "\${parent_dir}" "\${app_dir}"
chown -R "\${user_name}:\${user_name}" "\${app_dir}"
EOF
)"
}

extract_target_app_bundle() {
  log_info "Extracting application snapshot on target."
  remote_run target "$(cat <<EOF
mkdir -p $(q "${TARGET_REMOTE_APP_DIR}")
tar -xzf $(q "${TARGET_REMOTE_BUNDLE_DIR}/app.tar.gz") -C $(q "${TARGET_REMOTE_APP_DIR}")
mkdir -p $(q "${TARGET_REMOTE_APP_DIR}/.migration-state")
printf '%s\n' $(q "${BUNDLE_ID}") > $(q "${TARGET_REMOTE_APP_DIR}/.migration-state/bundle-id")
cp $(q "${TARGET_REMOTE_BUNDLE_DIR}/app.env") $(q "${TARGET_REMOTE_APP_DIR}/deploy/env/.app.env")
if [[ -s $(q "${TARGET_REMOTE_BUNDLE_DIR}/target-env-overrides.env") ]]; then
  cd $(q "${TARGET_REMOTE_APP_DIR}")
  python3 automation/lib/env_tools.py merge deploy/env/.app.env $(q "${TARGET_REMOTE_BUNDLE_DIR}/target-env-overrides.env") deploy/env/.app.env.merged --non-empty-only
  mv deploy/env/.app.env.merged deploy/env/.app.env
fi
EOF
)"
}

ensure_target_docker() {
  log_info "Ensuring Docker is available on target."
  local needs_install
  needs_install="$(remote_run target "$(cat <<EOF
if ! command -v docker >/dev/null 2>&1; then
  echo yes
elif ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  echo yes
elif [[ -n $(q "${DEPLOY_DOCKER_VERSION:-}") ]] && ! docker --version | grep -Fq $(q "${DEPLOY_DOCKER_VERSION:-}"); then
  echo yes
else
  echo no
fi
EOF
)")"
  if [[ "${needs_install}" == "yes" ]]; then
    remote_sudo target "cd $(q "${TARGET_REMOTE_APP_DIR}") && bash deploy/scripts/install-docker.sh $(q "${DEPLOY_DOCKER_VERSION:-}")"
  fi
}

target_compose_reset() {
  remote_run target "$(compose_remote_script "${TARGET_REMOTE_APP_DIR}" "$(cat <<'EOF'
compose "${COMPOSE_ARGS[@]}" down --volumes --remove-orphans || true
compose "${COMPOSE_ARGS[@]}" up -d postgres redis
EOF
)")"
}

wait_for_target_core_services() {
  log_info "Waiting for target postgres and redis."
  local deadline=$(( $(date +%s) + HEALTHCHECK_TIMEOUT_SECONDS ))
  while true; do
    if remote_run target "$(compose_remote_script "${TARGET_REMOTE_APP_DIR}" "$(cat <<'EOF'
compose "${COMPOSE_ARGS[@]}" exec -T postgres pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-bangla_library}" >/dev/null
compose "${COMPOSE_ARGS[@]}" exec -T redis redis-cli ping | grep -Fq PONG
EOF
)")" >/dev/null 2>&1; then
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      die "Timed out waiting for target postgres/redis."
    fi
    sleep 5
  done
}

restore_target_postgres() {
  log_info "Restoring PostgreSQL cluster on target."
  remote_run target "$(compose_remote_script "${TARGET_REMOTE_APP_DIR}" "$(cat <<EOF
gunzip -c $(q "${TARGET_REMOTE_BUNDLE_DIR}/postgres.sql.gz") | compose "\${COMPOSE_ARGS[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U "\${POSTGRES_USER:-postgres}" -d postgres
EOF
)")"
}

restore_target_redis() {
  log_info "Restoring Redis dump on target."
  remote_run target "$(compose_remote_script "${TARGET_REMOTE_APP_DIR}" "$(cat <<EOF
compose "\${COMPOSE_ARGS[@]}" stop redis
container_id="\$(compose "\${COMPOSE_ARGS[@]}" ps -q redis)"
docker cp $(q "${TARGET_REMOTE_BUNDLE_DIR}/redis-dump.rdb") "\${container_id}:/data/dump.rdb"
compose "\${COMPOSE_ARGS[@]}" start redis
compose "\${COMPOSE_ARGS[@]}" exec -T redis redis-cli ping | grep -Fq PONG
EOF
)")"
}

restore_target_storage() {
  log_info "Restoring storage tree on target."
  remote_run target "$(cat <<EOF
mkdir -p $(q "${TARGET_REMOTE_APP_DIR}/app/backend")
tar -xzf $(q "${TARGET_REMOTE_BUNDLE_DIR}/storage.tar.gz") -C $(q "${TARGET_REMOTE_APP_DIR}/app/backend")
EOF
)"
  remote_sudo target "chown -R $(q "${TARGET_USER}:${TARGET_USER}") $(q "${TARGET_REMOTE_APP_DIR}/app/backend/storage") && chmod -R u+rwX,go+rX $(q "${TARGET_REMOTE_APP_DIR}/app/backend/storage")"
}

compare_summary_value() {
  local label="${1:?label is required}"
  local source_value="${2:-}"
  local target_value="${3:-}"
  if [[ "${source_value}" != "${target_value}" ]]; then
    die "Summary mismatch for ${label}: source=${source_value} target=${target_value}"
  fi
}

capture_target_prestart_summary() {
  local db_summary redis_summary storage_summary
  db_summary="$(capture_db_summary target "${TARGET_REMOTE_APP_DIR}")"
  redis_summary="$(capture_redis_summary target "${TARGET_REMOTE_APP_DIR}")"
  storage_summary="$(capture_storage_summary target "${TARGET_REMOTE_APP_DIR}/app/backend/storage")"

  local DB_TABLE_COUNT="" DB_ROW_TOTAL="" DB_ROLE_COUNT="" DB_TABLE_ROWS_SHA256=""
  local REDIS_DBSIZE="" REDIS_QUEUE_CELERY="" REDIS_QUEUE_PROCESSING="" REDIS_USED_MEMORY=""
  local STORAGE_FILE_COUNT="" STORAGE_TOTAL_BYTES=""

  while IFS='=' read -r key value; do
    [[ -n "${key}" ]] || continue
    printf -v "${key}" '%s' "${value}"
  done <<<"${db_summary}"$'\n'"${redis_summary}"$'\n'"${storage_summary}"

  compare_summary_value DB_TABLE_COUNT "${SOURCE_DB_TABLE_COUNT}" "${DB_TABLE_COUNT}"
  compare_summary_value DB_ROW_TOTAL "${SOURCE_DB_ROW_TOTAL}" "${DB_ROW_TOTAL}"
  compare_summary_value DB_ROLE_COUNT "${SOURCE_DB_ROLE_COUNT}" "${DB_ROLE_COUNT}"
  compare_summary_value DB_TABLE_ROWS_SHA256 "${SOURCE_DB_TABLE_ROWS_SHA256}" "${DB_TABLE_ROWS_SHA256}"
  compare_summary_value REDIS_DBSIZE "${SOURCE_REDIS_DBSIZE}" "${REDIS_DBSIZE}"
  compare_summary_value REDIS_QUEUE_CELERY "${SOURCE_REDIS_QUEUE_CELERY}" "${REDIS_QUEUE_CELERY}"
  compare_summary_value REDIS_QUEUE_PROCESSING "${SOURCE_REDIS_QUEUE_PROCESSING}" "${REDIS_QUEUE_PROCESSING}"
  compare_summary_value STORAGE_FILE_COUNT "${SOURCE_STORAGE_FILE_COUNT}" "${STORAGE_FILE_COUNT}"
  compare_summary_value STORAGE_TOTAL_BYTES "${SOURCE_STORAGE_TOTAL_BYTES}" "${STORAGE_TOTAL_BYTES}"

  append_metadata TARGET_PRESTART_DB_TABLE_COUNT "${DB_TABLE_COUNT}"
  append_metadata TARGET_PRESTART_DB_ROW_TOTAL "${DB_ROW_TOTAL}"
  append_metadata TARGET_PRESTART_DB_ROLE_COUNT "${DB_ROLE_COUNT}"
  append_metadata TARGET_PRESTART_DB_TABLE_ROWS_SHA256 "${DB_TABLE_ROWS_SHA256}"
  append_metadata TARGET_PRESTART_REDIS_DBSIZE "${REDIS_DBSIZE}"
  append_metadata TARGET_PRESTART_REDIS_QUEUE_CELERY "${REDIS_QUEUE_CELERY}"
  append_metadata TARGET_PRESTART_REDIS_QUEUE_PROCESSING "${REDIS_QUEUE_PROCESSING}"
  append_metadata TARGET_PRESTART_STORAGE_FILE_COUNT "${STORAGE_FILE_COUNT}"
  append_metadata TARGET_PRESTART_STORAGE_TOTAL_BYTES "${STORAGE_TOTAL_BYTES}"
  append_metadata TARGET_PRESTART_SUMMARY_MATCH "1"
}

wait_for_backend_init() {
  log_info "Running backend-init on target."
  remote_run target "$(compose_remote_script "${TARGET_REMOTE_APP_DIR}" "$(cat <<'EOF'
compose "${COMPOSE_ARGS[@]}" up -d backend-init
EOF
)")"

  local deadline=$(( $(date +%s) + HEALTHCHECK_TIMEOUT_SECONDS ))
  while true; do
    local status exit_code
    status="$(remote_run target "$(compose_remote_script "${TARGET_REMOTE_APP_DIR}" "$(cat <<'EOF'
container_id="$(compose "${COMPOSE_ARGS[@]}" ps -q backend-init)"
docker inspect -f '{{.State.Status}}' "${container_id}"
EOF
)")")"
    if [[ "${status}" == "exited" ]]; then
      exit_code="$(remote_run target "$(compose_remote_script "${TARGET_REMOTE_APP_DIR}" "$(cat <<'EOF'
container_id="$(compose "${COMPOSE_ARGS[@]}" ps -q backend-init)"
docker inspect -f '{{.State.ExitCode}}' "${container_id}"
EOF
)")")"
      [[ "${exit_code}" == "0" ]] || die "backend-init failed with exit code ${exit_code}"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      die "Timed out waiting for backend-init to finish."
    fi
    sleep 5
  done
}

start_target_application() {
  log_info "Starting target application services."
  remote_run target "$(compose_remote_script "${TARGET_REMOTE_APP_DIR}" "$(cat <<'EOF'
compose "${COMPOSE_ARGS[@]}" up -d backend frontend worker processing-worker beat
EOF
)")"
}

run_restore() {
  verify_bundle_ready_for_restore
  if [[ "${DRY_RUN}" == "1" ]]; then
    log_info "DRY RUN: restore would upload bundle and recreate the target stack."
    mark_phase_done restore
    return 0
  fi

  upload_bundle_to_target
  verify_remote_bundle_checksums
  prepare_target_app_directory
  extract_target_app_bundle
  ensure_target_docker
  target_compose_reset
  wait_for_target_core_services
  restore_target_postgres
  restore_target_redis
  restore_target_storage
  capture_target_prestart_summary
  wait_for_backend_init
  start_target_application
  mark_phase_done restore
  log_info "Restore completed."
}

target_service_health_check() {
  local verify_script
  verify_script="$(cat <<EOF
$(container_status_report_script)
service_status postgres 1
service_status redis 1
service_status backend 1
service_status frontend 0
service_status worker 0
service_status processing-worker 0
service_status beat 0
python3 - <<'PY'
import os
import urllib.request

backend_port = os.environ.get("BACKEND_PORT", "${BACKEND_PORT}")
frontend_port = os.environ.get("FRONTEND_PORT", "${FRONTEND_PORT}")
urllib.request.urlopen(f"http://127.0.0.1:{backend_port}/api/csrf/", timeout=20)
urllib.request.urlopen(f"http://127.0.0.1:{frontend_port}/", timeout=20)
print("ok")
PY
EOF
)"
  remote_run target "$(compose_remote_script "${TARGET_REMOTE_APP_DIR}" "${verify_script}")" >/dev/null
}

verify_target_live_summaries() {
  local live_db_summary live_storage_summary
  live_db_summary="$(capture_db_summary target "${TARGET_REMOTE_APP_DIR}")"
  live_storage_summary="$(capture_storage_summary target "${TARGET_REMOTE_APP_DIR}/app/backend/storage")"

  local DB_TABLE_COUNT="" DB_ROW_TOTAL="" DB_ROLE_COUNT="" DB_TABLE_ROWS_SHA256="" STORAGE_FILE_COUNT="" STORAGE_TOTAL_BYTES=""
  while IFS='=' read -r key value; do
    case "${key}" in
      DB_TABLE_COUNT|DB_ROW_TOTAL|DB_ROLE_COUNT|DB_TABLE_ROWS_SHA256|STORAGE_FILE_COUNT|STORAGE_TOTAL_BYTES)
        printf -v "${key}" '%s' "${value}"
        ;;
    esac
  done <<<"${live_db_summary}"$'\n'"${live_storage_summary}"

  compare_summary_value LIVE_DB_TABLE_COUNT "${SOURCE_DB_TABLE_COUNT}" "${DB_TABLE_COUNT}"
  compare_summary_value LIVE_DB_ROW_TOTAL "${SOURCE_DB_ROW_TOTAL}" "${DB_ROW_TOTAL}"
  compare_summary_value LIVE_DB_ROLE_COUNT "${SOURCE_DB_ROLE_COUNT}" "${DB_ROLE_COUNT}"
  compare_summary_value LIVE_DB_TABLE_ROWS_SHA256 "${SOURCE_DB_TABLE_ROWS_SHA256}" "${DB_TABLE_ROWS_SHA256}"
  compare_summary_value LIVE_STORAGE_FILE_COUNT "${SOURCE_STORAGE_FILE_COUNT}" "${STORAGE_FILE_COUNT}"
  compare_summary_value LIVE_STORAGE_TOTAL_BYTES "${SOURCE_STORAGE_TOTAL_BYTES}" "${STORAGE_TOTAL_BYTES}"
}

maybe_configure_target_edge() {
  preflight_edge_setup

  if [[ "${EDGE_SETUP_READY}" != "1" ]]; then
    append_metadata EDGE_SETUP_STATUS "skipped:${EDGE_SETUP_REASON}"
    log_info "Skipping edge setup: ${EDGE_SETUP_REASON}."
    if [[ "${EDGE_SETUP_REASON}" == "dns_mismatch" ]]; then
      log_info "After Cloudflare points ${TARGET_DOMAIN} to ${TARGET_IP}, rerun --phase verify --resume to finish nginx/certbot setup."
    fi
    return 0
  fi

  log_info "Configuring target nginx/certbot edge."
  remote_sudo target "cd $(q "${TARGET_REMOTE_APP_DIR}") && bash deploy/scripts/setup-host-nginx.sh $(q "${TARGET_DOMAIN}") $(q "${TARGET_CERTBOT_EMAIL}") $(q "${TARGET_REMOTE_APP_DIR}") $(q "${BACKEND_PORT}") $(q "${FRONTEND_PORT}") $(q "${DEPLOY_NGINX_CONFIG_NAME}") $(q "${DEPLOY_NGINX_CONF_DIR}") $(q "${DEPLOY_NGINX_VERSION}")"
  remote_run target "$(cat <<EOF
python3 - "${TARGET_DOMAIN}" <<'PY'
import sys
import urllib.request

domain = sys.argv[1]
urllib.request.urlopen(f"https://{domain}/", timeout=20)
urllib.request.urlopen(f"https://{domain}/api/csrf/", timeout=20)
print("ok")
PY
EOF
)" >/dev/null
  append_metadata EDGE_SETUP_STATUS "configured"
}

run_verify() {
  verify_bundle_ready_for_restore

  if [[ "${TARGET_PRESTART_SUMMARY_MATCH:-0}" != "1" ]]; then
    die "Target prestart summary verification did not complete successfully."
  fi

  if [[ "${DRY_RUN}" == "1" ]]; then
    log_info "DRY RUN: verify would check target service health and optional edge setup."
    mark_phase_done verify
    return 0
  fi

  target_service_health_check
  verify_target_live_summaries
  maybe_configure_target_edge
  append_metadata VERIFIED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mark_phase_done verify
  log_info "Verification completed."
}

phase_should_run() {
  local phase_name="${1:?phase name is required}"
  if [[ "${RESUME}" == "1" && "$(phase_is_done "${phase_name}" && echo yes || echo no)" == "yes" ]]; then
    log_info "Skipping ${phase_name}; already marked complete in ${BUNDLE_DIR}."
    return 1
  fi
  return 0
}

cleanup_remote_bundle_on_success() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    return 0
  fi
  remote_run target "rm -rf $(q "${TARGET_REMOTE_BUNDLE_DIR}")" >/dev/null 2>&1 || true
}

finalize_success() {
  FINAL_SUCCESS=1
  if [[ "${SOURCE_FROZEN}" == "1" && "${KEEP_SOURCE_DOWN_ON_SUCCESS}" == "0" ]]; then
    restart_source_stack
  fi

  cleanup_remote_bundle_on_success

  if [[ "${KEEP_STAGING}" == "0" && "${DRY_RUN}" == "0" ]]; then
    rm -rf "${BUNDLE_DIR}"
    log_info "Removed local staging bundle ${BUNDLE_DIR}."
  fi
}

on_exit() {
  local exit_code=$?
  if [[ "${exit_code}" != "0" && "${SOURCE_FROZEN}" == "1" ]]; then
    log_warn "Failure detected after source freeze; attempting to restart the source services."
    restart_source_stack || true
  fi
  exit "${exit_code}"
}

main() {
  parse_args "$@"
  initialize_config
  validate_required_config
  trap on_exit EXIT

  if [[ "${PHASE}" == "preflight" || "${PHASE}" == "full" ]]; then
    phase_should_run preflight && run_preflight
  fi

  if [[ "${PHASE}" == "snapshot" || "${PHASE}" == "full" ]]; then
    if ! phase_is_done preflight; then
      log_info "Snapshot requires preflight first."
      run_preflight
    fi
    phase_should_run snapshot && run_snapshot
  fi

  if [[ "${PHASE}" == "restore" || "${PHASE}" == "full" ]]; then
    phase_should_run restore && run_restore
  fi

  if [[ "${PHASE}" == "verify" || "${PHASE}" == "full" ]]; then
    phase_should_run verify && run_verify
  fi

  finalize_success
}

main "$@"
