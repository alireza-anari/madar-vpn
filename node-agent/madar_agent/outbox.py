from __future__ import annotations

import os
import sqlite3
import stat
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

from .models import UsageReport


_SCHEMA_VERSION = 2
_MAX_ACTIVE_MASK = (1 << 60) - 1

_SCHEMA_V2 = f"""
CREATE TABLE IF NOT EXISTS activity_windows (
    client_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    activity_kind TEXT NOT NULL CHECK (activity_kind IN ('bitmap', 'legacy')),
    session_id TEXT NOT NULL DEFAULT '',
    active_mask INTEGER,
    legacy_seconds INTEGER,
    timestamp TEXT NOT NULL,
    observed_from TEXT,
    observed_to TEXT,
    PRIMARY KEY (client_id, window_id, activity_kind, session_id),
    CHECK (
        (activity_kind = 'bitmap' AND active_mask IS NOT NULL AND active_mask > 0 AND active_mask <= {_MAX_ACTIVE_MASK} AND legacy_seconds IS NULL)
        OR
        (activity_kind = 'legacy' AND active_mask IS NULL AND legacy_seconds IS NOT NULL AND legacy_seconds > 0)
    )
);

CREATE TABLE IF NOT EXISTS window_sequences (
    window_id TEXT PRIMARY KEY,
    last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);

CREATE TABLE IF NOT EXISTS pending_reports (
    client_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    seconds INTEGER NOT NULL CHECK (seconds > 0),
    timestamp TEXT NOT NULL,
    observed_from TEXT,
    observed_to TEXT,
    session_id TEXT NOT NULL DEFAULT '',
    active_seconds_hex TEXT,
    PRIMARY KEY (window_id, sequence),
    CHECK (
        active_seconds_hex IS NULL
        OR (
            length(active_seconds_hex) = 16
            AND active_seconds_hex = lower(active_seconds_hex)
            AND active_seconds_hex GLOB '0[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
            AND active_seconds_hex <> '0000000000000000'
        )
    )
);
"""


