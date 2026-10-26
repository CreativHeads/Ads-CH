#!/usr/bin/env bash
# Deploy the committed app to the VPS and serve it at ads.creativheads.com.
# Run from hostinger-web in Git Bash:  bash deploy/vps/deploy.sh
# Safe to re-run for updates: it replaces the code, keeps the data volume and .env.
set -euo pipefail

HOST=root@187.126.125.145
KEY=~/.ssh/creativheads_vps
DOMAIN=ads.creativheads.com
CADDYFILE=/opt/casting-manager/deploy/vps/Caddyfile
SSH="ssh -i $KEY -o BatchMode=yes $HOST"

cd "$(dirname "$0")/../.."

echo "==> Uploading committed code ($(git rev-parse --short HEAD))"
git archive --format=tar HEAD | $SSH 'mkdir -p /opt/ad-reports && tar xf - -C /opt/ad-reports'

if ! $SSH 'test -f /opt/ad-reports/deploy/vps/.env'; then
  echo "==> Copying .env (first deploy only)"
  $SSH 'umask 077; cat > /opt/ad-reports/deploy/vps/.env' < .env
fi

echo "==> Building and starting the container"
$SSH 'cd /opt/ad-reports/deploy/vps && docker compose up -d --build && docker compose ps'

echo "==> Adding $DOMAIN to Caddy (only if missing)"
$SSH "set -e
if ! grep -q '^$DOMAIN ' $CADDYFILE; then
  cp $CADDYFILE $CADDYFILE.bak-ad-reports
  printf '\n$DOMAIN {\n\tencode gzip\n\treverse_proxy ad-reports:3000\n}\n' >> $CADDYFILE
  if ! docker exec casting-manager-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    cat $CADDYFILE.bak-ad-reports > $CADDYFILE   # same file, so the container bind mount keeps working
    echo 'Caddy config invalid, change reverted' >&2
    exit 1
  fi
fi
# A redeploy of casting-manager replaces the Caddyfile with a new file; the running container
# keeps the old one until it restarts, so a reload alone would not see the new site block.
if docker exec casting-manager-caddy-1 grep -q '^$DOMAIN ' /etc/caddy/Caddyfile; then
  docker exec casting-manager-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
else
  echo 'Caddy is reading an old copy of its Caddyfile; restarting it (a few seconds)'
  docker restart casting-manager-caddy-1 >/dev/null
  sleep 3
fi"

echo "==> Waiting for the HTTPS certificate"
for i in $(seq 1 24); do
  if curl -fsS -o /dev/null "https://$DOMAIN/"; then echo "HTTPS ok"; break; fi
  sleep 5
done

echo "==> Checking the app from inside Caddy"
$SSH 'docker exec casting-manager-caddy-1 wget -qO- http://ad-reports:3000/api/live | head -c 120; echo'
echo "Done. Once DNS points $DOMAIN to 187.126.125.145, open https://$DOMAIN"
