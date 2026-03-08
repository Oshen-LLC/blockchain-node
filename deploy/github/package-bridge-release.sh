#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/.release}"
RELEASE_ID="${RELEASE_ID:?RELEASE_ID is required}"
REPO_NAME="${REPO_NAME:-blockchain-node}"
COMMIT_SHA="${COMMIT_SHA:-${GITHUB_SHA:-unknown}}"
BRANCH_NAME="${BRANCH_NAME:-${GITHUB_REF_NAME:-unknown}}"
WORKFLOW_RUN_ID="${WORKFLOW_RUN_ID:-${GITHUB_RUN_ID:-unknown}}"
ACTOR_NAME="${ACTOR_NAME:-${GITHUB_ACTOR:-unknown}}"

ARTIFACT_DIR="${OUTPUT_DIR}/bridge-${RELEASE_ID}"
ARTIFACT_PATH="${OUTPUT_DIR}/bridge-${RELEASE_ID}.tar.gz"

rm -rf "${ARTIFACT_DIR}" "${ARTIFACT_PATH}"
mkdir -p "${ARTIFACT_DIR}" "${OUTPUT_DIR}"

cd "${ROOT_DIR}"
npm ci
npm run build
npm prune --omit=dev

cp package.json package-lock.json ecosystem.config.cjs "${ARTIFACT_DIR}/"
mkdir -p "${ARTIFACT_DIR}/scripts"
cp -R dist "${ARTIFACT_DIR}/"
cp scripts/healthcheck.mjs "${ARTIFACT_DIR}/scripts/"
cp -R node_modules "${ARTIFACT_DIR}/node_modules"
cat > "${ARTIFACT_DIR}/release.json" <<MANIFEST
{
  "repo": "${REPO_NAME}",
  "component": "bridge",
  "releaseId": "${RELEASE_ID}",
  "commit": "${COMMIT_SHA}",
  "branch": "${BRANCH_NAME}",
  "workflowRunId": "${WORKFLOW_RUN_ID}",
  "actor": "${ACTOR_NAME}",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
MANIFEST

tar -C "${ARTIFACT_DIR}" -czf "${ARTIFACT_PATH}" .
printf '%s\n' "${ARTIFACT_PATH}"
