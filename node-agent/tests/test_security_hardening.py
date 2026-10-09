from __future__ import annotations

import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def load_security_scan_module():
    path = ROOT / "scripts" / "security_scan.py"
    assert path.exists(), "repository secret scanner is required"
    spec = importlib.util.spec_from_file_location("madar_security_scan", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_redactor():
    path = ROOT / "node-agent" / "madar_agent" / "redaction.py"
    assert path.exists(), "node-agent log redactor is required"
    spec = importlib.util.spec_from_file_location("madar_redaction", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.redact_text


def test_repository_scanner_detects_secret_material_without_echoing_values(tmp_path: Path) -> None:
    scanner = load_security_scan_module()
    token = "gh" + "p_" + "A" * 40
    private_key = "-----BEGIN " + "PRIVATE KEY-----\n" + "A" * 64 + "\n-----END PRIVATE KEY-----"
    candidate = tmp_path / "candidate.txt"
    candidate.write_text(f"TOKEN={token}\n{private_key}\n", encoding="utf-8")

    findings = scanner.scan_repository(tmp_path)

    assert {finding.rule for finding in findings} >= {"credential-prefix", "private-key"}
    rendered = "\n".join(scanner.format_finding(finding) for finding in findings)
    assert token not in rendered
    assert "A" * 32 not in rendered


def test_repository_scanner_allows_documented_placeholders() -> None:
    scanner = load_security_scan_module()
    findings = scanner.scan_text(
        "VAPID_PRIVATE_KEY=<set-as-worker-secret>\nPAYMENT_API_KEY=changeme-in-production\n",
        path=Path(".env.example"),
    )
    assert findings == []


def test_log_redaction_masks_bearer_subscription_and_named_secret_values() -> None:
    redact_text = load_redactor()
    bearer = "node-" + "credential-" + "A" * 24
    subscription = "subscription-" + "B" * 32
    enrollment = "enrollment-" + "C" * 24
    private_key = "private-" + "D" * 32
    message = (
        f"Authorization: Bearer {bearer} "
        f"url=https://example.invalid/s/{subscription} "
        f"enrollmentToken={enrollment} privateKey={private_key}"
    )

    redacted = redact_text(message)

    for secret in (bearer, subscription, enrollment, private_key):
        assert secret not in redacted
    assert redacted.count("[REDACTED]") >= 4


def test_worker_disables_persistent_invocation_logs_for_subscription_bearer_urls() -> None:
    config = json.loads((ROOT / "apps" / "api" / "wrangler.jsonc").read_text(encoding="utf-8"))
    observability = config.get("observability")

    assert isinstance(observability, dict), "Worker observability must be configured explicitly"
    assert observability.get("enabled") is True, "custom/error observability should remain enabled"
    logs = observability.get("logs")
    assert isinstance(logs, dict), "Worker log behavior must be configured explicitly"
    assert logs.get("invocation_logs") is False, "subscription bearer URLs must not be persisted in invocation logs"


def test_worker_production_entrypoint_uses_hyperdrive_runtime() -> None:
    config = json.loads((ROOT / "apps" / "api" / "wrangler.jsonc").read_text(encoding="utf-8"))

    assert config.get("main") == "src/worker.ts", "production Worker must use the Hyperdrive/PostgreSQL runtime entrypoint"


def test_api_runtime_contains_no_legacy_d1_persistence_artifacts() -> None:
    api_root = ROOT / "apps" / "api"
    source_root = api_root / "src"
    legacy_source_files = sorted(
        path.relative_to(ROOT).as_posix()
        for path in source_root.rglob("*.ts")
        if path.name in {"d1.ts", "d1.test.ts", "subscription-d1.ts", "subscription-d1.test.ts"}
    )
    assert legacy_source_files == [], f"legacy D1 source files remain: {legacy_source_files}"

    legacy_migrations = sorted(
        path.relative_to(ROOT).as_posix()
        for path in (api_root / "migrations").glob("*.sql")
    )
    assert legacy_migrations == [], f"legacy D1 migrations remain: {legacy_migrations}"

    router_source = (source_root / "index.ts").read_text(encoding="utf-8")
    assert "/d1'" not in router_source and '/d1"' not in router_source, "API router still imports D1 stores"
    assert "D1DatabaseLike" not in router_source, "API router still exposes a D1 database type"
    assert "DB?:" not in router_source, "API bindings still expose the legacy D1 DB binding"


def test_current_repository_contains_no_scanner_findings() -> None:
    scanner = load_security_scan_module()
    findings = scanner.scan_repository(ROOT)
    assert findings == []
