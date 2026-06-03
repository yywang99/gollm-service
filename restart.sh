#!/usr/bin/env bash
# restart.sh — clean restart for gollm-service
# Uses pkill -9 directly to avoid systemctl stop hanging for 90+ seconds

set -e

echo "[restart] Killing existing node process..."
pkill -9 -f "node.*dist/server/http-server" 2>/dev/null || true
pkill -9 -f "chromium.*playwright" 2>/dev/null || true
sleep 2

echo "[restart] Resetting failed state (if any)..."
systemctl --user reset-failed gollm-service 2>/dev/null || true

echo "[restart] Starting gollm-service..."
systemctl --user start gollm-service

echo "[restart] Waiting for service to listen..."
for i in $(seq 1 15); do
  sleep 1
  if journalctl --user -u gollm-service -n 5 --no-pager 2>/dev/null | grep -q "Server listening"; then
    echo "[restart] ✅ gollm-service is up and listening."
    exit 0
  fi
done
echo "[restart] ❌ Service did not start within 15 seconds. Check: journalctl --user -u gollm-service -n 20"
exit 1
