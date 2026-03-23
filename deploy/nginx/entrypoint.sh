#!/bin/sh

set -eu

if [ -z "${NGINX_SERVER_NAME:-}" ] && [ -n "${PUBLIC_BASE_URL:-}" ]; then
  derived_host=$(printf '%s' "$PUBLIC_BASE_URL" | sed -E 's#^[a-zA-Z]+://([^/:]+).*$#\1#')
  if [ -n "$derived_host" ] && [ "$derived_host" != "$PUBLIC_BASE_URL" ]; then
    export NGINX_SERVER_NAME="$derived_host"
  fi
fi

if [ -z "${NGINX_SERVER_NAME:-}" ]; then
  export NGINX_SERVER_NAME=localhost
fi

exec /docker-entrypoint.sh nginx -g 'daemon off;'
