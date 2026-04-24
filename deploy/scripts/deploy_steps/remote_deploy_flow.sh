check_published_port() {
  local service="$1"
  local container_port="$2"
  local expected="127.0.0.1:$3"
  local published=""

  for _ in $(seq 1 20); do
    published="$("${compose_cmd[@]}" "${compose_args[@]}" port "${service}" "${container_port}" 2>/dev/null || true)"
    if [[ "${published}" == "${expected}" ]]; then
      return 0
    fi
    sleep 2
  done

  echo "Port binding mismatch for ${service}: expected ${expected}, got ${published:-<none>}" >&2
  "${compose_cmd[@]}" "${compose_args[@]}" ps
  return 1
}

check_published_port backend 8000 "${BACKEND_PORT}"
check_published_port frontend 80 "${FRONTEND_PORT}"
EOF
}

configure_remote_nginx() {
  print_info "[7/8] Configuring host nginx and certbot on ${TARGET}"
  ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && sudo bash deploy/scripts/setup-host-nginx.sh '${DOMAIN}' '${CERTBOT_EMAIL}' '${REMOTE_APP_ABS_DIR}' '${BACKEND_PORT}' '${FRONTEND_PORT}' '${DEPLOY_NGINX_CONFIG_NAME}' '${DEPLOY_NGINX_CONF_DIR}' '${DEPLOY_NGINX_VERSION}'"
}

verify_deployment() {
  local remote_nginx_config_path="${DEPLOY_NGINX_CONF_DIR}/${DEPLOY_NGINX_CONFIG_NAME}"

  print_info "[8/8] Verifying nginx configuration and HTTPS reachability"
  ssh "${TARGET}" "sudo nginx -T 2>/dev/null | grep -Fq '${remote_nginx_config_path}'" || die "Expected nginx config was not loaded: ${remote_nginx_config_path}"
  ssh "${TARGET}" "if command -v curl >/dev/null 2>&1; then curl -fsSIL --max-time 20 https://${DOMAIN}/ >/dev/null && curl -fsSI --max-time 20 https://${DOMAIN}/api/csrf/ >/dev/null; elif command -v wget >/dev/null 2>&1; then wget -q --spider --timeout=20 https://${DOMAIN}/ && wget -q --spider --timeout=20 https://${DOMAIN}/api/csrf/; else exit 127; fi" || die "HTTPS verification failed for https://${DOMAIN}"
  print_info "Deployment verification passed for https://${DOMAIN}"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ensure_env_file "${HOST_ENV_TEMPLATE}" "${HOST_ENV_FILE}"
load_env_if_present "${HOST_ENV_FILE}"

ENV_NAME="${DEPLOY_ENV_NAME:-production}"
LOCAL_ENV_FILE=""
SYNC_MODE="${DEPLOY_ENV_SYNC_MODE:-push}"
SHOW_REMOTE_SUPER_ADMIN_NOTICE="no"
LOCAL_SUPER_ADMIN_EMAIL=""
LOCAL_SUPER_ADMIN_PASSWORD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-name)
      ENV_NAME="${2:?--env-name requires a value}"
      shift 2
      ;;
    --env-file)
      LOCAL_ENV_FILE="${2:?--env-file requires a value}"
      shift 2
      ;;
    --sync-mode)
      SYNC_MODE="${2:?--sync-mode requires a value}"
      shift 2
      ;;
    *)
      usage
      die "Unsupported argument: $1"
      ;;
  esac
done

if [[ -z "${LOCAL_ENV_FILE}" ]]; then
  LOCAL_ENV_FILE="${REPO_ROOT}/deploy/env/.${ENV_NAME}.env"
fi

local_env_created="no"
if [[ ! -f "${LOCAL_ENV_FILE}" ]]; then
  ensure_env_file "${APP_ENV_TEMPLATE}" "${LOCAL_ENV_FILE}"
  local_env_created="yes"
fi

DEPLOY_USER_NAME="${DEPLOY_USER_NAME:-ubuntu}"
DEPLOY_IP="${DEPLOY_IP:-}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-}"
DEPLOY_CERTBOT_EMAIL="${DEPLOY_CERTBOT_EMAIL:-}"
DEPLOY_NGINX_CONF_DIR="${DEPLOY_NGINX_CONF_DIR:-/etc/nginx/conf.d}"
DEPLOY_NGINX_CONFIG_NAME="${DEPLOY_NGINX_CONFIG_NAME:-${DEPLOY_DOMAIN}.conf}"
DEPLOY_NGINX_VERSION="${DEPLOY_NGINX_VERSION:-1.29.4}"
DEPLOY_DOCKER_VERSION="${DEPLOY_DOCKER_VERSION:-}"
DEPLOY_REMOTE_EDITOR="${DEPLOY_REMOTE_EDITOR:-${EDITOR:-nano}}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-4173}"
REPO_SSH="${REPO_SSH:-git@github.com:RSalehin24/ebook-scrapping.git}"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'main')"
BRANCH="${DEPLOY_BRANCH_NAME:-${CURRENT_BRANCH}}"
TARGET="${DEPLOY_USER_NAME}@${DEPLOY_IP}"
DOMAIN="${DEPLOY_DOMAIN}"
CERTBOT_EMAIL="${DEPLOY_CERTBOT_EMAIL}"
REMOTE_APP_DIR='~/library_app'
REMOTE_APP_ABS_DIR="${DEPLOY_REMOTE_APP_DIR:-/home/${DEPLOY_USER_NAME}/library_app}"

