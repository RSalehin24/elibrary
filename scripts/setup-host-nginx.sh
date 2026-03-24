#!/bin/sh

set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (use sudo)"
  exit 1
fi

DOMAIN="${1:-}"
CERTBOT_EMAIL="${2:-}"
APP_DIR="${3:-$HOME/library_app}"
BACKEND_PORT="${4:-8000}"
CONFIG_NAME="${5:-$DOMAIN}"
NGINX_CONF_DIR="${6:-/etc/nginx/conf.d}"
REQUIRED_NGINX_VERSION="${7:-1.29.4}"

if [ -z "$DOMAIN" ] || [ -z "$CERTBOT_EMAIL" ]; then
  cat <<'EOF'
Usage:
  sudo sh scripts/setup-host-nginx.sh <domain> <certbot_email> [app_dir] [backend_port] [config_name] [nginx_conf_dir] [required_nginx_version]

Example:
  sudo sh scripts/setup-host-nginx.sh library.rsalehin24.me admin@example.com /home/ubuntu/library_app 8000 library.salehin24.me /etc/nginx/conf.d 1.29.4
EOF
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  apt-get update
  apt-get install -y nginx
fi

if ! command -v certbot >/dev/null 2>&1; then
  apt-get update
  apt-get install -y certbot python3-certbot-nginx
fi

NGINX_VERSION="$(nginx -v 2>&1 | sed -E 's#^nginx version: nginx/##')"
if [ -n "$REQUIRED_NGINX_VERSION" ] && [ "$NGINX_VERSION" != "$REQUIRED_NGINX_VERSION" ]; then
  echo "Expected nginx/$REQUIRED_NGINX_VERSION but found nginx/$NGINX_VERSION"
  echo "Set required_nginx_version argument to your installed version if this is intentional."
  exit 1
fi

mkdir -p "$APP_DIR/storage/staticfiles" "$APP_DIR/storage/media"
mkdir -p "$NGINX_CONF_DIR"

CONFIG_PATH="$NGINX_CONF_DIR/$CONFIG_NAME"

cat > "$CONFIG_PATH" <<EOF
server {
  listen 80;
  server_name $DOMAIN;

  root $APP_DIR/frontend/dist;
  index index.html;

  client_max_body_size 64m;

  location /api/ {
    proxy_pass http://127.0.0.1:$BACKEND_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 300s;
  }

  location /admin/ {
    proxy_pass http://127.0.0.1:$BACKEND_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 300s;
  }

  location /static/ {
    alias $APP_DIR/storage/staticfiles/;
    expires 7d;
    add_header Cache-Control "public, max-age=604800";
  }

  location /media/ {
    alias $APP_DIR/storage/media/;
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
  }

  location / {
    try_files \$uri \$uri/ /index.html;
  }
}
EOF

nginx -t
systemctl enable nginx
systemctl reload nginx

certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$CERTBOT_EMAIL"

mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

if systemctl list-unit-files | grep -q '^certbot.timer'; then
  systemctl enable certbot.timer
  systemctl start certbot.timer
else
  cat > /etc/cron.d/certbot-renew <<'EOF'
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
0 */12 * * * root certbot renew --quiet
EOF
fi

systemctl reload nginx
nginx -v

echo "Host nginx + certbot configured for $DOMAIN (auto-renew enabled)"
