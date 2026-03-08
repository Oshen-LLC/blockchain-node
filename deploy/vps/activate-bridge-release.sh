#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_PATH="${1:?artifact path required}"
RELEASE_ID="${2:?release id required}"
DEPLOY_BASE_DIR="${DEPLOY_BASE_DIR:-/opt/ndts}"
COMPONENT="bridge"
RELEASES_DIR="${DEPLOY_BASE_DIR}/releases/${COMPONENT}"
RELEASE_DIR="${RELEASES_DIR}/${RELEASE_ID}"
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

legacy_alias() {
  local target="$1"
  case "$target" in
    "${DEPLOY_BASE_DIR}"/releases/*/bridge)
      local legacy_id
      legacy_id="$(basename "$(dirname "$target")")"
      mkdir -p "$RELEASES_DIR"
      ln -sfn "$target" "${RELEASES_DIR}/legacy-${legacy_id}"
      ;;
  esac
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

wait_for_bridge() {
  local attempts="${1:-15}"
  local sleep_seconds="${2:-2}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl --fail --silent --show-error http://127.0.0.1:4000/health >/dev/null; then
      return 0
    fi
    sleep "$sleep_seconds"
  done
  return 1
}

rollback_to() {
  local target="$1"
  if [ -n "$target" ]; then
    ln -sfn "$target" "$CURRENT_LINK"
    load_env_file "$ENV_FILE"
    restart_pm2
  fi
}

sudo test -f "$ENV_FILE"
[ -f "$ARTIFACT_PATH" ]
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 "$RELEASES_DIR" "${DEPLOY_BASE_DIR}/current"
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 /var/log/ndts

previous_target="$(readlink -f "$CURRENT_LINK" || true)"
legacy_alias "$previous_target"

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
tar -xzf "$ARTIFACT_PATH" -C "$RELEASE_DIR"
[ -f "$RELEASE_DIR/dist/index.js" ]
[ -f "$RELEASE_DIR/ecosystem.config.cjs" ]
[ -d "$RELEASE_DIR/node_modules" ]
[ -f "$RELEASE_DIR/release.json" ]

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
load_env_file "$ENV_FILE"
restart_pm2

if ! wait_for_bridge; then
  rollback_to "$previous_target"
  echo "bridge health check failed; rolled back to previous release" >&2
  exit 1
fi

echo "bridge release ${RELEASE_ID} activated"
