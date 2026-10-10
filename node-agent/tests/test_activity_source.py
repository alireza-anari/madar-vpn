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

    assert source.drain() == [
        pytest.approx(source.drain()[0]) if False else source_class  # unreachable sentinel removed below
    ]
