from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, TypeVar


T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 3
    base_delay_seconds: float = 0.5
    max_delay_seconds: float = 4.0

    def __post_init__(self) -> None:
        if self.max_attempts < 1 or self.max_attempts > 10:
            raise ValueError("max_attempts must be between 1 and 10")
        if self.base_delay_seconds < 0:
            raise ValueError("base_delay_seconds must not be negative")
        if self.max_delay_seconds < self.base_delay_seconds:
            raise ValueError("max_delay_seconds must be at least base_delay_seconds")


class RetryExhausted(RuntimeError):
    pass


def run_with_retry(
    operation: Callable[[], T],
    *,
    policy: RetryPolicy,
    retryable: Callable[[BaseException], bool],
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    delay = policy.base_delay_seconds
    for attempt in range(1, policy.max_attempts + 1):
        try:
            return operation()
        except BaseException as error:
            if not retryable(error):
                raise
            if attempt >= policy.max_attempts:
                raise RetryExhausted("retry budget exhausted") from error
            sleep(min(delay, policy.max_delay_seconds))
            delay = min(delay * 2, policy.max_delay_seconds)
    raise AssertionError("retry loop exited unexpectedly")
