from __future__ import annotations

import platform
from pathlib import Path


class SystemEnvironment:
    def __init__(self, os_release_path: Path = Path("/etc/os-release")) -> None:
        self._os_release_path = os_release_path

    def operating_system(self) -> tuple[str, str]:
        values: dict[str, str] = {}
        try:
            for line in self._os_release_path.read_text(encoding="utf-8").splitlines():
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                values[key] = value.strip().strip('"')
        except OSError:
            return "unknown", "unknown"
        return values.get("ID", "unknown").lower(), values.get("VERSION_ID", "unknown")

    def architecture(self) -> str:
        return platform.machine().lower()
