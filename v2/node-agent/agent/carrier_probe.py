"""Read-only privacy-preserving inbound TCP reachability measurement for a disposable VPS.

Run as root on the explicitly authorized staging node. Uses a bounded raw
AF_PACKET IPv4 packet capture; does NOT capture/store user payload, IPs, TLS
fingerprints, UUIDs, credentials, or packet bytes. No service restarts,
iptables changes, kernel configuration, DNS queries, or background daemons.

Report aggregates inbound SYN / ACK / data bytes and outbound SYN-ACK /
payload bytes to staging ports 80, 443 and 8443. Observations cannot prove
which carrier originated the packets; unknown Internet scanners can contribute.
"""
import argparse
import json
import os
import socket
import struct
import time
from collections import defaultdict
from pathlib import Path

from .installer import require_staging_marker
from .reconciler import ReconcileError, _safe_config_root

ETH_P_IP = 0x0800
PACKET_OUTGOING = getattr(socket, "PACKET_OUTGOING", 4)
PORTS = (80,443,8443)
COUNTERS = ("in_syn","in_ack","in_data_segments","out_synack","out_data_segments")


def decode_ipv4_tcp(frame, direction):
    """Return only (local_port, counter_name), never endpoint IP or payload.

    Supports ordinary Ethernet II and a single optional 802.1q VLAN tag.
    Skip fragmented IPv4, malformed headers, non-TCP and unrelated ports.
    """
    if not isinstance(frame,bytes) or len(frame)<54 or direction not in ("in","out"):
        return None
    ethertype=struct.unpack_from("!H",frame,12)[0]
    offset=14
    if ethertype in (0x8100,0x88A8):
        if len(frame)<58: return None
        ethertype=struct.unpack_from("!H",frame,16)[0]
        offset=18
    if ethertype!=ETH_P_IP or len(frame)<offset+40: return None
    first=frame[offset]
    if first>>4!=4: return None
    ihl=(first&15)*4
    if ihl<20 or len(frame)<offset+ihl+20: return None
    if frame[offset+9]!=socket.IPPROTO_TCP: return None
    frag=struct.unpack_from("!H",frame,offset+6)[0]
    if frag & 0x3FFF: return None
    total=struct.unpack_from("!H",frame,offset+2)[0]
    if total<ihl+20: return None
    tcp=offset+ihl
    source,dest=struct.unpack_from("!HH",frame,tcp)
    data_offset=(frame[tcp+12]>>4)*4
    if data_offset<20 or total<ihl+data_offset: return None
    flags=frame[tcp+13]
    syn=bool(flags&0x02)
    ack=bool(flags&0x10)
    payload_len=total-ihl-data_offset
    if direction=="in" and dest in PORTS:
        if syn and not ack:return dest,"in_syn"
        if payload_len>0:return dest,"in_data_segments"
        if ack:return dest,"in_ack"
    if direction=="out" and source in PORTS:
        if syn and ack:return source,"out_synack"
        if payload_len>0:return source,"out_data_segments"
    return None


def capture_counts(*,duration=75, socket_factory=socket.socket,
                   now=time.monotonic, include_traffic=None):
    if type(duration) is not int or not 10<=duration<=180:
        raise ValueError("duration must be 10-180 seconds")
    seen={str(port):{label:0 for label in COUNTERS} for port in PORTS}
    sock=socket_factory(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(ETH_P_IP))
    try:
        sock.settimeout(1.0)
        deadline=now()+duration
        while now()<deadline:
            try:
                packet,address=sock.recvfrom(65535)
            except socket.timeout:
                continue
            if len(address)<3 or address[0]=="lo":
                continue
            direction="out" if address[2]==PACKET_OUTGOING else "in"
            observation=decode_ipv4_tcp(packet,direction)
            if observation is None:
                continue
            port,event=observation
            seen[str(port)][event]+=1
    finally:
        sock.close()
    return {
        "duration_seconds":duration,
        "ports":seen,
        "service_config_changed":False,
        "source_identity_observed":False,
        "carrier_verified":False,
        "notes":"Aggregate anonymous IPv4 counts only; background probes may contribute"
    }


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration",type=int,default=75)
    parser.add_argument("--root",default="/etc/madar-v2")
    parser.add_argument("--output",default="/root/madar-carrier-probe.json")
    args=parser.parse_args(argv)
    if os.geteuid()!=0:
        raise ReconcileError("root is required for short-lived read-only AF_PACKET capture")
    directory=_safe_config_root(args.root)
    require_staging_marker(directory)
    output=Path(args.output)
    if output.as_posix()!="/root/madar-carrier-probe.json":
        raise ReconcileError("refusing arbitrary report output path")
    if output.is_symlink():
        raise ReconcileError("report path cannot be symlink")
    print("Madar V2 passive reachability capture started (no IP or payload logged).",flush=True)
    report=capture_counts(duration=args.duration)
    # Restrict file creation to root and mode 0600, atomic same-directory swap.
    import tempfile
    fd,temp=tempfile.mkstemp(prefix=".madar-carrier-probe-",dir="/root")
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"w",encoding="utf-8") as out:
            json.dump(report,out,sort_keys=True)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp,output)
    finally:
        Path(temp).unlink(missing_ok=True)
    print(json.dumps(report,sort_keys=True))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
