#!/usr/bin/env bash
# Gate 2: Real Docker 128 MiB cgroup build, two-step secret-file owner init,
# staging gate, live backup, and >15 MiB streaming restore verification.
# Runs strictly on synthetic local containers/volumes; NEVER touches production or external APIs.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker CLI is not installed on this machine." >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="mavi-erp:gate-128m-check"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mavi-docker-gate-XXXXXX")"
VOL_STAGING="${WORK_DIR}/vol-staging"
VOL_RESTORE="${WORK_DIR}/vol-restore"
SECRET_FILE="${WORK_DIR}/owner-init.secret"
RESTORE_SECRET_ENV="${WORK_DIR}/restore.env"
CONT_STAGING="mavi-gate-staging-$$"
CONT_RESTORE="mavi-gate-restore-$$"
PORT_STAGING="${MAVI_GATE_PORT_STAGING:-3310}"
PORT_RESTORE="${MAVI_GATE_PORT_RESTORE:-3311}"

cleanup() {
  docker rm -f "${CONT_STAGING}" "${CONT_RESTORE}" >/dev/null 2>&1 || true
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

mkdir -p "${VOL_STAGING}" "${VOL_RESTORE}"
chmod 0700 "${WORK_DIR}"

echo "[1/6] Building production Docker image (${IMAGE_TAG})..."
docker build -t "${IMAGE_TAG}" "${ROOT_DIR}"

echo "[2/6] Generating synthetic ephemeral bootstrap secret (mode 0600, never placed in shell args)..."
umask 077
SYNTH_PW="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
SYNTH_PW="Gate!${SYNTH_PW}"
printf "%s\n" "${SYNTH_PW}" > "${SECRET_FILE}"

echo "[3/6] Running one-shot owner initialization (MAVI_INIT_OWNER_ONLY=1) under 128 MiB cap..."
docker run --rm \
  --memory=128m --memory-swap=128m \
  -v "${VOL_STAGING}:/data" \
  -v "${SECRET_FILE}:/run/secrets/owner_pw:ro" \
  -e NODE_ENV=production \
  -e AUTO_SEED=0 \
  -e MAVI_INIT_OWNER_ONLY=1 \
  -e INITIAL_ADMIN_EMAIL="gate-owner@mavi.example" \
  -e INITIAL_ADMIN_PASSWORD_FILE="/run/secrets/owner_pw" \
  "${IMAGE_TAG}"

rm -f "${SECRET_FILE}"

echo "[4/6] Starting long-lived staging container (${CONT_STAGING}) under --memory=128m --memory-swap=128m..."
docker run -d \
  --name "${CONT_STAGING}" \
  --memory=128m --memory-swap=128m \
  -p "127.0.0.1:${PORT_STAGING}:3000" \
  -v "${VOL_STAGING}:/data" \
  -e NODE_ENV=production \
  -e MAVI_STAGING_MODE=1 \
  -e AUTO_SEED=0 \
  -e SHOW_OTP=0 \
  "${IMAGE_TAG}" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT_STAGING}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:${PORT_STAGING}/healthz" >/dev/null

# Verify container PID 1 environment has zero bootstrap password
if docker exec "${CONT_STAGING}" sh -c "tr '\0' '\n' < /proc/1/environ | grep -q '^INITIAL_ADMIN_PASSWORD'"; then
  echo "FAIL: INITIAL_ADMIN_PASSWORD leaked into container PID 1 environ" >&2
  exit 1
fi

# Verify unauthenticated staging gate returns 401 on /store/
STORE_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' "http://127.0.0.1:${PORT_STAGING}/store/")"
if [ "${STORE_CODE}" != "401" ]; then
  echo "FAIL: Expected 401 on unauthenticated /store/ in staging, got ${STORE_CODE}" >&2
  exit 1
fi

echo "[5/6] Exercising authenticated login, >15 MiB SQLite padding, and live online backup inside 128 MiB cgroup..."
TOKEN="$(
  SYNTH_PW_IN="${SYNTH_PW}" python3 - "${PORT_STAGING}" <<'PY'
import json, os, sys, urllib.request
port = sys.argv[1]
pw = os.environ["SYNTH_PW_IN"]
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/admin/auth/login",
    data=json.dumps({"email": "gate-owner@mavi.example", "password": pw}).encode(),
    headers={"Content-Type": "application/json", "Origin": f"https://127.0.0.1:{port}", "X-Forwarded-Proto": "https"},
    method="POST",
)
with urllib.request.urlopen(req) as resp:
    assert resp.status == 200
    print(json.loads(resp.read().decode())["token"])
