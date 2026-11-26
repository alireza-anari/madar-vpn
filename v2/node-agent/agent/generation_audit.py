"""Read-only, redacted process-generation evidence for Madar V2 (issue #58 G1).

Usage on an owner-operated VPS, from the V2 agent's parent directory:
    sudo python3 -m agent.generation_audit

This deliberately cannot repair, reset, start, stop or restart Xray. Never
treat a PID match as proof of complete usage continuity or launch approval.
No UUIDs, node credentials, config contents, user labels, or PIDs are printed.
"""
import json
import os
import pathlib
import sqlite3
import stat
import subprocess
from urllib.parse import quote

STATE = pathlib.Path("/var/lib/madar-v2/runtime")
CONFIG = pathlib.Path("/etc/madar-v2/config.json")
XRAY_UNIT = "madar-v2-xray.service"


def _bounded_json(path, limit):
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            return "unsafe_or_oversized", None
        with path.open("rb") as handle:
            raw = handle.read(limit + 1)
        if len(raw) > limit:
            return "unsafe_or_oversized", None
        data = json.loads(raw)
        if not isinstance(data, dict):
            return "malformed", None
        return "readable", data
    except FileNotFoundError:
        return "missing", None
    except (OSError, ValueError, UnicodeError):
        return "unreadable", None


def _current_pid():
    try:
        run = subprocess.run(
            ["/usr/bin/systemctl", "show", "-p", "MainPID", "--value", XRAY_UNIT],
            capture_output=True, text=True, timeout=5, check=False
        )
        if run.returncode != 0:
            return None
        pid = int(run.stdout.strip())
        return pid if pid > 1 else 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _ledger_summary(path):
    """Open an existing SQLite ledger read-only; never create/modify one."""
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            return {"status": "unsafe"}
    except FileNotFoundError:
        return {"status": "missing"}
    except OSError:
        return {"status": "unreadable"}
    db = None
    try:
        uri = "file:" + quote(str(path.absolute()), safe="/") + "?mode=ro"
        db = sqlite3.connect(uri, uri=True, timeout=2)
        db.execute("PRAGMA query_only=ON")
        row = db.execute("""
            SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN installed=1 THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN present=1 THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN total>0 AND sequence>reported_seq
                                  THEN 1 ELSE 0 END),0),
                COALESCE(SUM(total),0)
            FROM accounts
        """).fetchone()
        if row is None:
            return {"status": "unreadable"}
        return {"status": "readable", "accounts": row[0],
                "marked_installed": row[1], "marked_present": row[2],
                "unreported_account_count": row[3],
                "cumulative_metered_bytes": row[4]}
    except (sqlite3.Error, OSError):
        return {"status": "unreadable"}
    finally:
        if db is not None:
            db.close()


def _config_summary(path):
    status, data = _bounded_json(path, 2 * 1024 * 1024)
    if data is None:
        return {"status": status}
    try:
        inbounds = data["inbounds"]
        if not isinstance(inbounds, list):
            raise ValueError()
        listeners = {443: 0, 8443: 0}
        for inbound in inbounds:
            if not isinstance(inbound, dict):
                raise ValueError()
            if inbound.get("protocol") != "vless":
                continue
            port = inbound.get("port")
            if port not in listeners:
                continue
            users = inbound["settings"]["users"]
            if not isinstance(users, list):
                raise ValueError()
            listeners[port] += len(users)
        return {"status": "readable", "vless_profiles_443": listeners[443],
                "vless_profiles_8443": listeners[8443]}
    except (KeyError, TypeError, ValueError):
        return {"status": "malformed"}


def inspect(state=STATE, config=CONFIG, pid_reader=_current_pid):
    """Report evidence, not a determination that a damaged ledger is safe to reset."""
    state = pathlib.Path(state)
    marker_status, marker = _bounded_json(state / "heartbeat.json", 4096)
    ledger = _ledger_summary(state / "quota.sqlite")
    config_summary = _config_summary(pathlib.Path(config))
    pid_before = pid_reader()
    pid_after = pid_reader()
    if pid_before is None or pid_after is None or pid_before != pid_after:
        process = "unverifiable_or_changing"
    elif pid_before == 0:
        process = "not_running"
    elif marker_status != "readable" or not isinstance(marker.get("pid"), int):
        process = "marker_missing_or_invalid"
    elif marker.get("pid") != pid_before:
        process = "generation_mismatch"
    else:
        process = "pid_marker_match_only"
    return {
        "scope": "READ_ONLY_NON_SECRET_EVIDENCE",
        "marker": {"status": marker_status,
                   "mode": marker.get("mode") if marker and
                   marker.get("mode") in ("commercial", "test") else "unknown"},
        "process_generation": process,
        "ledger": ledger,
        "xray_config": config_summary,
        "G1": "PENDING_LOCAL_COUNTER_RECONCILIATION"
              if process != "pid_marker_match_only"
              else "PENDING_USAGE_CONTINUITY_VERIFICATION",
        "safe_to_reset_ledger_or_marker": False,
        "safe_to_issue_customer_configs_from_this_report": False
    }


def main():
    print(json.dumps(inspect(), sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
