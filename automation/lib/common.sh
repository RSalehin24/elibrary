#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "This file is meant to be sourced, not executed directly." >&2
  exit 1
fi

set -euo pipefail

repo_root_from() {
  local source_path="${1:?source path is required}"
  local search_dir
  search_dir="$(cd -- "$(dirname -- "${source_path}")" >/dev/null 2>&1 && pwd)"

  while [[ "${search_dir}" != "/" ]]; do
    if [[ -d "${search_dir}/.git" || -f "${search_dir}/AGENTS.md" ]]; then
      printf '%s\n' "${search_dir}"
      return 0
    fi
    search_dir="$(dirname -- "${search_dir}")"
  done

  return 1
}

print_info() {
  printf '[INFO] %s\n' "$*"
}

print_warn() {
  printf '[WARN] %s\n' "$*" >&2
}

print_error() {
  printf '[ERROR] %s\n' "$*" >&2
}

die() {
  print_error "$@"
  exit 1
}

require_cmd() {
  local command_name="${1:?command name is required}"
  command -v "${command_name}" >/dev/null 2>&1 || die "Missing required command: ${command_name}"
}

load_env_if_present() {
  local env_file="${1:?env file is required}"
  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

ensure_env_file() {
  local template_file="${1:?template file is required}"
  local target_file="${2:?target file is required}"

  require_cmd python3
  mkdir -p "$(dirname -- "${target_file}")"
  python3 "${REPO_ROOT}/automation/lib/env_tools.py" scaffold "${template_file}" "${target_file}"
}

resolve_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    printf 'docker compose'
    return 0
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    printf 'docker-compose'
    return 0
  fi

  return 1
}

compose() {
  local compose_cmd
  compose_cmd="$(resolve_compose_cmd)" || die "Docker Compose is not available."
  if [[ "${compose_cmd}" == "docker compose" ]]; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

prepare_log_file() {
  local log_file="${1:?log file is required}"
  mkdir -p "$(dirname -- "${log_file}")"
  touch "${log_file}"
}

timed_prompt() {
  local prompt_text="${1:?prompt text is required}"
  local timeout_seconds="${2:-5}"
  local default_value="${3:-}"
  local response=""

  if [[ ! -t 0 ]]; then
    printf '%s' "${default_value}"
    return 0
  fi

  printf '%s' "${prompt_text}"
  if IFS= read -r -t "${timeout_seconds}" response; then
    printf '\n'
  else
    printf '\n'
    response="${default_value}"
  fi

  if [[ -z "${response}" ]]; then
    response="${default_value}"
  fi

  printf '%s' "${response}"
}

service_group_for_logs() {
  local service_name="${1:?service name is required}"

  case "${service_name}" in
    frontend)
      printf 'frontend'
      ;;
    backend)
      printf 'backend worker beat'
      ;;
    *)
      return 1
      ;;
  esac
}