case "${DEPLOY_NGINX_CONFIG_NAME}" in
  *.conf) ;;
  *) DEPLOY_NGINX_CONFIG_NAME="${DEPLOY_NGINX_CONFIG_NAME}.conf" ;;
esac

require_cmd ssh
require_cmd scp
require_cmd git
require_cmd python3

[[ -n "${DEPLOY_IP}" ]] || die "DEPLOY_IP must be set in deploy/env/.host.env"
[[ -n "${DEPLOY_DOMAIN}" ]] || die "DEPLOY_DOMAIN must be set in deploy/env/.host.env"
[[ -n "${DEPLOY_CERTBOT_EMAIL}" ]] || die "DEPLOY_CERTBOT_EMAIL must be set in deploy/env/.host.env"

if [[ "${local_env_created}" == "yes" ]]; then
  choice="$(timed_prompt "Prepared ${LOCAL_ENV_FILE}. Edit it now? [y/N] (auto-continue in 5s): " 5 "n")"
  if [[ "${choice}" =~ ^[Yy]$ ]]; then
    "${EDITOR:-nano}" "${LOCAL_ENV_FILE}"
  fi
fi

validate_local_database_env "${LOCAL_ENV_FILE}"
require_non_empty_env_key "${LOCAL_ENV_FILE}" "DJANGO_SECRET_KEY"
require_non_empty_env_key "${LOCAL_ENV_FILE}" "SUPER_ADMIN_EMAIL"
require_non_empty_env_key "${LOCAL_ENV_FILE}" "SUPER_ADMIN_PASSWORD"

LOCAL_SUPER_ADMIN_EMAIL="$(read_env_value_from_file "${LOCAL_ENV_FILE}" "SUPER_ADMIN_EMAIL")"
LOCAL_SUPER_ADMIN_PASSWORD="$(read_env_value_from_file "${LOCAL_ENV_FILE}" "SUPER_ADMIN_PASSWORD")"

print_info "[1/8] Running deployment preflight checks"
resolved_ips="$(resolve_domain_ips "${DOMAIN}")"
if [[ -z "${resolved_ips}" || "$(printf '%s\n' "${resolved_ips}" | grep -Fx "${DEPLOY_IP}" || true)" == "" ]]; then
  die "DNS A record mismatch for ${DOMAIN}. Expected ${DEPLOY_IP}. Resolved: ${resolved_ips:-<none>}"
fi

ssh -o BatchMode=yes -o ConnectTimeout=10 "${TARGET}" "echo connected" >/dev/null 2>&1 || die "SSH key access to ${TARGET} is not working."
ssh -o BatchMode=yes "${TARGET}" "sudo -n true" >/dev/null 2>&1 || die "Passwordless sudo is required for fully automated deployment on ${TARGET}."

sync_remote_repository
sync_workspace_files

if ssh "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && test -f '${REMOTE_SUPER_ADMIN_NOTICE_MARKER}'" >/dev/null 2>&1; then
  SHOW_REMOTE_SUPER_ADMIN_NOTICE="no"
else
  SHOW_REMOTE_SUPER_ADMIN_NOTICE="yes"
fi

case "${SYNC_MODE}" in
  push|preserve) ;;
  prompt)
    SYNC_MODE="$(timed_prompt "Remote env sync mode [push/preserve] (default preserve, auto-continue in 5s): " 5 "preserve")"
    [[ "${SYNC_MODE}" == "push" || "${SYNC_MODE}" == "preserve" ]] || SYNC_MODE="preserve"
    ;;
  *)
    die "Unsupported sync mode: ${SYNC_MODE}"
    ;;
esac

sync_remote_env_file "${SYNC_MODE}"

remote_env_choice="$(timed_prompt "Edit remote deploy/env/.app.env now? [y/N] (auto-continue in 5s): " 5 "n")"
if [[ "${remote_env_choice}" =~ ^[Yy]$ ]]; then
  ssh -t "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && ${DEPLOY_REMOTE_EDITOR} ${REMOTE_APP_ENV_REL}"
fi

ensure_remote_docker
start_remote_stack
configure_remote_nginx
verify_deployment

if [[ "${SHOW_REMOTE_SUPER_ADMIN_NOTICE}" == "yes" ]]; then
  print_super_admin_credentials \
    "${LOCAL_SUPER_ADMIN_EMAIL}" \
    "${LOCAL_SUPER_ADMIN_PASSWORD}" \
    "First remote deployment super admin credentials" \
    "Note these credentials down carefully for future usage. This deployment script will not show them again for this remote target."
  ssh "${TARGET}" "cd '${REMOTE_APP_ABS_DIR}' && touch '${REMOTE_SUPER_ADMIN_NOTICE_MARKER}'"
fi
