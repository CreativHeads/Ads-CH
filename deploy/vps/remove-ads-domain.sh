#!/usr/bin/env bash
# One-time removal of the old ads.creativheads.com address (the app lives at pulse.creativheads.com).
# Run from hostinger-web in Git Bash:  bash deploy/vps/remove-ads-domain.sh
# Drops the ads.creativheads.com redirect from Caddy. Afterwards, delete the "ads" A record in Cloudflare.
# Safe to re-run. If the Caddy config does not validate, the old one is put back.
set -euo pipefail

HOST=root@187.126.125.145
KEY=~/.ssh/creativheads_vps
OLD=ads.creativheads.com
NEW=pulse.creativheads.com
CADDYFILE=/opt/casting-manager/deploy/vps/Caddyfile
SSH="ssh -i $KEY -o BatchMode=yes $HOST"

echo "==> Removing $OLD from Caddy"
$SSH "set -e
if ! grep -q '^$OLD ' $CADDYFILE; then echo '$OLD is already gone from Caddy'; exit 0; fi
cp $CADDYFILE $CADDYFILE.bak-remove-ads
tmp=\$(mktemp)
awk -v old='$OLD' '
  skip && /^}/ { skip = 0; next }
  skip { next }
  \$1 == old { skip = 1; next }
  { print }
' $CADDYFILE > \$tmp
cat \$tmp > $CADDYFILE   # same file, so the container bind mount keeps working
rm -f \$tmp
if ! docker exec casting-manager-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  cat $CADDYFILE.bak-remove-ads > $CADDYFILE
  echo 'Caddy config invalid, change reverted' >&2
  exit 1
fi
docker exec casting-manager-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
echo 'Caddy updated'"

echo "==> Checking $NEW still answers"
curl -fsS -o /dev/null "https://$NEW/login" && echo "$NEW ok"
echo "Done. Now delete the 'ads' A record in Cloudflare (creativheads.com -> DNS -> Records)."
