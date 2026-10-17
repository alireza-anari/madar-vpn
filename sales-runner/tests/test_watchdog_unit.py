from pathlib import Path


def test_one_second_watchdog_timer_is_not_systemd_rate_limited():
    unit = (Path(__file__).parents[1] / "templates" / "madar-sales-watchdog.service").read_text()
    assert "StartLimitIntervalSec=0" in unit


def test_node_service_gives_agent_time_to_checkpoint_children_on_sigterm():
    unit = (Path(__file__).parents[1] / "templates" / "madar-sales-node.service").read_text()
    assert "KillMode=mixed" in unit
