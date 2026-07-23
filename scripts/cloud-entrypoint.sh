#!/bin/sh
set -eu

profile_root="$(find /opt/bambu-studio -type d -path '*/profiles/BBL' -print -quit)"
if [ -z "${profile_root}" ]; then
  echo "The pinned Bambu Studio image does not contain its BBL profiles." >&2
  exit 1
fi

catalog_path="/work/profile-catalog.json"
sed "s|__PROFILE_ROOT__|${profile_root}|g" /app/slicer-worker/profile-catalog.cloud.json > "${catalog_path}"

exec xvfb-run -a -s "-screen 0 1280x1024x24 -nolisten tcp" \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
  /app/scripts/slicer-worker-remote.mts \
  --engine /opt/bambu-studio/AppRun \
  --catalog "${catalog_path}" \
  --work-root /work/jobs \
  --worker-id "${SLICER_WORKER_ID:-cloud-worker-1}" \
  --poll-ms "${SLICER_WORKER_POLL_MS:-10000}" \
  --watch
