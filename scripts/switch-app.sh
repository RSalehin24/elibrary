#!/bin/sh

set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/switch-app.sh <library|nextcloud>

Description:
  - library   : stops nextcloud-aio containers, starts library_app docker-compose
  - nextcloud : stops library_app docker-compose, starts nextcloud-aio containers

Environment overrides:
  LIB_DIR=/home/ubuntu/library_app
  NEXTCLOUD_PATTERN='^nextcloud-aio'
EOF
}

if [ "${1:-}" = "" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

TARGET_APP="$1"
LIB_DIR="${LIB_DIR:-$HOME/library_app}"
NEXTCLOUD_PATTERN="${NEXTCLOUD_PATTERN:-^nextcloud-aio}"

nextcloud_containers() {
  docker ps -a --format '{{.Names}}' | grep -E "$NEXTCLOUD_PATTERN" || true
}

stop_nextcloud() {
  containers="$(nextcloud_containers)"
  if [ -n "$containers" ]; then
    echo "$containers" | xargs -r docker stop >/dev/null
    echo "Stopped nextcloud containers"
  else
    echo "No nextcloud containers matched pattern: $NEXTCLOUD_PATTERN"
  fi
}

start_nextcloud() {
  containers="$(nextcloud_containers)"
  if [ -n "$containers" ]; then
    echo "$containers" | xargs -r docker start >/dev/null
    echo "Started nextcloud containers"
  else
    echo "No nextcloud containers matched pattern: $NEXTCLOUD_PATTERN"
    echo "Set NEXTCLOUD_PATTERN if your container names differ."
    exit 1
  fi
}

stop_library() {
  if [ ! -f "$LIB_DIR/docker-compose.yml" ]; then
    echo "Library app not found at $LIB_DIR"
    return 0
  fi

  (
    cd "$LIB_DIR"
    docker-compose stop >/dev/null
  )
  echo "Stopped library_app docker-compose stack"
}

start_library() {
  if [ ! -f "$LIB_DIR/docker-compose.yml" ]; then
    echo "Library app not found at $LIB_DIR"
    exit 1
  fi

  (
    cd "$LIB_DIR"
    docker-compose up -d --build
  )
  echo "Started library_app docker-compose stack"
}

case "$TARGET_APP" in
  library)
    stop_nextcloud
    start_library
    ;;
  nextcloud)
    stop_library
    start_nextcloud
    ;;
  *)
    usage
    exit 1
    ;;
esac
