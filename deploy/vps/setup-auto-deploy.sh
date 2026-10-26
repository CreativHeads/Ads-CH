#!/usr/bin/env bash
# One-time setup so every push to GitHub goes live at ads.creativheads.com.
# Run from hostinger-web in Git Bash:  bash deploy/vps/setup-auto-deploy.sh
#   1. creates a separate SSH key for GitHub Actions (on this PC)
#   2. installs the receiver on the VPS and lets that key run only the receiver
#   3. deploys the current code once (so the server has the latest Dockerfile)
#   4. copies the private key to your clipboard for the GitHub secret
set -euo pipefail

HOST=root@187.126.125.145
KEY=~/.ssh/creativheads_vps
DEPLOY_KEY=~/.ssh/ad_reports_github_deploy
SSH="ssh -i $KEY -o BatchMode=yes $HOST"

cd "$(dirname "$0")/../.."

if [ ! -f "$DEPLOY_KEY" ]; then
  echo "==> Creating the GitHub deploy key ($DEPLOY_KEY)"
  ssh-keygen -q -t ed25519 -N "" -C "github-actions-ad-reports" -f "$DEPLOY_KEY"
fi

echo "==> Installing the receiver on the VPS"
$SSH 'cat > /usr/local/bin/ad-reports-receive && chmod 755 /usr/local/bin/ad-reports-receive' < deploy/vps/receive.sh

echo "==> Allowing the deploy key to run only the receiver"
PUB=$(cat "$DEPLOY_KEY.pub")
$SSH "grep -qF '$PUB' ~/.ssh/authorized_keys || echo 'restrict,command=\"/usr/local/bin/ad-reports-receive\" $PUB' >> ~/.ssh/authorized_keys"

echo "==> Deploying the current code once"
bash deploy/vps/deploy.sh

echo "==> Testing the deploy key"
tar cf - package.json *.js public | ssh -i "$DEPLOY_KEY" -o BatchMode=yes $HOST

if command -v clip.exe >/dev/null 2>&1; then
  clip.exe < "$DEPLOY_KEY"
  COPIED="It is already copied to your clipboard."
else
  COPIED="Copy it from: $DEPLOY_KEY"
fi
cat <<EOF

Last step, in your browser:
  1. Open https://github.com/CreativHeads/Ads-CH/settings/secrets/actions/new
  2. Name:   VPS_DEPLOY_KEY
     Secret: paste the private key. $COPIED
  3. Click "Add secret".
After that, every push to main goes live at https://ads.creativheads.com
(watch it under the repo's Actions tab).
EOF
