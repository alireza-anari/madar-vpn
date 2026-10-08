from __future__ import annotations

import importlib.util
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


def test_current_repository_contains_no_scanner_findings() -> None:
    scanner = load_security_scan_module()
    findings = scanner.scan_repository(ROOT)
    assert findings == []
