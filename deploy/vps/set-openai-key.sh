#!/usr/bin/env bash
# Store the OpenAI API key on the VPS (in /opt/ad-reports/deploy/vps/.env) and restart the app.
# Run from hostinger-web in Git Bash:  bash deploy/vps/set-openai-key.sh
# The key is typed here, is not shown on screen, and goes only to the server's .env.
set -euo pipefail

HOST=root@187.126.125.145
KEY=~/.ssh/creativheads_vps
ENV=/opt/ad-reports/deploy/vps/.env

read -rsp "Paste your OpenAI API key (starts with sk-), then press Enter: " OPENAI
echo
case "$OPENAI" in
  sk-*) ;;
  *) echo "That does not look like an OpenAI key (it should start with sk-). Nothing changed." >&2; exit 1 ;;
esac
read -rp "Model [gpt-4.1-mini]: " MODEL
MODEL=${MODEL:-gpt-4.1-mini}

echo "==> Checking the key with OpenAI"
code=$(curl -s -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI")
if [ "$code" != "200" ]; then
  echo "OpenAI rejected the key (HTTP $code). Nothing changed." >&2
  exit 1
fi

echo "==> Saving it on the VPS and restarting the app"
# The key travels over SSH stdin, never on a command line.
printf '%s\n%s\n' "$OPENAI" "$MODEL" | ssh -i $KEY -o BatchMode=yes $HOST "set -e
read -r key; read -r model
umask 077
grep -v -E '^(OPENAI_API_KEY|OPENAI_MODEL)=' $ENV > $ENV.new || true
printf 'OPENAI_API_KEY=%s\nOPENAI_MODEL=%s\n' \"\$key\" \"\$model\" >> $ENV.new
mv $ENV.new $ENV
cd /opt/ad-reports/deploy/vps && docker compose up -d --force-recreate app >/dev/null 2>&1
echo 'saved; app restarted'"
echo "Done. Open Insights in the app and click Write summary."
