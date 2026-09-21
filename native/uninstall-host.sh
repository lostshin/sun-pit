#!/bin/zsh

set -euo pipefail

if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then
  print -u2 "The Native Helper uninstaller currently supports macOS only."
  exit 1
fi

purge_config=false
case "${1:-}" in
  '') ;;
  --purge) purge_config=true ;;
  *)
    print -u2 "Usage: ./native/uninstall-host.sh [--purge]"
    exit 1
    ;;
esac

app_dir="${HOME}/Library/Application Support/sun-pit"
manifest_path="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.lostshin.sun_pit.json"
host_path="${app_dir}/host.rb"
config_path="${app_dir}/config.json"

/bin/rm -f "${manifest_path}" "${host_path}"
if [[ "${purge_config}" == true ]]; then
  /bin/rm -f "${config_path}"
fi
/bin/rmdir "${app_dir}" 2>/dev/null || true

print "Removed the sun-pit Native Helper.\n"
if [[ "${purge_config}" == false && -f "${config_path}" ]]; then
  print "Kept Vault configuration: ${config_path}\n"
fi
