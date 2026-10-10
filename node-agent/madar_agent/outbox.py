from __future__ import annotations

import os
import sqlite3
import stat
from datetime import datetime
from pathlib import Path
from typing import Iterable

from .models import UsageReport


_SCHEMA = """
CREATE TABLE IF NOT EXISTS activity_windows (
    client_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    seconds INTEGER NOT NULL CHECK (seconds > 0),
    timestamp TEXT NOT NULL,
    observed_from TEXT,
    observed_to TEXT,
    PRIMARY KEY (client_id, window_id, session_id)
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
    PRIMARY KEY (window_id, sequence)
);
"""


class TelemetryOutbox:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._prepare_path()
        with self._connect() as connection:
            connection.executescript(_SCHEMA)

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
                    session_id,
                    seconds,
                    timestamp,
                    observed_from,
                    observed_to
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(client_id, window_id, session_id) DO UPDATE SET
                    seconds = activity_windows.seconds + excluded.seconds,
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

    def prepare_reports(self) -> list[UsageReport]:
        with self._transaction() as connection:
            pending = self._read_pending(connection)
            if pending:
                return pending

            rows = connection.execute(
                """
                SELECT client_id, window_id, session_id, seconds, timestamp, observed_from, observed_to
                FROM activity_windows
                ORDER BY window_id, client_id, session_id
                """
            ).fetchall()
            if not rows:
                return []

            last_sequences: dict[str, int] = {}
            for (
                client_id,
                window_id,
                session_id,
                seconds,
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
                        session_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
                           observed_from, observed_to, session_id
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
                   observed_from, observed_to, session_id
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