PY
)"
unset SYNTH_PW

# Pad synthetic style images inside the container's /data/mavi.db to >15 MiB so backup & restore stress 128 MiB cgroup
docker exec "${CONT_STAGING}" node -e "
const Database = require('better-sqlite3');
const db = new Database('/data/mavi.db');
db.prepare(\"INSERT OR IGNORE INTO styles(id,name,type,price,cost,active,lead_days) VALUES('DR-GATE','فستان اختبار','made',2000,900,1,7)\").run();
const buf = Buffer.alloc(4 * 1024 * 1024, 0x42);
const ins = db.prepare('INSERT INTO style_images(style_id,image,image_type,is_primary) VALUES(?,?,?,?)');
for (let i = 0; i < 4; i++) ins.run('DR-GATE', buf, 'image/webp', i === 0 ? 1 : 0);
db.close();
"

BACKUP_FILE="${WORK_DIR}/live-backup.db"
BACKUP_HEADERS="${WORK_DIR}/backup.headers"
curl -fsS -D "${BACKUP_HEADERS}" -H "Authorization: Bearer ${TOKEN}" \
  "http://127.0.0.1:${PORT_STAGING}/api/admin/system/backup" -o "${BACKUP_FILE}"

EXPECTED_SHA="$(awk 'tolower($1)=="x-mavi-backup-sha256:" {gsub(/\r/,"",$2); print $2}' "${BACKUP_HEADERS}")"
ACTUAL_SHA="$(sha256sum "${BACKUP_FILE}" | awk '{print $1}')"
if [ -z "${EXPECTED_SHA}" ] || [ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]; then
  echo "FAIL: Backup SHA-256 mismatch (${EXPECTED_SHA} vs ${ACTUAL_SHA})" >&2
  exit 1
fi

OOM_STAGING="$(docker inspect -f '{{.State.OOMKilled}}' "${CONT_STAGING}")"
STATS_STAGING="$(docker stats --no-stream --format '{{.MemUsage}} (perc={{.MemPerc}})' "${CONT_STAGING}")"
echo "  Staging container OOMKilled=${OOM_STAGING}, MemUsage=${STATS_STAGING}"
if [ "${OOM_STAGING}" != "false" ]; then
  echo "FAIL: Staging container hit OOM!" >&2
  exit 1
fi

echo "[6/6] Testing >15 MiB streaming restore container (${CONT_RESTORE}) under --memory=128m --memory-swap=128m..."
RESTORE_SECRET="RestoreGate-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28)"
printf "MAVI_RESTORE_MODE=1\nMAVI_RESTORE_SECRET=%s\nMAVI_RESTORE_TARGET_NAME=mavi-gate-restored.db\n" "${RESTORE_SECRET}" > "${RESTORE_SECRET_ENV}"

docker run -d \
  --name "${CONT_RESTORE}" \
  --memory=128m --memory-swap=128m \
  -p "127.0.0.1:${PORT_RESTORE}:3000" \
  -v "${VOL_RESTORE}:/data" \
  --env-file "${RESTORE_SECRET_ENV}" \
  "${IMAGE_TAG}" >/dev/null
rm -f "${RESTORE_SECRET_ENV}"

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT_RESTORE}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

IMPORT_RES="$(curl -fsS -H "Authorization: Bearer ${RESTORE_SECRET}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${BACKUP_FILE}" \
  "http://127.0.0.1:${PORT_RESTORE}/import")"
unset RESTORE_SECRET

if [ "${IMPORT_RES}" != "ok" ]; then
  echo "FAIL: Streaming restore returned '${IMPORT_RES}'" >&2
  exit 1
fi

OOM_RESTORE="$(docker inspect -f '{{.State.OOMKilled}}' "${CONT_RESTORE}")"
STATS_RESTORE="$(docker stats --no-stream --format '{{.MemUsage}} (perc={{.MemPerc}})' "${CONT_RESTORE}")"
echo "  Restore container OOMKilled=${OOM_RESTORE}, MemUsage=${STATS_RESTORE}"
if [ "${OOM_RESTORE}" != "false" ]; then
  echo "FAIL: Restore container hit OOM!" >&2
  exit 1
fi

RESTORED_SHA="$(sha256sum "${VOL_RESTORE}/mavi-gate-restored.db" | awk '{print $1}')"
if [ "${RESTORED_SHA}" != "${ACTUAL_SHA}" ]; then
  echo "FAIL: Restored file SHA-256 mismatch!" >&2
  exit 1
fi

echo "✓ ALL DOCKER 128 MiB CGROUP GATES PASSED."
