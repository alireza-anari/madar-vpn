from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.retry import RetryExhausted, RetryPolicy, run_with_retry


class TransientError(RuntimeError):
    pass


def test_retry_is_bounded_and_backoff_is_capped() -> None:
    attempts = 0
    sleeps: list[float] = []

    def operation() -> str:
        nonlocal attempts
        attempts += 1
        raise TransientError("temporary")

    with pytest.raises(RetryExhausted) as raised:
        run_with_retry(
            operation,
            policy=RetryPolicy(max_attempts=4, base_delay_seconds=0.25, max_delay_seconds=0.5),
            retryable=lambda error: isinstance(error, TransientError),
            sleep=sleeps.append,
        )

    assert attempts == 4
    assert sleeps == [0.25, 0.5, 0.5]
    assert isinstance(raised.value.__cause__, TransientError)


def test_non_retryable_error_fails_without_sleeping() -> None:
    sleeps: list[float] = []

    with pytest.raises(ValueError, match="bad request"):
        run_with_retry(
            lambda: (_ for _ in ()).throw(ValueError("bad request")),
            policy=RetryPolicy(max_attempts=5, base_delay_seconds=1, max_delay_seconds=4),
            retryable=lambda error: isinstance(error, TransientError),
            sleep=sleeps.append,
        )

    assert sleeps == []
