#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <tag> <extension-asset.zip> [owner/repo]" >&2
  exit 64
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ $# -ge 2 && $# -le 3 ]] || usage

release_tag=$1
asset_name=$2
repository=${3:-}

[[ -n "$release_tag" ]] || fail "tag must not be empty"
[[ "$asset_name" == "$(basename "$asset_name")" ]] || fail "asset must be an exact basename"
[[ "$asset_name" == *.zip ]] || fail "asset must be a .zip file"
asset_name_lower=$(printf '%s' "$asset_name" | tr '[:upper:]' '[:lower:]')
[[ ! "$asset_name_lower" =~ (helper|native-host|installer) ]] || \
  fail "refusing a Helper, Native Host, or installer asset: $asset_name"

for required_command in gh shasum unzip node awk mktemp; do
  command -v "$required_command" >/dev/null 2>&1 || fail "missing command: $required_command"
done

if [[ -n "$repository" ]]; then
  release_state=$(gh release view "$release_tag" --repo "$repository" \
    --json tagName,isDraft,isPrerelease \
    --template '{{.tagName}}|{{.isDraft}}|{{.isPrerelease}}')
else
  release_state=$(gh release view "$release_tag" \
    --json tagName,isDraft,isPrerelease \
    --template '{{.tagName}}|{{.isDraft}}|{{.isPrerelease}}')
fi

IFS='|' read -r returned_tag is_draft is_prerelease <<<"$release_state"
[[ "$returned_tag" == "$release_tag" ]] || fail "release tag mismatch: $returned_tag"
[[ "$is_draft" == "false" ]] || fail "release is still a draft"
[[ "$is_prerelease" == "false" ]] || fail "release is marked as a prerelease"

temp_root=${TMPDIR:-/tmp}
download_dir=$(mktemp -d "${temp_root%/}/cws-release.XXXXXX")
completed=false
cleanup_on_failure() {
  if [[ "$completed" != true ]]; then
    rm -rf -- "$download_dir"
  fi
}
trap cleanup_on_failure EXIT

if [[ -n "$repository" ]]; then
  gh release download "$release_tag" --repo "$repository" \
    --pattern "$asset_name" \
    --pattern SHA256SUMS \
    --dir "$download_dir"
else
  gh release download "$release_tag" \
    --pattern "$asset_name" \
    --pattern SHA256SUMS \
    --dir "$download_dir"
fi

asset_path="$download_dir/$asset_name"
checksum_path="$download_dir/SHA256SUMS"
[[ -f "$asset_path" ]] || fail "Release asset was not downloaded: $asset_name"
[[ -f "$checksum_path" ]] || fail "SHA256SUMS was not downloaded"

checksum_matches=$(awk -v target="$asset_name" '
  {
    filename = $2
    sub(/^\*/, "", filename)
    if (filename == target) print tolower($1)
  }
' "$checksum_path")

match_count=$(printf '%s\n' "$checksum_matches" | awk 'NF { count++ } END { print count + 0 }')
[[ "$match_count" -eq 1 ]] || fail "expected exactly one SHA256SUMS entry for $asset_name; found $match_count"

expected_sha=$checksum_matches
actual_sha=$(shasum -a 256 "$asset_path" | awk '{ print tolower($1) }')
[[ "$actual_sha" == "$expected_sha" ]] || fail "SHA-256 mismatch for $asset_name"

manifest_json=$(unzip -p "$asset_path" manifest.json) || fail "manifest.json is missing from ZIP root"
manifest_info=$(printf '%s' "$manifest_json" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    const manifest = JSON.parse(input);
    if (typeof manifest.version !== "string") throw new Error("manifest.version is missing");
    if (manifest.manifest_version !== 3) throw new Error("manifest_version is not 3");
    process.stdout.write(`${manifest.version}|${manifest.manifest_version}`);
  });
')

IFS='|' read -r manifest_version manifest_schema <<<"$manifest_info"
expected_version=${release_tag#v}
[[ "$manifest_version" == "$expected_version" ]] || \
  fail "manifest version $manifest_version does not match tag $release_tag"

file_count=$(unzip -Z1 "$asset_path" | awk 'END { print NR }')
completed=true

printf 'VERIFIED_ASSET=%s\n' "$asset_path"
printf 'SHA256=%s\n' "$actual_sha"
printf 'VERSION=%s\n' "$manifest_version"
printf 'MANIFEST_VERSION=%s\n' "$manifest_schema"
printf 'FILE_COUNT=%s\n' "$file_count"
