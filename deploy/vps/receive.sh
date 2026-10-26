#!/bin/sh
# Installed on the VPS as /usr/local/bin/ad-reports-receive by setup-auto-deploy.sh.
# It is the only command the GitHub Actions deploy key may run (forced in authorized_keys).
# Reads a tar of the app files on stdin (package.json, *.js, public/), swaps them into
# /opt/ad-reports and rebuilds the container. Docker, Caddy and .env are never taken from
# the upload, so a push can change the app but not the server setup.
set -eu
APP=${AD_REPORTS_DIR:-/opt/ad-reports}   # override only for local tests
DOMAIN=ads.creativheads.com
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

head -c 50000000 | tar xf - -C "$STAGE" --no-same-owner --no-same-permissions
if [ -n "$(find "$STAGE" -type l -o -type b -o -type c -o -type p)" ]; then
  echo "refused: the upload contains links or special files" >&2
  exit 1
fi
for f in package.json server.js public; do
  [ -e "$STAGE/$f" ] || { echo "refused: $f is missing from the upload" >&2; exit 1; }
done

rsync -r --delete "$STAGE/public/" "$APP/public/"
cp "$STAGE"/package.json "$STAGE"/*.js "$APP/"

cd "$APP/deploy/vps"
docker compose up -d --build 2>&1 | tail -4

# A casting-manager redeploy can leave Caddy reading an old Caddyfile (see deploy.sh).
if ! docker exec casting-manager-caddy-1 grep -q "^$DOMAIN " /etc/caddy/Caddyfile; then
  if grep -q "^$DOMAIN " /opt/casting-manager/deploy/vps/Caddyfile; then
    docker restart casting-manager-caddy-1 >/dev/null
    echo "Caddy restarted to pick up its current Caddyfile"
  else
    echo "warning: Caddy has no $DOMAIN block; run deploy/vps/deploy.sh once" >&2
  fi
fi
echo "deployed to $DOMAIN"
