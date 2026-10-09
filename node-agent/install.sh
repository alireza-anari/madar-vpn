#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMMAND="${1:-install}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

case "${COMMAND}" in
  install)
    echo "Madar will install its node-agent files and a systemd service."
    echo "The issued node credential will be stored with owner-only permissions."
    echo "This installer will not modify SSH or firewall configuration."
    IFS= read -r -s -p "One-time enrollment token: " token
    echo
    python3 "${SCRIPT_DIR}/installer_cli.py" install 3<<<"${token}"
    unset token
    ;;
  status)
    python3 "${SCRIPT_DIR}/installer_cli.py" status
    ;;
  observe)
    python3 "${SCRIPT_DIR}/installer_cli.py" observe
    ;;
  update)
    python3 "${SCRIPT_DIR}/installer_cli.py" update
    ;;
  remove)
    python3 "${SCRIPT_DIR}/installer_cli.py" remove
    ;;
  *)
    echo "Usage: $0 {install|status|observe|update|remove}" >&2
    exit 2
    ;;
esac
