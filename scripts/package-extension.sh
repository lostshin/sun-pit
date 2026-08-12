#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERSION="$(node -e "const fs = require('node:fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).version)" "${PROJECT_ROOT}/manifest.json")"
OUTPUT_DIR="${PROJECT_ROOT}/dist"
ARCHIVE="${OUTPUT_DIR}/social-post-to-obsidian-v${VERSION}.zip"
HELPER_ARCHIVE="${OUTPUT_DIR}/social-post-to-obsidian-helper-v${VERSION}-macos.zip"
CHECKSUMS="${OUTPUT_DIR}/SHA256SUMS"
STAGE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/sp2o-package.XXXXXX")"
STAGE_DIR="${STAGE_ROOT}/extension"
HELPER_STAGE_DIR="${STAGE_ROOT}/helper"

cleanup() {
  rm -rf "${STAGE_ROOT}"
}
trap cleanup EXIT

node "${PROJECT_ROOT}/scripts/validate-extension.mjs"

mkdir -p "${OUTPUT_DIR}" "${STAGE_DIR}/content" "${STAGE_DIR}/icons" "${STAGE_DIR}/native" "${STAGE_DIR}/popup" "${STAGE_DIR}/providers" "${STAGE_DIR}/shared" "${HELPER_STAGE_DIR}/native"
cp "${PROJECT_ROOT}/manifest.json" "${PROJECT_ROOT}/background.js" "${PROJECT_ROOT}/INSTALL.md" "${PROJECT_ROOT}/LICENSE" "${STAGE_DIR}/"
cp "${PROJECT_ROOT}"/shared/*.js "${STAGE_DIR}/shared/"
cp "${PROJECT_ROOT}"/content/*.js "${STAGE_DIR}/content/"
cp "${PROJECT_ROOT}"/icons/* "${STAGE_DIR}/icons/"
cp "${PROJECT_ROOT}"/native/* "${STAGE_DIR}/native/"
cp "${PROJECT_ROOT}"/popup/* "${STAGE_DIR}/popup/"
cp "${PROJECT_ROOT}"/providers/*.js "${STAGE_DIR}/providers/"
cp "${PROJECT_ROOT}/INSTALL.md" "${PROJECT_ROOT}/LICENSE" "${HELPER_STAGE_DIR}/"
cp "${PROJECT_ROOT}"/native/* "${HELPER_STAGE_DIR}/native/"

rm -f "${ARCHIVE}" "${HELPER_ARCHIVE}" "${CHECKSUMS}"
pushd "${STAGE_DIR}" >/dev/null
zip -q -r "${ARCHIVE}" . -x '*.DS_Store'
popd >/dev/null
pushd "${HELPER_STAGE_DIR}" >/dev/null
zip -q -r "${HELPER_ARCHIVE}" . -x '*.DS_Store'
popd >/dev/null

unzip -tq "${ARCHIVE}"
unzip -tq "${HELPER_ARCHIVE}"
PACKAGE_FILES="$(unzip -Z1 "${ARCHIVE}")"
for required_file in manifest.json INSTALL.md shared/settings.js providers/base.js providers/markdown-folder.js providers/obsidian-rest.js providers/apple-notes.js native/host.rb native/install-host.sh native/uninstall-host.sh; do
  if ! grep -q "^${required_file}$" <<<"${PACKAGE_FILES}"; then
    echo "Packaging failed: ${required_file} is missing" >&2
    exit 1
  fi
done
for forbidden_file in AGENTS.md CLAUDE.md tests/media-sync.test.mjs .github/workflows/validate.yml; do
  if grep -q "^${forbidden_file}$" <<<"${PACKAGE_FILES}"; then
    echo "Packaging failed: development file ${forbidden_file} must not be included" >&2
    exit 1
  fi
done

HELPER_FILES="$(unzip -Z1 "${HELPER_ARCHIVE}")"
for required_file in INSTALL.md LICENSE native/host.rb native/install-host.sh native/uninstall-host.sh; do
  if ! grep -q "^${required_file}$" <<<"${HELPER_FILES}"; then
    echo "Helper packaging failed: ${required_file} is missing" >&2
    exit 1
  fi
done

node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const { basename } = require("node:path");
  for (const file of process.argv.slice(1)) {
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    console.log(`${hash}  ${basename(file)}`);
  }
' "${ARCHIVE}" "${HELPER_ARCHIVE}" > "${CHECKSUMS}"

echo "Created ${ARCHIVE}"
echo "Created ${HELPER_ARCHIVE}"
echo "Created ${CHECKSUMS}"
