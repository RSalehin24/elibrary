#!/usr/bin/env bash

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (use sudo)." >&2
  exit 1
fi

required_version="${1:-}"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release

install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi

. /etc/os-release
arch="$(dpkg --print-architecture)"
cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable
EOF

apt-get update

resolve_package_version() {
  local package_name="${1:?package name is required}"
  local short_version="${2:-}"

  if [[ -z "${short_version}" ]]; then
    apt-cache madison "${package_name}" | awk 'NR==1 { print $3 }'
    return
  fi

  apt-cache madison "${package_name}" | awk -v requested="${short_version}" '
    index($3, requested) > 0 { print $3; exit }
  '
}

docker_package_version="$(resolve_package_version docker-ce "${required_version}")"
if [[ -z "${docker_package_version}" ]]; then
  echo "Unable to resolve docker-ce version for ${required_version:-latest}." >&2
  exit 1
fi

docker_cli_package_version="$(resolve_package_version docker-ce-cli "${required_version}")"
if [[ -z "${docker_cli_package_version}" ]]; then
  echo "Unable to resolve docker-ce-cli version for ${required_version:-latest}." >&2
  exit 1
fi

apt-get install -y \
  "docker-ce=${docker_package_version}" \
  "docker-ce-cli=${docker_cli_package_version}" \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

systemctl enable docker
systemctl restart docker
docker --version
docker compose version
