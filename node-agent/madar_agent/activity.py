from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock

from .models import ObservedActivity, UserTrafficCounters


@dataclass(slots=True)
class _PendingActivity:
    client_id: str
    window_id: str
    seconds: int
    timestamp: datetime
    observed_from: datetime
    observed_to: datetime


class XrayTrafficActivitySource:
    def __init__(
        self,
        *,
        read_counters: Callable[[], dict[str, UserTrafficCounters]],
        now: Callable[[], datetime],
        max_gap_seconds: float = 2.5,
    ) -> None:
        if max_gap_seconds <= 0:
            raise ValueError("max_gap_seconds must be positive")
        self._read_counters = read_counters
        self._now = now
        self._max_gap_seconds = max_gap_seconds
        self._lock = Lock()
        self._previous_counters: dict[str, UserTrafficCounters] | None = None
        self._previous_at: datetime | None = None
        self._pending: dict[tuple[str, str], _PendingActivity] = {}

    def sample(self) -> None:
        counters = dict(self._read_counters())
        observed_at = self._now()
        if observed_at.tzinfo is None or observed_at.utcoffset() is None:
            raise ValueError("activity observation time must be timezone-aware")

        with self._lock:
            previous = self._previous_counters
            previous_at = self._previous_at
            self._previous_counters = counters
            self._previous_at = observed_at

            if previous is None or previous_at is None:
                return

            elapsed = (observed_at - previous_at).total_seconds()
            if elapsed <= 0 or elapsed > self._max_gap_seconds:
                return

            for client_id, current in counters.items():
                prior = previous.get(client_id)
                if prior is None:
                    continue
                if (
                    current.uplink_bytes < prior.uplink_bytes
                    or current.downlink_bytes < prior.downlink_bytes
                ):
                    continue
                if (
                    current.uplink_bytes == prior.uplink_bytes
                    and current.downlink_bytes == prior.downlink_bytes
                ):
                    continue
                self._record_active_tick(
                    client_id=client_id,
                    observed_from=previous_at,
                    observed_to=observed_at,
                )

    def invalidate(self) -> None:
        with self._lock:
            self._previous_counters = None
            self._previous_at = None

    def drain(self) -> list[ObservedActivity]:
        with self._lock:
            pending = sorted(
                self._pending.values(),
                key=lambda item: (item.client_id, item.window_id),
            )
            self._pending = {}

        return [
            ObservedActivity(
                client_id=item.client_id,
                window_id=item.window_id,
                seconds=item.seconds,
                timestamp=item.timestamp,
                observed_from=item.observed_from,
                observed_to=item.observed_to,
                session_id=None,
            )
            for item in pending
        ]

    def _record_active_tick(
        self,
        *,
        client_id: str,
        observed_from: datetime,
        observed_to: datetime,
    ) -> None:
        window_id = self._window_id(observed_to)
        key = (client_id, window_id)
        current = self._pending.get(key)
        if current is None:
            self._pending[key] = _PendingActivity(
                client_id=client_id,
                window_id=window_id,
                seconds=1,
                timestamp=observed_to,
                observed_from=observed_from,
                observed_to=observed_to,
            )
            return

        current.seconds += 1
        current.timestamp = observed_to
        current.observed_to = observed_to

    @staticmethod
    def _window_id(value: datetime) -> str:
        minute = value.astimezone(UTC).replace(second=0, microsecond=0)
        return f"xray-traffic:{minute.strftime('%Y-%m-%dT%H:%MZ')}"
