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

if [ -z "${CERTBOT_DOMAIN:-}" ]; then
  export CERTBOT_DOMAIN="$NGINX_SERVER_NAME"
fi

SSL_ENABLED="${SSL_ENABLED:-1}"
SSL_CERT="/etc/letsencrypt/live/${CERTBOT_DOMAIN}/fullchain.pem"
SSL_KEY="/etc/letsencrypt/live/${CERTBOT_DOMAIN}/privkey.pem"

if [ "$SSL_ENABLED" = "1" ] && [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
  cp /etc/nginx/templates/library-ssl.conf.template /etc/nginx/templates/default.conf.template
else
  cp /etc/nginx/templates/library-http.conf.template /etc/nginx/templates/default.conf.template
fi

exec /docker-entrypoint.sh nginx -g 'daemon off;'
