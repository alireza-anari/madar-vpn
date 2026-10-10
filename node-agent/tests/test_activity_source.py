from __future__ import annotations

import importlib
from datetime import UTC, datetime, timedelta
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.models import UserTrafficCounters


START = datetime(2026, 10, 10, 7, 0, 0, tzinfo=UTC)
CLIENT_A = "27848739-7e62-4138-9fd3-098a63964b6b"
CLIENT_B = "50848739-7e62-4138-9fd3-098a63964b6b"
WINDOW = "xray-traffic:2026-10-10T07:00Z"


def source_class():
    try:
        module = importlib.import_module("madar_agent.activity")
    except ModuleNotFoundError:
        pytest.fail("madar_agent.activity must implement XrayTrafficActivitySource")
    cls = getattr(module, "XrayTrafficActivitySource", None)
    assert cls is not None, "madar_agent.activity must expose XrayTrafficActivitySource"
    return cls


class SequenceReader:
    def __init__(self, snapshots: list[dict[str, UserTrafficCounters]]) -> None:
        self._snapshots = iter(snapshots)

    def __call__(self) -> dict[str, UserTrafficCounters]:
        return next(self._snapshots)


class SequenceClock:
    def __init__(self, instants: list[datetime]) -> None:
        self._instants = iter(instants)

    def __call__(self) -> datetime:
        return next(self._instants)


def counters(uplink: int, downlink: int) -> UserTrafficCounters:
    return UserTrafficCounters(uplink_bytes=uplink, downlink_bytes=downlink)


def test_first_sample_establishes_baseline_without_inventing_usage() -> None:
    source = source_class()(
        read_counters=SequenceReader([{CLIENT_A: counters(100, 200)}]),
        now=SequenceClock([START]),
    )

    source.sample()

    assert source.drain() == []


def test_byte_delta_counts_one_observed_second_but_idle_delta_counts_zero() -> None:
    source = source_class()(
        read_counters=SequenceReader(
            [
                {CLIENT_A: counters(100, 200)},
                {CLIENT_A: counters(150, 200)},
                {CLIENT_A: counters(150, 200)},
            ]
        ),
        now=SequenceClock([START, START + timedelta(seconds=1), START + timedelta(seconds=2)]),
    )

    source.sample()
    source.sample()
    source.sample()
    observed = source.drain()

    assert len(observed) == 1
    activity = observed[0]
    assert activity.client_id == CLIENT_A
    assert activity.window_id == WINDOW
    assert activity.seconds == 1
    assert activity.observed_from == START
    assert activity.observed_to == START + timedelta(seconds=1)
    assert activity.timestamp == START + timedelta(seconds=1)
    assert activity.session_id is None


def test_adjacent_active_samples_aggregate_within_the_same_utc_minute_window() -> None:
    source = source_class()(
        read_counters=SequenceReader(
            [
                {CLIENT_A: counters(0, 0)},
                {CLIENT_A: counters(1, 0)},
                {CLIENT_A: counters(1, 7)},
            ]
        ),
        now=SequenceClock([START, START + timedelta(seconds=1), START + timedelta(seconds=2)]),
    )

    source.sample()
    source.sample()
    source.sample()
    observed = source.drain()

    assert len(observed) == 1
    assert observed[0].client_id == CLIENT_A
    assert observed[0].window_id == WINDOW
    assert observed[0].seconds == 2
    assert observed[0].observed_from == START
    assert observed[0].observed_to == START + timedelta(seconds=2)
    assert observed[0].timestamp == START + timedelta(seconds=2)


def test_counter_reset_rebaselines_without_charging_the_reset_interval() -> None:
    source = source_class()(
        read_counters=SequenceReader(
            [
                {CLIENT_A: counters(100, 100)},
                {CLIENT_A: counters(20, 10)},
                {CLIENT_A: counters(30, 10)},
            ]
        ),
        now=SequenceClock([START, START + timedelta(seconds=1), START + timedelta(seconds=2)]),
    )

    source.sample()
    source.sample()
    assert source.drain() == []

    source.sample()
    observed = source.drain()
    assert len(observed) == 1
    assert observed[0].seconds == 1
    assert observed[0].observed_from == START + timedelta(seconds=1)
    assert observed[0].observed_to == START + timedelta(seconds=2)


def test_sampling_gap_rebaselines_instead_of_inventing_seconds_across_gap() -> None:
    source = source_class()(
        read_counters=SequenceReader(
            [
                {CLIENT_A: counters(0, 0)},
                {CLIENT_A: counters(900, 0)},
                {CLIENT_A: counters(901, 0)},
            ]
        ),
        now=SequenceClock([START, START + timedelta(seconds=4), START + timedelta(seconds=5)]),
        max_gap_seconds=2.5,
    )

    source.sample()
    source.sample()
    assert source.drain() == []

    source.sample()
    observed = source.drain()
    assert len(observed) == 1
    assert observed[0].seconds == 1
    assert observed[0].observed_from == START + timedelta(seconds=4)
    assert observed[0].observed_to == START + timedelta(seconds=5)


def test_multiple_clients_are_observed_independently() -> None:
    source = source_class()(
        read_counters=SequenceReader(
            [
                {CLIENT_A: counters(1, 1), CLIENT_B: counters(5, 5)},
                {CLIENT_A: counters(2, 1), CLIENT_B: counters(5, 5)},
                {CLIENT_A: counters(2, 1), CLIENT_B: counters(5, 9)},
            ]
        ),
        now=SequenceClock([START, START + timedelta(seconds=1), START + timedelta(seconds=2)]),
    )

    source.sample()
    source.sample()
    source.sample()
    observed = source.drain()

    assert [(item.client_id, item.seconds) for item in observed] == [
        (CLIENT_A, 1),
        (CLIENT_B, 1),
    ]


def test_invalidate_breaks_continuity_but_keeps_already_observed_pending_activity() -> None:
    source = source_class()(
        read_counters=SequenceReader(
            [
                {CLIENT_A: counters(0, 0)},
                {CLIENT_A: counters(1, 0)},
                {CLIENT_A: counters(100, 0)},
                {CLIENT_A: counters(101, 0)},
            ]
        ),
        now=SequenceClock(
            [
                START,
                START + timedelta(seconds=1),
                START + timedelta(seconds=3),
                START + timedelta(seconds=4),
            ]
        ),
    )

    source.sample()
    source.sample()
    source.invalidate()
    source.sample()
    source.sample()
    observed = source.drain()

    assert len(observed) == 1
    assert observed[0].seconds == 2
    assert observed[0].observed_from == START
    assert observed[0].observed_to == START + timedelta(seconds=4)


def test_drain_is_destructive_and_later_activity_in_same_window_is_incremental() -> None:
    source = source_class()(
        read_counters=SequenceReader(
            [
                {CLIENT_A: counters(0, 0)},
                {CLIENT_A: counters(1, 0)},
                {CLIENT_A: counters(2, 0)},
            ]
        ),
        now=SequenceClock([START, START + timedelta(seconds=1), START + timedelta(seconds=2)]),
    )

    source.sample()
    source.sample()
    first = source.drain()
    assert len(first) == 1
    assert first[0].seconds == 1
    assert source.drain() == []

    source.sample()
    second = source.drain()
    assert len(second) == 1
    assert second[0].window_id == first[0].window_id == WINDOW
    assert second[0].seconds == 1
