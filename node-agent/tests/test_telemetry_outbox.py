from __future__ import annotations

import importlib
import os
import sqlite3
import stat
import sys
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


START = datetime(2026, 10, 10, 8, 0, 0, tzinfo=UTC)
CLIENT_A = "27848739-7e62-4138-9fd3-098a63964b6b"
CLIENT_B = "50848739-7e62-4138-9fd3-098a63964b6b"
WINDOW = "xray-traffic:2026-10-10T08:00Z"


def outbox_class():
    try:
        module = importlib.import_module("madar_agent.outbox")
    except ModuleNotFoundError:
        pytest.fail("madar_agent.outbox must implement TelemetryOutbox")
    cls = getattr(module, "TelemetryOutbox", None)
    assert cls is not None, "madar_agent.outbox must expose TelemetryOutbox"
    return cls


def record_tick(outbox, *, client_id: str = CLIENT_A, offset: int = 1) -> None:
    outbox.record_activity(
        client_id=client_id,
        window_id=WINDOW,
        seconds=1,
        timestamp=START + timedelta(seconds=offset),
        observed_from=START + timedelta(seconds=offset - 1),
        observed_to=START + timedelta(seconds=offset),
        session_id=None,
    )


def record_bucket(outbox, *, client_id: str = CLIENT_A, second: int) -> None:
    bucket_start = START + timedelta(seconds=second)
    outbox.record_active_bucket(
        client_id=client_id,
        bucket_start=bucket_start,
        timestamp=bucket_start + timedelta(seconds=1),
        observed_from=bucket_start,
        observed_to=bucket_start + timedelta(seconds=1),
    )


def _create_v1_database(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.executescript(
            """
            CREATE TABLE activity_windows (
                client_id TEXT NOT NULL,
                window_id TEXT NOT NULL,
                session_id TEXT NOT NULL DEFAULT '',
                seconds INTEGER NOT NULL CHECK (seconds > 0),
                timestamp TEXT NOT NULL,
                observed_from TEXT,
                observed_to TEXT,
                PRIMARY KEY (client_id, window_id, session_id)
            );
            CREATE TABLE window_sequences (
                window_id TEXT PRIMARY KEY,
                last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
            );
            CREATE TABLE pending_reports (
                client_id TEXT NOT NULL,
                window_id TEXT NOT NULL,
                sequence INTEGER NOT NULL CHECK (sequence > 0),
                seconds INTEGER NOT NULL CHECK (seconds > 0),
                timestamp TEXT NOT NULL,
                observed_from TEXT,
                observed_to TEXT,
                session_id TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (window_id, sequence)
            );
            """
        )
        # Deployed v1 never set PRAGMA user_version, so an actual v1 database is 0.
        connection.execute(
            """
            INSERT INTO pending_reports (
                client_id, window_id, sequence, seconds, timestamp,
                observed_from, observed_to, session_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, '')
            """,
            (
                CLIENT_A,
                WINDOW,
                4,
                3,
                (START + timedelta(seconds=3)).isoformat(),
                START.isoformat(),
                (START + timedelta(seconds=3)).isoformat(),
            ),
        )
        connection.execute(
            "INSERT INTO window_sequences (window_id, last_sequence) VALUES (?, ?)",
            (WINDOW, 4),
        )
        connection.execute(
            """
            INSERT INTO activity_windows (
                client_id, window_id, session_id, seconds, timestamp,
                observed_from, observed_to
            ) VALUES (?, ?, '', ?, ?, ?, ?)
            """,
            (
                CLIENT_B,
                WINDOW,
                2,
                (START + timedelta(seconds=5)).isoformat(),
                (START + timedelta(seconds=3)).isoformat(),
                (START + timedelta(seconds=5)).isoformat(),
            ),
        )
        connection.commit()
    finally:
        connection.close()


def test_outbox_creates_owner_only_sqlite_state_and_aggregates_activity(tmp_path: Path) -> None:
    path = tmp_path / "state" / "telemetry-outbox.sqlite3"
    outbox = outbox_class()(path)

    record_tick(outbox, offset=1)
    record_tick(outbox, offset=2)
    reports = outbox.prepare_reports()

    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) & 0o077 == 0
    assert len(reports) == 1
    report = reports[0]
    assert report.client_id == CLIENT_A
    assert report.window_id == WINDOW
    assert report.sequence == 1
    assert report.seconds == 2
    assert report.observed_from == START
    assert report.observed_to == START + timedelta(seconds=2)
    assert report.timestamp == START + timedelta(seconds=2)
    assert report.session_id is None


