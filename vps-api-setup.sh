#!/usr/bin/env bash
#
# Prepare the VPS to serve the Drop Involve API directly, removing the
# dependency on Render's free tier (which sleeps after 15 minutes and takes
# 30-60s to wake, delaying verification codes).
#
# Safe to run more than once. Nothing points at the VPS until the client is
# repointed separately, so this changes nothing for users on its own.
#
# Usage:  bash /root/vps-api-setup.sh

set -euo pipefail

APP_DIR=/var/www/drop-involve-backend
NGINX_CONF=/etc/nginx/sites-available/file.involve.no
STAMP=$(date +%Y%m%d-%H%M%S)

echo "== 1. Checking prerequisites =================================="

[ -d "$APP_DIR" ] || { echo "FAIL: $APP_DIR not found"; exit 1; }
[ -f "$NGINX_CONF" ] || { echo "FAIL: $NGINX_CONF not found"; exit 1; }
command -v nginx >/dev/null || { echo "FAIL: nginx not installed"; exit 1; }
echo "ok"

echo
echo "== 2. Session secret =========================================="

cd "$APP_DIR"
if grep -q '^SESSION_SECRET=' .env 2>/dev/null; then
  echo "SESSION_SECRET already present, leaving it alone"
else
  echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
  echo "SESSION_SECRET generated and appended to .env"
fi

echo
echo "Environment variables now set (values hidden):"
sed 's/=.*/=<set>/' .env | sed 's/^/  /'

echo
echo "== 3. Proxy headers ==========================================="

# Debian/Ubuntu ships /etc/nginx/proxy_params, but don't assume it.
if [ -f /etc/nginx/proxy_params ]; then
  PROXY_INCLUDE="include /etc/nginx/proxy_params;"
  echo "using /etc/nginx/proxy_params"
else
  cat > /etc/nginx/drop-proxy.conf <<'PROXYEOF'
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
PROXYEOF
  PROXY_INCLUDE="include /etc/nginx/drop-proxy.conf;"
  echo "proxy_params missing; wrote /etc/nginx/drop-proxy.conf instead"
fi

echo
echo "== 4. Rewriting nginx config =================================="

cp "$NGINX_CONF" "/root/nginx-file.involve.no.$STAMP.bak"
echo "backup: /root/nginx-file.involve.no.$STAMP.bak"

cat > "$NGINX_CONF" <<EOF
upstream drop_api {
    server 127.0.0.1:5000;
}

server {
    server_name file.involve.no;

    # Certificate renewal must stay reachable.
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Public routes: recipients follow these without any session.
    location /s/                    { proxy_pass http://drop_api; $PROXY_INCLUDE }
    location /track-download        { proxy_pass http://drop_api; $PROXY_INCLUDE }

    # Authentication routes.
    location /request-code          { proxy_pass http://drop_api; $PROXY_INCLUDE }
    location /verify-code           { proxy_pass http://drop_api; $PROXY_INCLUDE }

    # Session-guarded routes (see requireSession in index.js).
    location /generate-upload-url   { proxy_pass http://drop_api; $PROXY_INCLUDE }
    location /generate-download-url { proxy_pass http://drop_api; $PROXY_INCLUDE }
    location /send-email            { proxy_pass http://drop_api; $PROXY_INCLUDE }

    # Anything else is not part of the API.
    location / { return 404; }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/file.involve.no/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/file.involve.no/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if (\$host = file.involve.no) {
        return 301 https://\$host\$request_uri;
    } # managed by Certbot

    listen 80;
    server_name file.involve.no;
    return 404; # managed by Certbot
}
EOF

echo
echo "== 5. Testing config =========================================="

if ! nginx -t; then
  echo
  echo "CONFIG TEST FAILED - restoring the backup, nothing was applied."
  cp "/root/nginx-file.involve.no.$STAMP.bak" "$NGINX_CONF"
  exit 1
fi

echo
echo "== 6. Applying ================================================"

systemctl reload nginx
pm2 restart drop-backend
sleep 3

echo
echo "== 7. Verifying ==============================================="

check () {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $label (got $actual)"
  else
    echo "  FAIL  $label (expected $expected, got $actual)"
  fi
}

check "verify-code rejects empty body" 400 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST https://file.involve.no/verify-code \
     -H 'Content-Type: application/json' -d '{}')"

check "request-code rejects outside domain" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST https://file.involve.no/request-code \
     -H 'Content-Type: application/json' -d '{"emailFrom":"someone@gmail.com"}')"

check "unknown path blocked" 404 \
  "$(curl -s -o /dev/null -w '%{http_code}' https://file.involve.no/nope)"

check "short links still redirect" 302 \
  "$(curl -s -o /dev/null -w '%{http_code}' https://file.involve.no/s/cUo0XX)"

echo
echo "== 8. Certificate renewal ====================================="
certbot renew --dry-run 2>&1 | tail -4

echo
echo "Done. Nothing points at the VPS yet - the client still calls Render."
echo "Roll back with:"
echo "  cp /root/nginx-file.involve.no.$STAMP.bak $NGINX_CONF && nginx -t && systemctl reload nginx"
