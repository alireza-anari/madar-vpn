"""Install only the pinned V2 runtime from trusted runner tar over host-key-pinned SSH.

No dynamic URLs, pip, curl, OS firewall changes, V1 services or arbitrary shell.
The runner transfers only an HKDF-derived node key, never NODE_MASTER_KEY.
"""
import base64
import os
import pathlib
import re
import shutil
import stat
import subprocess

from .bootstrap import allowed_staging_node_id
from .installer import require_staging_marker
from .reconciler import ReconcileError,_safe_config_root

DEST=pathlib.Path('/opt/madar-v2/runtime')
SYSTEMD=pathlib.Path('/etc/systemd/system')
CONFIG=pathlib.Path('/etc/madar-v2')
KEY=CONFIG/'node.key'
ORIGIN='https://madar-v2-staging.alirezaanari117.workers.dev'
SERVICE='madar-v2-runtime.service'
WATCHDOG='madar-v2-runtime-watchdog.service'
TIMER='madar-v2-runtime-watchdog.timer'


def render_runtime_units(node_id):
    if not allowed_staging_node_id(node_id):
        raise ReconcileError('invalid staging runtime node ID')
    command=('/usr/bin/python3 -m agent.runtime --server '+ORIGIN+
       ' --node-id '+node_id+' --key-file /etc/madar-v2/node.key'+
       ' --state-dir /var/lib/madar-v2/runtime --root /etc/madar-v2')
    hardening="""NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/etc/madar-v2 /var/lib/madar-v2
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
UMask=0077
Environment=PYTHONPATH=/opt/madar-v2/runtime
"""
    unit="""[Unit]
Description=Madar V2 isolated node quota and client reconciler
Wants=network-online.target
After=network-online.target madar-v2-xray.service
Requires=madar-v2-xray.service

[Service]
Type=simple
User=root
Group=root
"""+hardening+"""ExecStart="""+command+"""
Restart=always
RestartSec=5s

[Install]
WantedBy=multi-user.target
"""
    monitor="""[Unit]
Description=Stop Madar V2 Xray when quota agent heartbeat expires

[Service]
Type=oneshot
User=root
Group=root
"""+hardening+"""ExecStart="""+command+""" --watchdog
"""
    timer="""[Unit]
Description=Madar V2 Xray quota watchdog clock

[Timer]
OnBootSec=25s
OnUnitActiveSec=15s
AccuracySec=1s
Unit=madar-v2-runtime-watchdog.service
Persistent=false

[Install]
WantedBy=timers.target
"""
    return {SERVICE:unit,WATCHDOG:monitor,TIMER:timer}


def install_node_runtime(node_id,key_source,package_source,*,root=CONFIG,
                         destination=DEST,unit_dir=SYSTEMD,runner=subprocess.run):
    if os.geteuid()!=0:
        raise ReconcileError('root required')
    if not allowed_staging_node_id(node_id):
        raise ReconcileError('invalid node')
    root=_safe_config_root(root)
    require_staging_marker(root)
    dest=pathlib.Path(destination)
    unit_dir=pathlib.Path(unit_dir)
    if root!=CONFIG or dest!=DEST or unit_dir!=SYSTEMD:
        raise ReconcileError('production paths only; tests use render functions')
    if any((unit_dir/name).exists() or (unit_dir/name).is_symlink()
           for name in (SERVICE,WATCHDOG,TIMER)) or dest.exists() or KEY.exists():
        raise ReconcileError('V2 runtime already configured; refuse overwrite')
    source=pathlib.Path(package_source)
    if not source.is_dir() or source.is_symlink():
        raise ReconcileError('missing trusted agent archive')
    secret=pathlib.Path(key_source)
    info=secret.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode&0o077 or info.st_size>96:
        raise ReconcileError('unsafe node secret source')
    value=secret.read_text(encoding='ascii').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}',value):
        raise ReconcileError('invalid node secret')
    raw=base64.urlsafe_b64decode(value+'=')
    if len(raw)!=32:
        raise ReconcileError('invalid node key size')
    files=list(source.glob('*.py'))
    if not files or not any(p.name=='runtime.py' for p in files):
        raise ReconcileError('runtime source absent')
    if any(p.is_symlink() or not p.is_file() for p in files):
        raise ReconcileError('untrusted package file')
    created=[]
    try:
        dest.mkdir(mode=0o700,parents=False,exist_ok=False)
        created.append(dest)
        package=dest/'agent'
        package.mkdir(mode=0o700)
        for item in files:
            if item.stat().st_size>65536:
                raise ReconcileError('oversized trusted module')
            output=package/item.name
            with output.open('xb') as stream:
                os.fchmod(stream.fileno(),0o600)
                stream.write(item.read_bytes())
        with KEY.open('xb') as stream:
            os.fchmod(stream.fileno(),0o600)
            stream.write((value+'\n').encode('ascii'))
            stream.flush();os.fsync(stream.fileno())
        created.append(KEY)
        for name,text in render_runtime_units(node_id).items():
            path=unit_dir/name
            with path.open('x',encoding='utf-8') as stream:
                os.fchmod(stream.fileno(),0o644)
                stream.write(text)
            created.append(path)
        def invoke(*args):
            runner(['/usr/bin/systemctl',*args],check=True,
                stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,timeout=30)
        invoke('daemon-reload')
        invoke('enable','--now',SERVICE)
        invoke('enable','--now',TIMER)
        return {'node_runtime':'installed','quota_local_enforced':False,
                'field_verified':False}
    except BaseException:
        for name in (SERVICE,TIMER):
            try:
                runner(['/usr/bin/systemctl','disable','--now',name],
                    check=False,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,timeout=15)
            except Exception:
                pass
        for path in reversed(created):
            try:
                if path.is_dir():shutil.rmtree(path)
                else:path.unlink(missing_ok=True)
            except Exception:
                pass
        try:
            runner(['/usr/bin/systemctl','daemon-reload'],
                check=False,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,timeout=15)
        except Exception:
            pass
        raise