def test_pending_report_survives_reopen_with_identical_identity_and_payload(tmp_path: Path) -> None:
    path = tmp_path / "state" / "telemetry-outbox.sqlite3"
    first = outbox_class()(path)
    record_tick(first, offset=1)
    expected = first.prepare_reports()

    reopened = outbox_class()(path)
    actual = reopened.prepare_reports()

    assert actual == expected
    assert actual[0].sequence == 1


def test_pending_report_blocks_new_activity_preparation_until_ack(tmp_path: Path) -> None:
    path = tmp_path / "state" / "telemetry-outbox.sqlite3"
    outbox = outbox_class()(path)
    record_tick(outbox, client_id=CLIENT_A, offset=1)
    first = outbox.prepare_reports()

    record_tick(outbox, client_id=CLIENT_B, offset=2)
    assert outbox.prepare_reports() == first

    outbox.acknowledge(first)
    second = outbox.prepare_reports()
    assert len(second) == 1
    assert second[0].client_id == CLIENT_B
    assert second[0].sequence == 2


def test_acknowledged_report_is_removed_and_sequence_stays_monotonic_after_reopen(tmp_path: Path) -> None:
    path = tmp_path / "state" / "telemetry-outbox.sqlite3"
    outbox = outbox_class()(path)
    record_tick(outbox, offset=1)
    first = outbox.prepare_reports()
    outbox.acknowledge(first)
    assert outbox.prepare_reports() == []

    reopened = outbox_class()(path)
    record_tick(reopened, offset=2)
    second = reopened.prepare_reports()

    assert len(second) == 1
    assert second[0].sequence == 2
    assert second[0].seconds == 1


def test_multiple_clients_share_unique_monotonic_sequences_inside_same_window(tmp_path: Path) -> None:
    outbox = outbox_class()(tmp_path / "state" / "telemetry-outbox.sqlite3")
    record_tick(outbox, client_id=CLIENT_A, offset=1)
    record_tick(outbox, client_id=CLIENT_B, offset=1)

    reports = outbox.prepare_reports()

    assert [(item.client_id, item.sequence) for item in reports] == [
        (CLIENT_A, 1),
        (CLIENT_B, 2),
    ]


def test_acknowledge_rejects_report_payload_that_does_not_match_pending_row(tmp_path: Path) -> None:
    from madar_agent.models import UsageReport

    outbox = outbox_class()(tmp_path / "state" / "telemetry-outbox.sqlite3")
    record_tick(outbox, offset=1)
    pending = outbox.prepare_reports()[0]
    forged = UsageReport(
        client_id=pending.client_id,
        window_id=pending.window_id,
        sequence=pending.sequence,
        seconds=pending.seconds + 1,
        timestamp=pending.timestamp,
        observed_from=pending.observed_from,
        observed_to=pending.observed_to,
        session_id=pending.session_id,
    )

    with pytest.raises(ValueError, match="pending telemetry report mismatch"):
        outbox.acknowledge([forged])

    assert outbox.prepare_reports() == [pending]


