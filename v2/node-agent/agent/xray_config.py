"""Pure, fail-closed Xray VLESS configuration compiler for Madar V2.

No process execution, firewall changes, network connections or VPS mutation.
The installer must separately validate a pinned Xray binary and field probes.
Supports only REALITY/RAW and loopback-only WebSocket behind a TLS proxy.
"""
import ipaddress
import json
import re
import uuid

DOMAIN = re.compile(r"^(?=.{3,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$")
BASE64URL = re.compile(r"^[A-Za-z0-9_-]{43}$")
SHORT_ID = re.compile(r"^[a-f0-9]{2,16}$")
WS_PATH = re.compile(r"^/[a-zA-Z0-9_/-]{1,200}$")
PORT_HIGH=65535


def _port(value):
    if type(value) is not int or not 1<=value<=PORT_HIGH:
        raise ValueError("invalid port")
    return value


def _domain(value):
    if not isinstance(value,str) or not DOMAIN.fullmatch(value):
        raise ValueError("invalid domain")
    return value


def _client_uuid(value):
    try:
        parsed=uuid.UUID(str(value))
    except (ValueError,AttributeError,TypeError):
        raise ValueError("invalid UUID") from None
    if str(parsed)!=value.lower():
        raise ValueError("noncanonical UUID")
    return str(parsed)


def compile_config(*, clients, reality=None, websocket=None):
    """Return ready-for-xray-format-check JSON object, NOT a readiness result.

    clients: locally provisioned per-user secrets. No users -> fail closed.
    reality: {port,target,server_name,private_key,short_ids}
    websocket: {path,loopback_port} bound ONLY to 127.0.0.1 (TLS at Caddy)
    """
    if not isinstance(clients,list) or not 1<=len(clients)<=1000:
        raise ValueError("nonempty bounded client list required")
    if reality is None and websocket is None:
        raise ValueError("no transport")
    ids=[_client_uuid(c) for c in clients]
    if len(ids)!=len(set(ids)):
        raise ValueError("duplicate client UUIDs")
    if reality is not None and (not isinstance(reality,dict) or
        set(reality)!={"port","target","server_name","private_key","short_ids"}):
        raise ValueError("invalid REALITY fields")
    if websocket is not None and (not isinstance(websocket,dict) or
        set(websocket)!={"path","loopback_port"}):
        raise ValueError("invalid WebSocket fields")
    inbounds=[]
    ports=set()
    if reality is not None:
        port=_port(reality["port"])
        target=_domain(reality["target"])
        server_name=_domain(reality["server_name"])
        private=reality["private_key"]
        shortids=reality["short_ids"]
        if not isinstance(private,str) or not BASE64URL.fullmatch(private):
            raise ValueError("missing/invalid local REALITY private key")
        if not isinstance(shortids,list) or not 1<=len(shortids)<=8 or any(
            not isinstance(v,str) or not SHORT_ID.fullmatch(v) for v in shortids
        ) or len(shortids)!=len(set(shortids)):
            raise ValueError("invalid shortIds")
        ports.add(port)
        inbounds.append({
            "tag":"madar-reality",
            "listen":"0.0.0.0",
            "port":port,
            "protocol":"vless",
            "settings":{"decryption":"none","users":[
                {"id":v,"flow":"xtls-rprx-vision","email":"v2-"+v} for v in ids
            ]},
            "streamSettings":{
                "network":"raw","security":"reality",
                "realitySettings":{
                    "show":False,"target":target+":443",
                    "xver":0,"serverNames":[server_name],
                    "privateKey":private,"shortIds":shortids,
                },
            },
        })
    if websocket is not None:
        loopback=_port(websocket["loopback_port"])
        path=websocket["path"]
        if not isinstance(path,str) or not WS_PATH.fullmatch(path):
            raise ValueError("invalid WebSocket path")
        if loopback in ports:
            raise ValueError("WSS local and REALITY ports collide")
        inbounds.append({
            "tag":"madar-ws-loopback",
            "listen":"127.0.0.1",
            "port":loopback,
            "protocol":"vless",
            "settings":{"decryption":"none","users":[{"id":v,"email":"v2-"+v} for v in ids]},
            "streamSettings":{"network":"ws","security":"none",
                              "wsSettings":{"path":path}},
        })
    return {
        "log":{"loglevel":"warning"},
        "inbounds":inbounds,
        "outbounds":[{"protocol":"freedom","tag":"direct"},
                     {"protocol":"blackhole","tag":"blocked"}],
        "policy":{"levels":{"0":{"statsUserUplink":True,"statsUserDownlink":True}}},
        "stats":{},
    }


def compile_caddy_site(*, domain, ws_path, loopback_port):
    """Minimal TLS proxy to loopback-only VLESS/WS; no untrusted Host injection."""
    domain=_domain(domain)
    loopback_port=_port(loopback_port)
    if not isinstance(ws_path,str) or not WS_PATH.fullmatch(ws_path):
        raise ValueError("invalid WS path")
    return (
        f"{domain} {{\n"
        f"    @madar_ws path {ws_path}\n"
        f"    reverse_proxy @madar_ws 127.0.0.1:{loopback_port}\n"

        f"}}\n"
    )


def encode(config):
    return json.dumps(config,ensure_ascii=False,sort_keys=True,indent=2)+"\n"
