from __future__ import annotations

from typing import Protocol

from .models import ManagedClient, ObservedActivity


class XrayAdapter(Protocol):
    def apply_clients(self, clients: list[ManagedClient]) -> None: ...

    def disable_managed_access(self) -> None: ...

    def collect_observed_activity(self) -> list[ObservedActivity]: ...