def test_existing_symlink_or_non_regular_outbox_path_is_rejected(tmp_path: Path) -> None:
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    target = tmp_path / "target.sqlite3"
    target.write_text("do-not-touch", encoding="utf-8")
    link = state / "telemetry-outbox.sqlite3"
    link.symlink_to(target)

    with pytest.raises(ValueError, match="telemetry outbox path must be a regular file"):
        outbox_class()(link)

    assert target.read_text(encoding="utf-8") == "do-not-touch"


def test_invalid_activity_is_rejected_without_creating_report(tmp_path: Path) -> None:
    outbox = outbox_class()(tmp_path / "state" / "telemetry-outbox.sqlite3")

    with pytest.raises(ValueError):
        outbox.record_activity(
            client_id="",
            window_id=WINDOW,
            seconds=1,
            timestamp=START,
            observed_from=START,
            observed_to=START,
            session_id=None,
        )
    with pytest.raises(ValueError):
        outbox.record_activity(
            client_id=CLIENT_A,
            window_id=WINDOW,
            seconds=0,
            timestamp=START,
            observed_from=START,
            observed_to=START,
            session_id=None,
        )

    assert outbox.prepare_reports() == []


def test_v2_active_buckets_use_exact_low_60_bit_bitmap_and_are_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "state" / "telemetry-outbox.sqlite3"
    outbox = outbox_class()(path)

    record_bucket(outbox, second=0)
    record_bucket(outbox, second=0)
    record_bucket(outbox, second=59)

    reports = outbox.prepare_reports()
    assert len(reports) == 1
    assert reports[0].seconds == 2
    assert reports[0].active_seconds_hex == "0800000000000001"

    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2


def test_v2_multiple_buckets_freeze_mask_and_retry_identically_after_reopen(tmp_path: Path) -> None:
    path = tmp_path / "state" / "telemetry-outbox.sqlite3"
    outbox = outbox_class()(path)
    for second in (1, 2, 17):
        record_bucket(outbox, second=second)

    expected = outbox.prepare_reports()
    assert expected[0].seconds == 3
    assert expected[0].active_seconds_hex == "0000000000020006"

    reopened = outbox_class()(path)
    assert reopened.prepare_reports() == expected

    forged = replace(expected[0], active_seconds_hex="0000000000020002")
    with pytest.raises(ValueError, match="pending telemetry report mismatch"):
        reopened.acknowledge([forged])
    assert reopened.prepare_reports() == expected


def test_v1_pending_and_aggregate_activity_migrate_without_inventing_bitmap_seconds(tmp_path: Path) -> None:
    path = tmp_path / "state" / "telemetry-outbox.sqlite3"
    _create_v1_database(path)

    outbox = outbox_class()(path)
    pending = outbox.prepare_reports()

    assert len(pending) == 1
    assert pending[0].client_id == CLIENT_A
    assert pending[0].sequence == 4
    assert pending[0].seconds == 3
    assert pending[0].active_seconds_hex is None

    outbox.acknowledge(pending)
    legacy_activity = outbox.prepare_reports()
    assert len(legacy_activity) == 1
    assert legacy_activity[0].client_id == CLIENT_B
    assert legacy_activity[0].sequence == 5
    assert legacy_activity[0].seconds == 2
    assert legacy_activity[0].active_seconds_hex is None

    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        assert connection.execute(
            "SELECT last_sequence FROM window_sequences WHERE window_id = ?", (WINDOW,)
        ).fetchone()[0] == 5


def test_future_outbox_schema_version_fails_closed_without_mutating_database(tmp_path: Path) -> None:
    path = tmp_path / "state" / "telemetry-outbox.sqlite3"
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA user_version = 99")
        connection.execute("CREATE TABLE future_witness(value TEXT NOT NULL)")
        connection.execute("INSERT INTO future_witness(value) VALUES ('keep-me')")
        connection.commit()

    with pytest.raises(ValueError, match="unsupported telemetry outbox schema version"):
        outbox_class()(path)

    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 99
        assert connection.execute("SELECT value FROM future_witness").fetchone()[0] == "keep-me"
