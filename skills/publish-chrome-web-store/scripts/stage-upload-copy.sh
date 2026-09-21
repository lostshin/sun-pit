#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <verified-asset.zip> <existing-destination-dir> <expected-sha256> [new-name.zip]" >&2
  exit 64
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ $# -ge 3 && $# -le 4 ]] || usage

source_zip=$1
destination_dir=$2
expected_sha=$(printf '%s' "$3" | tr '[:upper:]' '[:lower:]')
destination_name=${4:-"$(basename "${source_zip%.zip}")-cws-upload.zip"}

[[ -f "$source_zip" ]] || fail "source ZIP does not exist: $source_zip"
[[ -d "$destination_dir" ]] || fail "destination directory does not exist: $destination_dir"
[[ "$destination_name" == "$(basename "$destination_name")" ]] || fail "destination name must be a basename"
[[ "$destination_name" == *.zip ]] || fail "destination name must end in .zip"
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || fail "expected SHA-256 must contain 64 hexadecimal characters"

for required_command in shasum awk cp; do
  command -v "$required_command" >/dev/null 2>&1 || fail "missing command: $required_command"
done

source_sha=$(shasum -a 256 "$source_zip" | awk '{ print tolower($1) }')
[[ "$source_sha" == "$expected_sha" ]] || fail "source ZIP does not match the expected SHA-256"

destination_path="${destination_dir%/}/$destination_name"
[[ ! -e "$destination_path" ]] || fail "refusing to overwrite: $destination_path"

created=false
cleanup_on_failure() {
  if [[ "$created" == true ]]; then
    rm -f -- "$destination_path"
  fi
}
trap cleanup_on_failure EXIT

cp -p -- "$source_zip" "$destination_path"
created=true

destination_sha=$(shasum -a 256 "$destination_path" | awk '{ print tolower($1) }')
[[ "$destination_sha" == "$expected_sha" ]] || fail "copied ZIP failed SHA-256 verification"

created=false
destination_directory=$(cd "$destination_dir" && pwd -P)
printf 'UPLOAD_FILE=%s/%s\n' "$destination_directory" "$destination_name"
printf 'SHA256=%s\n' "$destination_sha"
