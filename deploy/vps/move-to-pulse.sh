#!/usr/bin/env bash
# One-time move from ads.creativheads.com to pulse.creativheads.com.
# Run from hostinger-web in Git Bash, AFTER pulse.creativheads.com points at the VPS in DNS:
#   bash deploy/vps/move-to-pulse.sh
# - serves the app at pulse.creativheads.com (Caddy gets the HTTPS certificate itself)
# - turns ads.creativheads.com into a permanent redirect, so old links and bookmarks still work
# - points the auto-deploy receiver at the new domain
# Safe to re-run. If the Caddy config does not validate, the old one is put back.
set -euo pipefail

HOST=root@187.126.125.145
KEY=~/.ssh/creativheads_vps
OLD=ads.creativheads.com
NEW=pulse.creativheads.com
IP=187.126.125.145
CADDYFILE=/opt/casting-manager/deploy/vps/Caddyfile
SSH="ssh -i $KEY -o BatchMode=yes $HOST"

echo "==> Checking DNS for $NEW"
resolved=$(nslookup "$NEW" 8.8.8.8 2>/dev/null | awk '/^Address/ && !/#/ {print $2}' | tail -1)
if [ "$resolved" != "$IP" ]; then
  echo "$NEW resolves to '${resolved:-nothing}', not $IP." >&2
  echo "Add an A record for 'pulse' -> $IP in Cloudflare (DNS only, grey cloud), wait a few minutes, then run this again." >&2
  exit 1
fi

echo "==> Updating Caddy: serve $NEW, redirect $OLD"
$SSH "set -e
cp $CADDYFILE $CADDYFILE.bak-pulse
tmp=\$(mktemp)
# drop the old site block (from '$OLD {' to its closing '}') and any earlier $NEW block
awk -v old='$OLD' -v new='$NEW' '
  skip && /^}/ { skip = 0; next }
  skip { next }
  \$1 == old || \$1 == new { skip = 1; next }
  { print }
' $CADDYFILE > \$tmp
printf '\n$NEW {\n\tencode gzip\n\treverse_proxy ad-reports:3000\n}\n\n$OLD {\n\tredir https://$NEW{uri} permanent\n}\n' >> \$tmp
cat \$tmp > $CADDYFILE   # same file, so the container bind mount keeps working
rm -f \$tmp
if ! docker exec casting-manager-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  cat $CADDYFILE.bak-pulse > $CADDYFILE
  echo 'Caddy config invalid, change reverted' >&2
  exit 1
fi
if docker exec casting-manager-caddy-1 grep -q '^$NEW ' /etc/caddy/Caddyfile; then
  docker exec casting-manager-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
else
  docker restart casting-manager-caddy-1 >/dev/null
  sleep 3
fi
# the receiver checks Caddy for this domain after every push
sed -i 's/^DOMAIN=.*/DOMAIN=$NEW/' /usr/local/bin/ad-reports-receive
echo 'Caddy and receiver updated'"

echo "==> Waiting for the HTTPS certificate on $NEW"
for i in $(seq 1 24); do
  if curl -fsS -o /dev/null "https://$NEW/login"; then echo "HTTPS ok"; break; fi
  [ "$i" = 24 ] && { echo "$NEW is not answering over HTTPS yet; check the Cloudflare record is DNS only (grey cloud)." >&2; exit 1; }
  sleep 5
done

echo "==> Checking the redirect from $OLD"
curl -sS -o /dev/null -w "$OLD -> %{http_code} %{redirect_url}\n" "https://$OLD/login"
echo "Done: https://$NEW"
