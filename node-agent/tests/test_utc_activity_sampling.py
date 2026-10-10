from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.activity import XrayTrafficActivitySource, next_utc_second_boundary
from madar_agent.models import UserTrafficCounters
from madar_agent.service import ActivitySamplerWorker


START = datetime(2026, 10, 10, 12, 0, 0, tzinfo=UTC)
CLIENT = "27848739-7e62-4138-9fd3-098a63964b6b"


def counters(up: int, down: int = 0) -> UserTrafficCounters:
    return UserTrafficCounters(uplink_bytes=up, downlink_bytes=down)


class SequenceReader:
    def __init__(self, snapshots: list[dict[str, UserTrafficCounters] | Exception]) -> None:
        self._snapshots = iter(snapshots)

    def __call__(self) -> dict[str, UserTrafficCounters]:
        value = next(self._snapshots)
        if isinstance(value, Exception):
            raise value
        return value


class SequenceClock:
    def __init__(self, instants: list[datetime]) -> None:
        self._instants = iter(instants)

    def __call__(self) -> datetime:
        return next(self._instants)


def test_next_utc_second_boundary_never_reuses_current_boundary() -> None:
    assert next_utc_second_boundary(START + timedelta(milliseconds=123)) == START + timedelta(seconds=1)
    assert next_utc_second_boundary(START + timedelta(seconds=1)) == START + timedelta(seconds=2)
    with pytest.raises(ValueError, match="timezone-aware"):
        next_utc_second_boundary(datetime(2026, 10, 10, 12, 0, 0))


def test_positive_delta_maps_to_exact_preceding_scheduled_bucket() -> None:
    recorded: list[dict[str, object]] = []
    source = XrayTrafficActivitySource(
        read_counters=SequenceReader([
            {CLIENT: counters(100)},
            {CLIENT: counters(101)},
            {CLIENT: counters(101)},
        ]),
        now=SequenceClock([
            START + timedelta(seconds=1, milliseconds=50),
            START + timedelta(seconds=2, milliseconds=40),
            START + timedelta(seconds=3, milliseconds=30),
        ]),
        record_activity=lambda **payload: recorded.append(payload),
    )

    source.sample(bucket_end=START + timedelta(seconds=1))
    source.sample(bucket_end=START + timedelta(seconds=2))
    source.sample(bucket_end=START + timedelta(seconds=3))

    assert len(recorded) == 1
    tick = recorded[0]
    assert tick["window_id"] == "xray-traffic:2026-10-10T12:00Z"
    assert tick["seconds"] == 1
    assert tick["timestamp"] == START + timedelta(seconds=2)
    assert tick["observed_from"] == START + timedelta(seconds=1, milliseconds=50)
    assert tick["observed_to"] == START + timedelta(seconds=2, milliseconds=40)


def test_minute_boundary_assigns_second_59_to_previous_utc_minute() -> None:
    base = START.replace(second=58)
    recorded: list[dict[str, object]] = []
    source = XrayTrafficActivitySource(
        read_counters=SequenceReader([
            {CLIENT: counters(0)},
            {CLIENT: counters(1)},
        ]),
        now=SequenceClock([
            base + timedelta(seconds=1, milliseconds=10),
            base + timedelta(seconds=2, milliseconds=10),
        ]),
        record_activity=lambda **payload: recorded.append(payload),
    )

    source.sample(bucket_end=base + timedelta(seconds=1))
    source.sample(bucket_end=base + timedelta(seconds=2))

    assert recorded[0]["window_id"] == "xray-traffic:2026-10-10T12:00Z"
    assert recorded[0]["timestamp"] == START.replace(minute=1, second=0)


def test_gap_late_wake_reset_and_query_failure_never_infer_ambiguous_seconds() -> None:
    recorded: list[dict[str, object]] = []
    source = XrayTrafficActivitySource(
        read_counters=SequenceReader([
            {CLIENT: counters(0)},
            {CLIENT: counters(10)},
            {CLIENT: counters(11)},
            {CLIENT: counters(5)},
            OSError("stats unavailable"),
            {CLIENT: counters(20)},
            {CLIENT: counters(21)},
        ]),
        # A failed counter query returns before the observation clock is read, so
        # there is intentionally no clock instant for the failing query itself.
        now=SequenceClock([
            START + timedelta(seconds=1, milliseconds=10),
            START + timedelta(seconds=4, milliseconds=10),
            START + timedelta(seconds=5, milliseconds=900),
            START + timedelta(seconds=6, milliseconds=10),
            START + timedelta(seconds=8, milliseconds=10),
            START + timedelta(seconds=9, milliseconds=10),
        ]),
        record_activity=lambda **payload: recorded.append(payload),
        max_post_boundary_skew_seconds=0.75,
    )

    source.sample(bucket_end=START + timedelta(seconds=1))
    source.sample(bucket_end=START + timedelta(seconds=4))  # missed boundaries: baseline only
    source.sample(bucket_end=START + timedelta(seconds=5))  # 0.9s late: continuity breaks
    source.sample(bucket_end=START + timedelta(seconds=6))  # baseline only after late wake
    with pytest.raises(OSError, match="stats unavailable"):
        source.sample(bucket_end=START + timedelta(seconds=7))
    source.sample(bucket_end=START + timedelta(seconds=8))  # baseline only after query failure
    source.sample(bucket_end=START + timedelta(seconds=9))

    assert len(recorded) == 1
    assert recorded[0]["timestamp"] == START + timedelta(seconds=9)


def test_worker_recomputes_wall_clock_boundary_and_skips_missed_buckets() -> None:
    class Clock:
        def __init__(self) -> None:
            self.value = START + timedelta(milliseconds=123)

        def __call__(self) -> datetime:
            return self.value

    class Source:
        def __init__(self, clock: Clock) -> None:
            self.clock = clock
            self.buckets: list[datetime] = []

        def sample(self, *, bucket_end: datetime) -> None:
            self.buckets.append(bucket_end)
            if len(self.buckets) == 1:
                self.clock.value += timedelta(seconds=2.4)

        def invalidate(self) -> None:
            raise AssertionError("worker must not invalidate a successful sample")

    class Stop:
        def __init__(self, clock: Clock) -> None:
            self.clock = clock
            self.waits = 0

        def is_set(self) -> bool:
            return False

        def wait(self, seconds: float) -> bool:
            self.waits += 1
            if self.waits == 3:
                return True
            self.clock.value += timedelta(seconds=seconds)
            return False

        def set(self) -> None:
            pass

    clock = Clock()
    source = Source(clock)
    worker = ActivitySamplerWorker(source=source, now=clock)
    worker._stop = Stop(clock)  # deterministic direct-loop test; no background thread

    worker._run()

    assert source.buckets == [
        START + timedelta(seconds=1),
        START + timedelta(seconds=4),
    ]
