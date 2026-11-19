"""Fail-closed removal of *only* a disposable, independently owned Madar V2 node.

The owner must authenticate via the GitHub V2 SSH runner with a pinned SSH host
fingerprint. The control plane must quarantine the node and confirm there are
no active/used allocations before invoking this module. The node independently
re-checks its identity, local Xray users and durable usage ledger; an unexpected
file, service or account blocks deletion. This is NOT an OS wipe.
"""
import ipaddress
import json
import os
import pathlib
import shutil
import sqlite3
import stat
import subprocess
import tempfile
from urllib.parse import quote

from .installer import MARKER_TEXT
from .bootstrap import allowed_staging_node_id
from .dual_reality import CAPABILITIES

ETC=pathlib.Path('/etc/madar-v2')
APP=pathlib.Path('/opt/madar-v2')
DATA=pathlib.Path('/var/lib/madar-v2')
UNITS=pathlib.Path('/etc/systemd/system')
FILES={
    'madar-v2-runtime.service':(
        'Description=Madar V2 isolated node quota and client reconciler',
        'ExecStart=/usr/bin/python3 -m agent.runtime '),
    'madar-v2-runtime-watchdog.service':(
        'Description=Stop Madar V2 Xray when quota agent heartbeat expires',
        'ExecStart=/usr/bin/python3 -m agent.runtime '),
    'madar-v2-runtime-watchdog.timer':(
        'Description=Madar V2 Xray quota watchdog clock',
        'Unit=madar-v2-runtime-watchdog.service'),
    'madar-v2-xray.service':(
        'Description=Madar V2 isolated Xray test node',
        'ExecStart=/opt/madar-v2/bin/xray run -config '),
    'madar-v2-caddy.service':(
        'Description=Madar V2 isolated HTTPS WebSocket test edge',
        'ExecStart=/opt/madar-v2/bin/caddy run --config '),
}
STOP_SEQUENCE=(
    'madar-v2-runtime-watchdog.timer',
    'madar-v2-runtime.service',
    'madar-v2-runtime-watchdog.service',
    'madar-v2-caddy.service',
    'madar-v2-xray.service',
)
CONFIG_FILES=frozenset({
    'STAGING-ONLY','config.json','local-secrets.json','public-route-metadata.json',
    'config.pre-carrier443.json','previous.json','Caddyfile','node.key',
    'installer.lock','agent.lock',
})
STATE_FILES=frozenset({
    'runtime/quota.sqlite','runtime/quota.sqlite-journal',
    'runtime/quota.sqlite-wal','runtime/quota.sqlite-shm',
    'runtime/heartbeat.json','runtime/runtime.lock','runtime/desired/state.json',
})


class ResetBlocked(RuntimeError):
    pass


def _owned(path,kind=None):
    path=pathlib.Path(path)
    info=path.lstat()
    if path.is_symlink() or info.st_uid!=0 or info.st_mode&0o022:
        raise ResetBlocked('UNTRUSTED_V2_PATH')
    if kind=='file' and (not stat.S_ISREG(info.st_mode) or info.st_nlink!=1):
        raise ResetBlocked('UNTRUSTED_V2_FILE')
    if kind=='dir' and not stat.S_ISDIR(info.st_mode):
        raise ResetBlocked('UNTRUSTED_V2_DIRECTORY')
    if stat.S_ISREG(info.st_mode) and info.st_size>104857600:
        raise ResetBlocked('UNEXPECTED_V2_FILE_SIZE')
    return path