class TelemetryOutbox:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._prepare_path()
        self._initialize_schema()

    def record_activity(
        self,
        *,
        client_id: str,
        window_id: str,
        seconds: int,
        timestamp: datetime,
        observed_from: datetime | None,
        observed_to: datetime | None,
        session_id: str | None,
    ) -> None:
        """Persist legacy aggregate activity without inventing second positions.

        This compatibility path remains for migrated state and mixed-version tests.
        New aligned activity uses record_active_bucket().
        """
        self._validate_activity(
            client_id=client_id,
            window_id=window_id,
            seconds=seconds,
            timestamp=timestamp,
            observed_from=observed_from,
            observed_to=observed_to,
        )
        session_key = session_id or ""
        with self._transaction() as connection:
            connection.execute(
                """
                INSERT INTO activity_windows (
                    client_id,
                    window_id,
                    activity_kind,
                    session_id,
                    active_mask,
                    legacy_seconds,
                    timestamp,
                    observed_from,
                    observed_to
                ) VALUES (?, ?, 'legacy', ?, NULL, ?, ?, ?, ?)
                ON CONFLICT(client_id, window_id, activity_kind, session_id) DO UPDATE SET
                    legacy_seconds = activity_windows.legacy_seconds + excluded.legacy_seconds,
                    timestamp = excluded.timestamp,
                    observed_from = CASE
                        WHEN activity_windows.observed_from IS NULL THEN excluded.observed_from
                        WHEN excluded.observed_from IS NULL THEN activity_windows.observed_from
                        WHEN excluded.observed_from < activity_windows.observed_from THEN excluded.observed_from
                        ELSE activity_windows.observed_from
                    END,
                    observed_to = CASE
                        WHEN activity_windows.observed_to IS NULL THEN excluded.observed_to
                        WHEN excluded.observed_to IS NULL THEN activity_windows.observed_to
                        WHEN excluded.observed_to > activity_windows.observed_to THEN excluded.observed_to
                        ELSE activity_windows.observed_to
                    END
                """,
                (
                    client_id,
                    window_id,
                    session_key,
                    seconds,
                    self._encode_datetime(timestamp),
                    self._encode_optional_datetime(observed_from),
                    self._encode_optional_datetime(observed_to),
                ),
            )

    def record_active_bucket(
        self,
        *,
        client_id: str,
        bucket_start: datetime,
        timestamp: datetime,
        observed_from: datetime | None,
        observed_to: datetime | None,
    ) -> None:
        if not client_id:
            raise ValueError("observed activity identity is required")
        bucket = self._aware_utc(bucket_start, "active bucket start")
        if bucket.microsecond != 0:
            raise ValueError("active bucket start must be second-aligned")
        self._require_aware(timestamp)
        if observed_from is not None:
            self._require_aware(observed_from)
        if observed_to is not None:
            self._require_aware(observed_to)
        if observed_from is not None and observed_to is not None and observed_to < observed_from:
            raise ValueError("observed activity interval is invalid")

        minute = bucket.replace(second=0, microsecond=0)
        window_id = f"xray-traffic:{minute.strftime('%Y-%m-%dT%H:%MZ')}"
        mask = 1 << bucket.second
        with self._transaction() as connection:
            connection.execute(
                """
                INSERT INTO activity_windows (
                    client_id,
                    window_id,
                    activity_kind,
                    session_id,
                    active_mask,
                    legacy_seconds,
                    timestamp,
                    observed_from,
                    observed_to
                ) VALUES (?, ?, 'bitmap', '', ?, NULL, ?, ?, ?)
                ON CONFLICT(client_id, window_id, activity_kind, session_id) DO UPDATE SET
                    active_mask = activity_windows.active_mask | excluded.active_mask,
                    timestamp = CASE
                        WHEN excluded.timestamp > activity_windows.timestamp THEN excluded.timestamp
                        ELSE activity_windows.timestamp
                    END,
                    observed_from = CASE
                        WHEN activity_windows.observed_from IS NULL THEN excluded.observed_from
                        WHEN excluded.observed_from IS NULL THEN activity_windows.observed_from
                        WHEN excluded.observed_from < activity_windows.observed_from THEN excluded.observed_from
                        ELSE activity_windows.observed_from
                    END,
                    observed_to = CASE
                        WHEN activity_windows.observed_to IS NULL THEN excluded.observed_to
                        WHEN excluded.observed_to IS NULL THEN activity_windows.observed_to
                        WHEN excluded.observed_to > activity_windows.observed_to THEN excluded.observed_to
                        ELSE activity_windows.observed_to
                    END
                """,
                (
                    client_id,
                    window_id,
                    mask,
                    self._encode_datetime(timestamp),
                    self._encode_optional_datetime(observed_from),
                    self._encode_optional_datetime(observed_to),
                ),
            )

    def prepare_reports(self) -> list[UsageReport]:
        with self._transaction() as connection:
            pending = self._read_pending(connection)
            if pending:
                return pending

            rows = connection.execute(
                """
                SELECT client_id, window_id, activity_kind, session_id,
                       active_mask, legacy_seconds, timestamp, observed_from, observed_to
                FROM activity_windows
                ORDER BY window_id, client_id, activity_kind, session_id
                """
            ).fetchall()
            if not rows:
                return []

            last_sequences: dict[str, int] = {}
            for (
                client_id,
                window_id,
                activity_kind,
                session_id,
                active_mask,
                legacy_seconds,
                timestamp,
                observed_from,
                observed_to,
            ) in rows:
                if window_id not in last_sequences:
                    row = connection.execute(
                        "SELECT last_sequence FROM window_sequences WHERE window_id = ?",
                        (window_id,),
                    ).fetchone()
                    last_sequences[window_id] = int(row[0]) if row is not None else 0
                sequence = last_sequences[window_id] + 1
                last_sequences[window_id] = sequence

                if activity_kind == "bitmap":
                    mask = int(active_mask)
                    seconds = mask.bit_count()
                    active_seconds_hex = f"{mask:016x}"
                else:
                    seconds = int(legacy_seconds)
                    active_seconds_hex = None

                connection.execute(
                    """
                    INSERT INTO pending_reports (
                        client_id,
                        window_id,
                        sequence,
                        seconds,
                        timestamp,
                        observed_from,
                        observed_to,
                        session_id,
                        active_seconds_hex
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        client_id,
                        window_id,
                        sequence,
                        seconds,
                        timestamp,
                        observed_from,
                        observed_to,
                        session_id,
                        active_seconds_hex,
                    ),
                )

            for window_id, sequence in last_sequences.items():
                connection.execute(
                    """
                    INSERT INTO window_sequences (window_id, last_sequence)
                    VALUES (?, ?)
                    ON CONFLICT(window_id) DO UPDATE SET last_sequence = excluded.last_sequence
                    """,
                    (window_id, sequence),
                )
            connection.execute("DELETE FROM activity_windows")
            return self._read_pending(connection)

    def acknowledge(self, reports: Iterable[UsageReport]) -> None:
        report_list = list(reports)
        if not report_list:
            return
        with self._transaction() as connection:
            for report in report_list:
                row = connection.execute(
                    """
                    SELECT client_id, window_id, sequence, seconds, timestamp,
                           observed_from, observed_to, session_id, active_seconds_hex
                    FROM pending_reports
                    WHERE window_id = ? AND sequence = ?
                    """,
                    (report.window_id, report.sequence),
                ).fetchone()
                expected = self._report_storage_tuple(report)
                if row is None or tuple(row) != expected:
                    raise ValueError("pending telemetry report mismatch")
                connection.execute(
                    "DELETE FROM pending_reports WHERE window_id = ? AND sequence = ?",
                    (report.window_id, report.sequence),
                )

    def _initialize_schema(self) -> None:
        connection = self._connect()
        try:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if version > _SCHEMA_VERSION:
                raise ValueError("unsupported telemetry outbox schema version")
            if version == _SCHEMA_VERSION:
                return
            if version not in (0, 1):
                raise ValueError("unsupported telemetry outbox schema version")

            tables = {
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            }
            known = {"activity_windows", "window_sequences", "pending_reports"}
            if not tables:
                connection.executescript(_SCHEMA_V2)
                connection.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
                connection.commit()
                return

            if not known.issubset(tables):
                raise ValueError("unsupported telemetry outbox schema version")

            columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(activity_windows)").fetchall()
            }
            if {"activity_kind", "active_mask", "legacy_seconds"}.issubset(columns):
                # A v2-shaped database with a lost/zero version marker is unsafe to
                # reinterpret automatically; require an explicit repair instead.
                raise ValueError("unsupported telemetry outbox schema version")

            self._migrate_v1_to_v2(connection)
        finally:
            connection.close()

    @staticmethod
    def _migrate_v1_to_v2(connection: sqlite3.Connection) -> None:
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute("ALTER TABLE activity_windows RENAME TO activity_windows_v1")
            connection.execute("ALTER TABLE pending_reports RENAME TO pending_reports_v1")
            connection.executescript(_SCHEMA_V2)

            connection.execute(
                """
                INSERT INTO pending_reports (
                    client_id, window_id, sequence, seconds, timestamp,
                    observed_from, observed_to, session_id, active_seconds_hex
                )
                SELECT client_id, window_id, sequence, seconds, timestamp,
                       observed_from, observed_to, session_id, NULL
                FROM pending_reports_v1
                """
            )
            connection.execute(
                """
                INSERT INTO activity_windows (
                    client_id, window_id, activity_kind, session_id,
                    active_mask, legacy_seconds, timestamp, observed_from, observed_to
                )
                SELECT client_id, window_id, 'legacy', session_id,
                       NULL, seconds, timestamp, observed_from, observed_to
                FROM activity_windows_v1
                """
            )
            connection.execute("DROP TABLE pending_reports_v1")
            connection.execute("DROP TABLE activity_windows_v1")
            connection.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
            connection.commit()
        except Exception:
            connection.rollback()
            raise

    def _prepare_path(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path.parent.chmod(0o700)

        try:
            metadata = self.path.lstat()
        except FileNotFoundError:
            flags = os.O_RDWR | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(self.path, flags, 0o600)
            os.close(descriptor)
        else:
            if not stat.S_ISREG(metadata.st_mode) or self.path.is_symlink():
                raise ValueError("telemetry outbox path must be a regular file")
        self.path.chmod(0o600)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def _transaction(self):
        return _ImmediateTransaction(self._connect())

    @staticmethod
    def _read_pending(connection: sqlite3.Connection) -> list[UsageReport]:
        rows = connection.execute(
            """
            SELECT client_id, window_id, sequence, seconds, timestamp,
                   observed_from, observed_to, session_id, active_seconds_hex
            FROM pending_reports
            ORDER BY window_id, sequence
            """
        ).fetchall()
        return [
            UsageReport(
                client_id=client_id,
                window_id=window_id,
                sequence=int(sequence),
                seconds=int(seconds),
                timestamp=TelemetryOutbox._decode_datetime(timestamp),
                observed_from=TelemetryOutbox._decode_optional_datetime(observed_from),
                observed_to=TelemetryOutbox._decode_optional_datetime(observed_to),
                session_id=session_id or None,
                active_seconds_hex=active_seconds_hex,
            )
            for (
                client_id,
                window_id,
                sequence,
                seconds,
                timestamp,
                observed_from,
                observed_to,
                session_id,
                active_seconds_hex,
            ) in rows
        ]

    @staticmethod
    def _report_storage_tuple(report: UsageReport) -> tuple[object, ...]:
        return (
            report.client_id,
            report.window_id,
            report.sequence,
            report.seconds,
            TelemetryOutbox._encode_datetime(report.timestamp),
            TelemetryOutbox._encode_optional_datetime(report.observed_from),
            TelemetryOutbox._encode_optional_datetime(report.observed_to),
            report.session_id or "",
            report.active_seconds_hex,
        )

    @staticmethod
    def _validate_activity(
        *,
        client_id: str,
        window_id: str,
        seconds: int,
        timestamp: datetime,
        observed_from: datetime | None,
        observed_to: datetime | None,
    ) -> None:
        if not client_id or not window_id:
            raise ValueError("observed activity identity is required")
        if seconds <= 0 or seconds > 86_400:
            raise ValueError("observed activity seconds are out of range")
        TelemetryOutbox._require_aware(timestamp)
        if observed_from is not None:
            TelemetryOutbox._require_aware(observed_from)
        if observed_to is not None:
            TelemetryOutbox._require_aware(observed_to)
        if observed_from is not None and observed_to is not None and observed_to < observed_from:
            raise ValueError("observed activity interval is invalid")

    @staticmethod
    def _aware_utc(value: datetime, label: str) -> datetime:
        TelemetryOutbox._require_aware(value)
        return value.astimezone(UTC)

    @staticmethod
    def _require_aware(value: datetime) -> None:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("telemetry timestamps must be timezone-aware")

    @staticmethod
    def _encode_datetime(value: datetime) -> str:
        TelemetryOutbox._require_aware(value)
        return value.isoformat()

    @staticmethod
    def _encode_optional_datetime(value: datetime | None) -> str | None:
        if value is None:
            return None
        return TelemetryOutbox._encode_datetime(value)

    @staticmethod
    def _decode_datetime(value: str) -> datetime:
        parsed = datetime.fromisoformat(value)
        TelemetryOutbox._require_aware(parsed)
        return parsed

    @staticmethod
    def _decode_optional_datetime(value: str | None) -> datetime | None:
        if value is None:
            return None
        return TelemetryOutbox._decode_datetime(value)


class _ImmediateTransaction:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def __enter__(self) -> sqlite3.Connection:
        self.connection.execute("BEGIN IMMEDIATE")
        return self.connection

    def __exit__(self, exc_type, exc, traceback) -> bool:
        try:
            if exc_type is None:
                self.connection.commit()
            else:
                self.connection.rollback()
        finally:
            self.connection.close()
        return False
