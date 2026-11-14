"""Fixed-name, restricted systemd units for a disposable Madar V2 VPS only.

Root-owned 0600 configuration is provided to DynamicUser services via
systemd LoadCredential; never weaken file permissions for private Xray keys.
"""
import os
from os import geteuid as current_euid
import re
import stat
from pathlib import Path

from .installer import MARKER_TEXT, require_staging_marker
from .reconciler import ReconcileError, _atomic_file, _safe_config_root, subprocess_runner

UNITS=("madar-v2-xray.service","madar-v2-caddy.service")
SAFE_PATH=re.compile(r"^/[A-Za-z0-9._/-]+$")


def render_units(xray_path,caddy_path,config_dir):
    paths=(Path(xray_path),Path(caddy_path))
    if any(not SAFE_PATH.fullmatch(str(p)) or ".." in p.parts for p in paths):
        raise ReconcileError("unit executable paths require trusted absolute file names")
    if paths[0].name!="xray" or paths[1].name!="caddy":
        raise ReconcileError("wrong executable names")
    directory=Path(config_dir)
    if not SAFE_PATH.fullmatch(str(directory)) or ".." in directory.parts:
        raise ReconcileError("invalid configuration root")
    root=str(directory)
    preamble="""[Unit]
Description=Madar V2 disposable test node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077
Restart=on-failure
RestartSec=3s
TimeoutStopSec=10s
"""
    xray=preamble+f"""LoadCredential=config.json:{root}/config.json
ExecStart={paths[0]} run -config %d/config.json
StateDirectory=madar-v2-xray
ReadWritePaths=/var/lib/madar-v2-xray

[Install]
WantedBy=multi-user.target
"""
    caddy=preamble+f"""LoadCredential=Caddyfile:{root}/Caddyfile
ExecStart={paths[1]} run --config %d/Caddyfile --adapter caddyfile
Environment=XDG_DATA_HOME=/var/lib/madar-v2-caddy
Environment=XDG_CONFIG_HOME=/var/lib/madar-v2-caddy/config
StateDirectory=madar-v2-caddy
ReadWritePaths=/var/lib/madar-v2-caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
"""
    return dict(zip(UNITS,(xray,caddy)))


def install_staging_units(config_dir,*,unit_dir="/etc/systemd/system",
                          xray_path,caddy_path,runner=subprocess_runner):
    # Never install any system unit without explicit disposable marker.
    root=_safe_config_root(config_dir)
    require_staging_marker(root)
    if current_euid()!=0:
        raise ReconcileError("installing system units requires root")
    units=render_units(xray_path,caddy_path,root)
    dest=Path(unit_dir)
    if dest.is_symlink() or not dest.is_dir():
        raise ReconcileError("invalid systemd unit directory")
    created=[]
    for name in UNITS:
        file=dest/name
        if file.exists() or file.is_symlink():
            raise ReconcileError("staging service unit already exists; refuse overwrite")
    try:
        for name,body in units.items():
            staged=_atomic_file(dest,".madar-v2-unit-",body)
            os.chmod(staged,0o644)
            os.replace(staged,dest/name)
            created.append(dest/name)
        if not runner(["/usr/bin/systemctl","daemon-reload"],timeout=30):
            raise ReconcileError("systemd refused staging units")
    except BaseException:
        for path in created: path.unlink(missing_ok=True)
        runner(["/usr/bin/systemctl","daemon-reload"],timeout=30)
        raise
    return {"units_installed":list(UNITS),"services_started":False}