def _bounded_files(base,category):
    if not base.exists():
        return
    _owned(base,'dir')
    for item in base.rglob('*'):
        if item.is_symlink():
            raise ResetBlocked('SYMLINK_IN_V2_TREE')
        rel=item.relative_to(base).as_posix()
        if item.is_dir():
            _owned(item,'dir')
            if category=='app' and rel not in ('bin','runtime','runtime/agent') and (
                not rel.startswith('runtime/agent/__pycache__')):
                raise ResetBlocked('UNKNOWN_V2_DIRECTORY')
            if category=='state' and rel not in ('runtime','runtime/desired'):
                raise ResetBlocked('UNKNOWN_V2_DIRECTORY')
            continue
        _owned(item,'file')
        if category=='etc' and rel not in CONFIG_FILES:
            raise ResetBlocked('UNKNOWN_V2_CONFIG')
        if category=='state' and rel not in STATE_FILES:
            raise ResetBlocked('UNKNOWN_V2_STATE')
        if category=='app' and not (
            rel in ('bin/xray','bin/caddy') or
            (rel.startswith('runtime/agent/') and
             (rel.endswith('.py') or (
                '/__pycache__/' in rel and rel.endswith('.pyc'))))):
            raise ResetBlocked('UNKNOWN_V2_PACKAGE')


def _ledger_unused(path):
    if not path.exists():
        return
    _owned(path,'file')
    uri='file:'+quote(str(path.resolve(strict=True)),safe='/')+'?mode=ro'
    try:
        with sqlite3.connect(uri,uri=True,timeout=3) as db:
            db.execute('PRAGMA query_only=ON')
            count=db.execute(
                'SELECT COUNT(*) FROM accounts WHERE installed<>0 OR used<>0 OR '
                'counter<>0 OR total<>0 OR sequence<>0 OR reported_seq<>0'
            ).fetchone()[0]
    except sqlite3.Error:
        raise ResetBlocked('LEDGER_NOT_VERIFIABLY_UNUSED') from None
    if count:
        raise ResetBlocked('CUSTOMER_USAGE_OR_INSTALL_PRESENT')


def _config_has_only_bootstrap(base):
    try:
        secrets=json.loads(_owned(base/'local-secrets.json','file').read_text())
        config=json.loads(_owned(base/'config.json','file').read_text())
        bootstrap=secrets['clients']
        inbounds=config['inbounds']
        if not isinstance(bootstrap,list) or len(bootstrap)!=1 or not isinstance(inbounds,list):
            raise ValueError('unrecognized')
        for entry in inbounds:
            if entry.get('protocol')=='vless':
                users=entry.get('settings',{}).get('users',[])
                if any(user.get('id') not in bootstrap for user in users):
                    raise ResetBlocked('COMMERCIAL_XRAY_UUID_PRESENT')
    except ResetBlocked:
        raise
    except (OSError,KeyError,ValueError,TypeError):
        raise ResetBlocked('UNVERIFIABLE_XRAY_CLIENTS') from None


def _check_units(directory):
    paths=[]
    for name,signatures in FILES.items():
        path=directory/name
        if path.exists() or path.is_symlink():
            text=_owned(path,'file').read_text(encoding='utf-8')
            if any(s not in text for s in signatures) or len(text)>16000:
                raise ResetBlocked('UNKNOWN_V2_SYSTEMD_UNIT')
            paths.append(path)
    # No unexpected V2 systemd unit may be silently left behind.
    for path in directory.glob('madar-v2-*'):
        if path.is_symlink():
            raise ResetBlocked('SYMLINK_IN_SYSTEMD')
        if path.is_file() and path.name not in FILES:
            raise ResetBlocked('UNRECOGNIZED_V2_SYSTEMD_UNIT')
    drop=directory/'madar-v2-xray.service.d'
    if drop.exists() or drop.is_symlink():
        _owned(drop,'dir')
        children=list(drop.iterdir())
        if len(children)!=1 or children[0].name!='20-madar-test-reality-443.conf':
            raise ResetBlocked('UNKNOWN_V2_CAPABILITY_OVERRIDE')
        if _owned(children[0],'file').read_text()!=CAPABILITIES:
            raise ResetBlocked('UNKNOWN_V2_CAPABILITY_OVERRIDE')
    else:
        drop=None
    if directory/'madar-v2-xray.service' not in paths:
        raise ResetBlocked('V2_XRAY_UNIT_MISSING')
    return paths,drop


