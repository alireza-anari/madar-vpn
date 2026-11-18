"""Verified V2 desired clients, local quota ledger, and isolated dual REALITY config.

This module cannot activate a user by itself. Never apply an unsigned policy.
It follows V1's durable monotonic metering and fail-closed process generations.
"""
import copy
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
import uuid
from pathlib import Path

from .manifest import sign
from .xray_config import compile_config

ACCOUNT=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$')
UUID=re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
NODE=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$')
MAX=9007199254740991
API_PORT=10085


def integer(v,low=0,high=MAX):
    if type(v) is not int or not low<=v<=high:
        raise ValueError("INVALID_QUOTA_INTEGER")
    return v


def verify_clients(envelope,key,node_id,now=None):
    """Require matching HMAC, a fresh policy and unambiguous unique UUIDs."""
    now=int(time.time()) if now is None else now
    if not isinstance(envelope,dict) or set(envelope)!={'payload','signature','applied'}:
        raise ValueError("INVALID_ENVELOPE")
    p=envelope['payload']
    if not isinstance(p,dict) or set(p)!={'node_id','revision','issued_at','expires_at','mode','clients'}:
        raise ValueError("INVALID_POLICY_FIELDS")
    if not isinstance(key,bytes) or len(key)!=32 or not isinstance(envelope['signature'],str) or not hmac.compare_digest(sign(p,key),envelope['signature']):
        raise ValueError("BAD_POLICY_SIGNATURE")
    if p['node_id']!=node_id or not NODE.fullmatch(node_id):
        raise ValueError("WRONG_NODE")
    integer(p['revision'],1)
    issued=integer(p['issued_at'],1)
    until=integer(p['expires_at'],1)
    if issued>now+30 or now-issued>90 or not now<until<=now+150:
        raise ValueError("EXPIRED_POLICY")
    if p['mode'] not in ('commercial','test') or not isinstance(p['clients'],list) or len(p['clients'])>1000:
        raise ValueError("INVALID_CLIENTS")
    if envelope['applied'] is not False:
        raise ValueError("UNTRUSTED_APPLY_STATUS")
    seen=set()
    uuids=set()
    for c in p['clients']:
        if not isinstance(c,dict) or set(c)!={'subscription_id','uuid','expires_at','quota_bytes','used_bytes','remaining_bytes'}:
            raise ValueError("INVALID_CLIENT_FIELDS")
        sid=c['subscription_id']
        if not isinstance(sid,str) or not ACCOUNT.fullmatch(sid) or sid in seen:
            raise ValueError("DUPLICATE_CLIENT")
        seen.add(sid)
        if not isinstance(c['uuid'],str) or not UUID.fullmatch(c['uuid']) or c['uuid'] in uuids:
            raise ValueError("INVALID_UUID")
        uuids.add(c['uuid'])
        integer(c['expires_at'],now)
        cap=integer(c['quota_bytes'],1)
        used=integer(c['used_bytes'])
        left=integer(c['remaining_bytes'])
        if used>cap or left!=cap-used:
            raise ValueError("INCONSISTENT_QUOTA")
    return p


def compile_dual_account_config(secrets,active):
    """Build both REALITY sockets from pinned local keys, never from Web input."""
    if not isinstance(secrets,dict) or not {'clients','reality','websocket'}.issubset(secrets):
        raise ValueError("INVALID_LOCAL_SECRETS")
    if secrets['websocket'] is not None:
        raise ValueError("DUAL_REALITY_ONLY")
    reality=copy.deepcopy(secrets['reality'])
    if reality.get('port')!=8443:
        raise ValueError("UNEXPECTED_REALITY_PORT")
    if not isinstance(active,list) or len(active)>1000:
        raise ValueError("INVALID_CLIENT_SET")
    clients=[c['uuid'] for c in active]
    # compile_config requires a nonempty list, so use a locally generated
    # bootstrap UUID only for intermediate validation, then remove it.
    fallback=secrets['clients'][0] if (not clients and secrets.get('clients')) else None
    if not clients and (not isinstance(fallback,str) or not UUID.fullmatch(fallback)):
        raise ValueError("NO_SAFE_BOOTSTRAP")
    config=compile_config(clients=clients or [fallback],reality=reality,websocket=None)
    source=config['inbounds'][0]
    if source['port']!=8443 or source['tag']!='madar-reality':
        raise ValueError("BAD_XRAY_COMPILER")
    for user,entry in zip(source['settings']['users'],active):
        user['email']='v2-'+entry['subscription_id']
    if not clients:
        source['settings']['users']=[]
    second=copy.deepcopy(source)
    second['port']=443
    second['tag']='madar-reality-mci'
    config['inbounds'].append(second)
    # Loopback-only statistics. Never expose StatsService on a public IP.
    config['inbounds'].append({
        'listen':'127.0.0.1','port':API_PORT,'protocol':'dokodemo-door',
        'tag':'madar-stats-api','settings':{'address':'127.0.0.1'},
    })
    config['api']={'tag':'api','services':['StatsService']}
    config['routing']={'rules':[{'type':'field',
        'inboundTag':['madar-stats-api'],'outboundTag':'api'}]}
    return config


