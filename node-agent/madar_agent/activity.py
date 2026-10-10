from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
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


def _aware_utc(value: datetime, label: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{label} must be timezone-aware")
    return value.astimezone(UTC)


def next_utc_second_boundary(value: datetime) -> datetime:
    current = _aware_utc(value, "activity clock")
    return current.replace(microsecond=0) + timedelta(seconds=1)


class XrayTrafficActivitySource:
    def __init__(
        self,
        *,
        read_counters: Callable[[], dict[str, UserTrafficCounters]],
        now: Callable[[], datetime],
        max_gap_seconds: float = 2.5,
        max_post_boundary_skew_seconds: float = 0.75,
        record_activity: Callable[..., None] | None = None,
        record_active_bucket: Callable[..., None] | None = None,
    ) -> None:
        if max_gap_seconds <= 0:
            raise ValueError("max_gap_seconds must be positive")
        if max_post_boundary_skew_seconds <= 0:
            raise ValueError("max_post_boundary_skew_seconds must be positive")
        self._read_counters = read_counters
        self._now = now
        self._max_gap_seconds = max_gap_seconds
        self._max_post_boundary_skew_seconds = max_post_boundary_skew_seconds
        self._record_activity = record_activity
        self._record_active_bucket = record_active_bucket
        self._lock = Lock()
        self._previous_counters: dict[str, UserTrafficCounters] | None = None
        self._previous_at: datetime | None = None
        self._previous_bucket_end: datetime | None = None
        self._pending: dict[tuple[str, str], _PendingActivity] = {}

    def sample(self, *, bucket_end: datetime | None = None) -> None:
        scheduled = bucket_end is not None
        canonical_bucket_end: datetime | None = None
        if bucket_end is not None:
            canonical_bucket_end = _aware_utc(bucket_end, "activity bucket end")
            if canonical_bucket_end.microsecond != 0:
                raise ValueError("activity bucket end must be second-aligned")

        try:
            counters = dict(self._read_counters())
        except Exception:
            self.invalidate()
            raise

        observed_at = _aware_utc(self._now(), "activity observation time")

        if canonical_bucket_end is not None:
            skew = (observed_at - canonical_bucket_end).total_seconds()
            if skew < 0 or skew > self._max_post_boundary_skew_seconds:
                self.invalidate()
                return

        with self._lock:
            previous = self._previous_counters
            previous_at = self._previous_at
            previous_bucket_end = self._previous_bucket_end

            self._previous_counters = counters
            self._previous_at = observed_at
            self._previous_bucket_end = canonical_bucket_end

            if previous is None or previous_at is None:
                return

            if scheduled:
                if previous_bucket_end is None or canonical_bucket_end is None:
                    return
                if canonical_bucket_end - previous_bucket_end != timedelta(seconds=1):
                    return
                if observed_at <= previous_at:
                    return
            else:
                elapsed = (observed_at - previous_at).total_seconds()
                if elapsed <= 0 or elapsed > self._max_gap_seconds:
                    return

            try:
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
                        bucket_end=canonical_bucket_end if scheduled else observed_at,
                        observed_from=previous_at,
                        observed_to=observed_at,
                        scheduled=scheduled,
                    )
            except Exception:
                # A failed durable write makes this interval ambiguous. Break the
                # counter baseline so the next sample is baseline-only rather than
                # risking a duplicate or invented second on retry.
                self._previous_counters = None
                self._previous_at = None
                self._previous_bucket_end = None
                raise

    def invalidate(self) -> None:
        with self._lock:
            self._previous_counters = None
            self._previous_at = None
            self._previous_bucket_end = None

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
        bucket_end: datetime,
        observed_from: datetime,
        observed_to: datetime,
        scheduled: bool,
    ) -> None:
        bucket_start = bucket_end - timedelta(seconds=1) if scheduled else observed_to
        window_id = self._window_id(bucket_start)
        timestamp = bucket_end if scheduled else observed_to

        if scheduled and self._record_active_bucket is not None:
            self._record_active_bucket(
                client_id=client_id,
                bucket_start=bucket_start,
                timestamp=timestamp,
                observed_from=observed_from,
                observed_to=observed_to,
            )
            return

        if self._record_activity is not None:
            self._record_activity(
                client_id=client_id,
                window_id=window_id,
                seconds=1,
                timestamp=timestamp,
                observed_from=observed_from,
                observed_to=observed_to,
                session_id=None,
            )
            return

        key = (client_id, window_id)
        current = self._pending.get(key)
        if current is None:
            self._pending[key] = _PendingActivity(
                client_id=client_id,
                window_id=window_id,
                seconds=1,
                timestamp=timestamp,
                observed_from=observed_from,
                observed_to=observed_to,
            )
            return

        current.seconds += 1
        current.timestamp = timestamp
        current.observed_to = observed_to

    @staticmethod
    def _window_id(value: datetime) -> str:
        minute = value.astimezone(UTC).replace(second=0, microsecond=0)
        return f"xray-traffic:{minute.strftime('%Y-%m-%dT%H:%MZ')}"