def preflight(node_id,public_ip,*,etc=ETC,app=APP,data=DATA,units=UNITS):
    if os.geteuid()!=0:
        raise ResetBlocked('ROOT_REQUIRED')
    if not allowed_staging_node_id(node_id):
        raise ResetBlocked('INVALID_NODE_ID')
    try:
        ip=ipaddress.ip_address(public_ip)
        if ip.version!=4 or not ip.is_global:
            raise ValueError()
    except ValueError:
        raise ResetBlocked('INVALID_PUBLIC_IP') from None
    _bounded_files(etc,'etc')
    _bounded_files(app,'app')
    _bounded_files(data,'state')
    try:
        marker=_owned(etc/'STAGING-ONLY','file').read_text()
        info=json.loads(_owned(etc/'public-route-metadata.json','file').read_text())
    except (OSError,ValueError):
        raise ResetBlocked('V2_IDENTITY_NOT_VERIFIABLE') from None
    if marker!=MARKER_TEXT or info.get('node_id')!=node_id or info.get('public_ip')!=str(ip):
        raise ResetBlocked('V2_IDENTITY_MISMATCH')
    _ledger_unused(data/'runtime'/'quota.sqlite')
    _config_has_only_bootstrap(etc)
    paths,drop=_check_units(units)
    return paths,drop


def reset(node_id,public_ip,*,apply=False,etc=ETC,app=APP,data=DATA,
          units=UNITS,runner=subprocess.run):
    paths,drop=preflight(node_id,public_ip,etc=etc,app=app,data=data,units=units)
    if not apply:
        return 'RESET_PREFLIGHT_OK'
    for service in STOP_SEQUENCE:
        if units/service in paths:
            # The watchdog oneshot is static (no [Install] section): attempting
            # to "disable" it can fail even on an otherwise healthy system.
            # Stop first, then disable only the enabled units/timer.
            stopped=runner(['/usr/bin/systemctl','stop',service],
                check=False,timeout=25,stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if stopped.returncode!=0:
                raise ResetBlocked('V2_SYSTEMD_STOP_FAILED')
            active=runner(['/usr/bin/systemctl','is-active','--quiet',service],
                check=False,timeout=5,stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if active.returncode==0:
                raise ResetBlocked('V2_SYSTEMD_STILL_ACTIVE')
            if service!='madar-v2-runtime-watchdog.service':
                disabled=runner(['/usr/bin/systemctl','disable',service],
                    check=False,timeout=20,stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                if disabled.returncode!=0:
                    raise ResetBlocked('V2_SYSTEMD_DISABLE_FAILED')
    # The agent could have been reconciling a customer at the first check.
    # Re-read Xray users and the durable ledger AFTER all V2 services stop.
    # A newly installed UUID or incremented counter now refuses deletion.
    preflight(node_id,public_ip,etc=etc,app=app,data=data,units=units)
    for item in paths:
        item.unlink()
    if drop:
        for item in drop.iterdir():
            item.unlink()
        drop.rmdir()
    for path in (data,etc,app):
        if path.exists():
            shutil.rmtree(path)
    reloaded=runner(['/usr/bin/systemctl','daemon-reload'],
        check=False,timeout=20,stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if reloaded.returncode!=0:
        raise ResetBlocked('V2_SYSTEMD_RELOAD_FAILED')
    if any(x.exists() for x in (etc,app,data)) or any(x.exists() for x in paths):
        raise ResetBlocked('V2_RESIDUE_REMAINS')
    return 'RESET_COMPLETED'


def main(argv=None):
    p=__import__('argparse').ArgumentParser()
    p.add_argument('--node-id',required=True)
    p.add_argument('--public-ip',required=True)
    p.add_argument('--apply',action='store_true')
    args=p.parse_args(argv)
    try:
        print(json.dumps({'status':reset(args.node_id,args.public_ip,apply=args.apply)}))
    except (ResetBlocked,OSError,ValueError,KeyError):
        print(json.dumps({'status':'RESET_BLOCKED'}))
        raise SystemExit(1)


if __name__=='__main__':
    main()