def parse_stats(raw,sub_ids):
    if not isinstance(raw,str) or len(raw)>1048576:
        raise ValueError("INVALID_STATS_RESPONSE")
    data=json.loads(raw)
    if not isinstance(data,dict) or not isinstance(data.get('stat',[]),list):
        raise ValueError("INVALID_STATS_DOCUMENT")
    expected={'v2-'+sid:sid for sid in sub_ids}
    result={sid:0 for sid in sub_ids}
    matched=set()
    for item in data.get('stat',[]):
        if not isinstance(item,dict):
            raise ValueError("INVALID_STATS_RECORD")
        name=item.get('name')
        if not isinstance(name,str) or not name.startswith('user>>>v2-'):
            continue
        bits=name.split('>>>')
        if len(bits)!=4 or bits[2]!='traffic' or bits[3] not in ('uplink','downlink'):
            raise ValueError("INVALID_STATS_NAME")
        sid=expected.get(bits[1])
        if sid is None:
            continue
        if name in matched:
            raise ValueError("DUPLICATE_STATS")
        matched.add(name)
        value=item.get('value')
        if isinstance(value,str) and re.fullmatch(r'[0-9]{1,16}',value):
            value=int(value)
        integer(value)
        result[sid]=integer(result[sid]+value)
    return result


class LocalLedger:
    """Cumulative totals cannot be reset by policy refresh or Xray restart."""
    def __init__(self,filename):
        path=Path(filename)
        path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.db=sqlite3.connect(path)
        os.chmod(path,0o600)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA journal_mode=DELETE')
        self.db.row_factory=sqlite3.Row
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS accounts(
          id TEXT PRIMARY KEY, uuid TEXT NOT NULL,
          quota INTEGER NOT NULL, used INTEGER NOT NULL, expires_ms INTEGER NOT NULL,
          counter INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
          sequence INTEGER NOT NULL DEFAULT 0, reported_seq INTEGER NOT NULL DEFAULT 0,
          installed INTEGER NOT NULL DEFAULT 0, present INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        """)
    def close(self):
        self.db.close()
    def all(self):
        return [dict(r) for r in self.db.execute('SELECT * FROM accounts ORDER BY id')]
    def get(self,sid):
        row=self.db.execute('SELECT * FROM accounts WHERE id=?',(sid,)).fetchone()
        return dict(row) if row else None
    def reconcile(self,clients,now_ms):
        # Do not reset a local counter on a policy refresh.
        with self.db:
            self.db.execute('UPDATE accounts SET present=0')
            for c in clients:
                sid=c['subscription_id'];old=self.get(sid)
                remote_used=c['used_bytes'];quota=c['quota_bytes']
                if old and old['uuid']!=c['uuid']:
                    raise ValueError("UUID_ROTATION_REQUIRES_NEW_LEDGER")
                if old and quota<old['quota']:
                    # Administrators may lower quotas; never loosen the local budget.
                    quota=min(quota,old['quota'])
                if old:
                    self.db.execute(
                        'UPDATE accounts SET quota=?,used=?,expires_ms=?,present=1 WHERE id=?',
                        (quota,max(old['used'],remote_used),min(old['expires_ms'],c['expires_at']),sid))
                else:
                    self.db.execute('INSERT INTO accounts(id,uuid,quota,used,expires_ms) VALUES(?,?,?,?,?)',
                        (sid,c['uuid'],quota,remote_used,c['expires_at']))
    def observe(self,absolute,now_ms):
        with self.db:
            for sid,value in absolute.items():
                integer(value)
                old=self.get(sid)
                if old is None or old['installed']!=1:
                    continue
                if value<old['counter']:
                    raise ValueError("COUNTER_ROLLBACK")
                delta=value-old['counter']
                if delta:
                    self.db.execute(
                        'UPDATE accounts SET counter=?,total=total+?,used=MAX(used,total+?),sequence=sequence+1 WHERE id=?',
                        (value,delta,delta,sid))
    def epoch_reset(self):
        with self.db:
            self.db.execute('UPDATE accounts SET counter=0,installed=0')
    def mark_installed(self,ids):
        with self.db:
            self.db.execute('UPDATE accounts SET installed=0')
            for sid in ids:
                self.db.execute('UPDATE accounts SET installed=1 WHERE id=?',(sid,))
    def active(self,now_ms):
        return [r for r in self.all() if r['present'] and r['expires_ms']>now_ms
            and r['used']<r['quota']]
    def reportable(self):
        return [r for r in self.all() if r['total']>0 and r['sequence']>r['reported_seq']]
    def ack_report(self,sid,sequence):
        with self.db:
            self.db.execute('UPDATE accounts SET reported_seq=MAX(reported_seq,?) WHERE id=?',
                (sequence,sid))
