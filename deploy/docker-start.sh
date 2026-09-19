#!/usr/bin/env bash
set -euo pipefail
cd /app
mkdir -p /app/data
./target/release/enclave-host &
for _ in $(seq 1 40); do
  if curl -sf http://127.0.0.1:17891/v1/health >/dev/null; then
    break
  fi
  sleep 0.25
done
exec node scripts/with-app-env.mjs vite --host 0.0.0.0 --port 8080
