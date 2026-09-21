#!/bin/zsh

set -euo pipefail

if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then
  print -u2 "The Native Helper installer currently supports macOS only."
  exit 1
fi
if [[ ! -x /usr/bin/ruby ]]; then
  print -u2 "The Native Helper requires /usr/bin/ruby. Use Local REST API mode on this Mac instead."
  exit 1
fi

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
store_extension_id="jdfempgjnmdlokacfjmnipihhghcnomb"
extension_id="${1:-}"

if [[ -z "${extension_id}" ]]; then
  extension_id="$(/usr/bin/ruby -rdigest -e '
    digest = Digest::SHA256.hexdigest(File.expand_path(ARGV.fetch(0)))[0, 32]
    puts digest.tr("0-9a-f", "a-p")
  ' "${project_dir}")"
fi

if [[ ! "${extension_id}" =~ '^[a-p]{32}$' ]]; then
  print -u2 "Invalid Chrome extension ID: ${extension_id}"
  exit 1
fi

extension_ids=("${store_extension_id}")
if [[ "${extension_id}" != "${store_extension_id}" ]]; then
  extension_ids+=("${extension_id}")
fi

app_dir="${HOME}/Library/Application Support/sun-pit"
manifest_dir="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
host_path="${app_dir}/host.rb"
manifest_path="${manifest_dir}/com.lostshin.sun_pit.json"

/bin/mkdir -p "${app_dir}" "${manifest_dir}"
/usr/bin/install -m 755 "${script_dir}/host.rb" "${host_path}"

# v1.8.0 起 Native Helper 可寫一般 Markdown 資料夾；保留原路徑並只轉換設定 key。
/usr/bin/ruby -rjson -e '
  path = ARGV.fetch(0)
  exit unless File.file?(path)
  config = JSON.parse(File.read(path))
  exit if config["folderPath"] || !config["vaultPath"]
  config["folderPath"] = config.delete("vaultPath")
  temporary = "#{path}.tmp-#{Process.pid}"
  File.write(temporary, JSON.pretty_generate(config))
  File.chmod(0o600, temporary)
  File.rename(temporary, path)
' "${app_dir}/config.json"

/usr/bin/ruby -rjson -e '
  manifest_path, host_path, *extension_ids = ARGV
  manifest = {
    name: "com.lostshin.sun_pit",
    description: "Local note writer for sun-pit",
    path: host_path,
    type: "stdio",
    allowed_origins: extension_ids.map { |id| "chrome-extension://#{id}/" }
  }
  File.write(manifest_path, JSON.pretty_generate(manifest) + "\n")
' "${manifest_path}" "${host_path}" "${extension_ids[@]}"

print "Installed native host for extensions ${(j:, :)extension_ids}\n"
print "Manifest: ${manifest_path}\n"
print "Reload the extension in chrome://extensions before testing.\n"
