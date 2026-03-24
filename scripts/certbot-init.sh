#!/bin/sh

set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/certbot-init.sh

Required in .env:
  CERTBOT_EMAIL=you@example.com
  CERTBOT_DOMAIN=library.example.com

What it does:
  1) Starts nginx on port 80 for ACME challenge
  2) Requests first Let's Encrypt certificate via webroot
  3) Reloads nginx so HTTPS config becomes active
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ ! -f .env ]; then
  echo ".env not found in current directory"
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${CERTBOT_EMAIL:-}" ] || [ -z "${CERTBOT_DOMAIN:-}" ]; then
  echo "CERTBOT_EMAIL and CERTBOT_DOMAIN must be set in .env"
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Docker Compose not found"
  exit 127
fi

$COMPOSE_CMD up -d nginx

$COMPOSE_CMD run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  --email "$CERTBOT_EMAIL" \
  -d "$CERTBOT_DOMAIN" \
  --agree-tos --no-eff-email

$COMPOSE_CMD restart nginx

echo "Certificate setup completed for $CERTBOT_DOMAIN"
