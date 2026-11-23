#!/bin/bash
# Update the server copy of the dashboard: check its .env first, then pull
# GitHub main and restart. Stops if a setting is missing, unless --fix-env.
#   scripts/deploy-server.sh            → stop if the server lacks a setting
#   scripts/deploy-server.sh --fix-env  → copy missing settings, then deploy
set -e
cd "$(dirname "$0")/.."
if [ "$1" = "--fix-env" ]; then node scripts/check-server-env.mjs --fix; else node scripts/check-server-env.mjs; fi
ssh -o BatchMode=yes tasaki@192.168.10.10 'cd /mnt/newdisk/www/Marketking-Dashboard && git pull --ff-only origin main && pm2 restart Marketking-Dashboard --update-env >/dev/null && sleep 4 && pm2 ls | grep Marketking-Dashboard'
echo "Calendar sync status on server:"
ssh -o BatchMode=yes tasaki@192.168.10.10 'P=$(grep -E "^PORT=" /mnt/newdisk/www/Marketking-Dashboard/.env | cut -d= -f2 | tr -d "\" "); curl -s "http://localhost:${P:-5050}/api/health/sync"'
echo
