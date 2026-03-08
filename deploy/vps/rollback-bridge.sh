#!/usr/bin/env bash
set -euo pipefail

TARGET_RELEASE_ID="${1:-}"
DEPLOY_BASE_DIR="${DEPLOY_BASE_DIR:-/opt/ndts}"
COMPONENT="bridge"
RELEASES_DIR="${DEPLOY_BASE_DIR}/releases/${COMPONENT}"
CURRENT_LINK="${DEPLOY_BASE_DIR}/current/${COMPONENT}"
ENV_FILE="/etc/ndts/bridge.env"
PM2_APP_NAME="ndts-bridge"

load_env_file() {
  local file_path="$1"
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    export "$line"
  done < <(sudo cat "$file_path")
}

pick_previous_target() {
  python3 - "$RELEASES_DIR" "$CURRENT_LINK" <<'PY'
import os, sys
releases_dir, current_link = sys.argv[1], sys.argv[2]
current = os.path.realpath(current_link) if os.path.islink(current_link) else ''
entries = []
if os.path.isdir(releases_dir):
    for name in os.listdir(releases_dir):
        path = os.path.join(releases_dir, name)
        if os.path.realpath(path) == current:
            continue
        entries.append((os.path.getmtime(path), path))
entries.sort(reverse=True)
print(entries[0][1] if entries else '')
PY
}

restart_pm2() {
  export BRIDGE_CWD="$CURRENT_LINK"
  export PM2_OUT_FILE="/var/log/ndts/bridge-out.log"
  export PM2_ERROR_FILE="/var/log/ndts/bridge-error.log"
  if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    pm2 startOrReload "$CURRENT_LINK/ecosystem.config.cjs" --only "$PM2_APP_NAME" --update-env
  else
    pm2 start "$CURRENT_LINK/ecosystem.config.cjs" --only "$PM2_APP_NAME" --update-env
  fi
  pm2 save >/dev/null
}

sudo test -f "$ENV_FILE"
current_target="$(readlink -f "$CURRENT_LINK" || true)"
[ -n "$current_target" ] || { echo "no active bridge release" >&2; exit 1; }

if [ -n "$TARGET_RELEASE_ID" ]; then
  target_path="${RELEASES_DIR}/${TARGET_RELEASE_ID}"
  if [ ! -e "$target_path" ] && [ -e "${RELEASES_DIR}/legacy-${TARGET_RELEASE_ID}" ]; then
    target_path="${RELEASES_DIR}/legacy-${TARGET_RELEASE_ID}"
  fi
  [ -e "$target_path" ] || { echo "rollback target not found: $TARGET_RELEASE_ID" >&2; exit 1; }
else
  target_path="$(pick_previous_target)"
  [ -n "$target_path" ] || { echo "no previous bridge release available" >&2; exit 1; }
fi

ln -sfn "$target_path" "$CURRENT_LINK"
load_env_file "$ENV_FILE"
restart_pm2

if ! curl --fail --silent --show-error http://127.0.0.1:4000/health >/dev/null; then
  ln -sfn "$current_target" "$CURRENT_LINK"
  load_env_file "$ENV_FILE"
  restart_pm2
  echo "bridge rollback failed; restored current release" >&2
  exit 1
fi

echo "bridge rolled back to $(basename "$target_path")"
