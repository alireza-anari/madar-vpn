from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "release-speed-enforcer.yml"


def test_release_workflow_builds_both_static_assets_from_exact_sha() -> None:
    assert WORKFLOW.is_file(), "Phase 10 Speed Enforcer release workflow is required"
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "contents: write" in text
    assert "scripts/build-speed-enforcer.sh" in text
    assert "madar-speed-enforcer-linux-amd64" in text
    assert "madar-speed-enforcer-linux-arm64" in text
    assert "SHA256SUMS" in text
    assert "GITHUB_SHA" in text
    assert "--target" in text
    assert "latest" not in text.lower()


def test_release_workflow_refuses_moving_or_reused_release_tags() -> None:
    assert WORKFLOW.is_file(), "Phase 10 Speed Enforcer release workflow is required"
    text = WORKFLOW.read_text(encoding="utf-8")

    assert "^speed-enforcer-v[0-9]+\\.[0-9]+\\.[0-9]+$" in text
    assert "gh release view" in text or "git rev-parse" in text
    assert "gh release create" in text
    assert "workflow_dispatch" in text
    assert "release/speed-enforcer-v" in text
