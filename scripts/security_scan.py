#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import NamedTuple


class Finding(NamedTuple):
    path: Path
    line: int
    rule: str


SCAN_SUFFIXES = frozenset({
    ".cjs", ".env", ".example", ".js", ".json", ".jsonc", ".md", ".mjs",
    ".py", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
})
SKIP_DIRS = frozenset({
    ".git", ".pytest_cache", ".venv", "__pycache__", "dist", "node_modules", "venv",
})
SKIP_FILES = frozenset({"pnpm-lock.yaml"})

CREDENTIAL_PREFIX_RE = re.compile(
    r"(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})"
)
PRIVATE_KEY_RE = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?" + r"PRIVATE KEY-----")
SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"^\s*([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)\s*=\s*(.*?)\s*$"
)


def _is_placeholder(value: str) -> bool:
    candidate = value.strip().strip("'\"")
    lowered = candidate.lower()
    if not candidate:
        return True
    if candidate.startswith(("$", "${", "$(", "{{")):
        return True
    if candidate.startswith("<") and candidate.endswith(">"):
        return True
    if lowered in {"...", "***", "none", "null", "unset"}:
        return True
    return any(
        marker in lowered
        for marker in (
            "changeme", "change-me", "example", "placeholder", "replace-me",
            "set-as-", "set-me", "dummy", "test-only", "todo",
        )
    )


def scan_text(text: str, *, path: Path) -> list[Finding]:
    findings: list[Finding] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if PRIVATE_KEY_RE.search(line):
            findings.append(Finding(path=path, line=line_number, rule="private-key"))
        if CREDENTIAL_PREFIX_RE.search(line):
            findings.append(Finding(path=path, line=line_number, rule="credential-prefix"))
        assignment = SENSITIVE_ASSIGNMENT_RE.match(line)
        if assignment and not _is_placeholder(assignment.group(2)):
            findings.append(Finding(path=path, line=line_number, rule="sensitive-assignment"))
    return findings


def _is_scannable(path: Path) -> bool:
    if path.name in SKIP_FILES or any(part in SKIP_DIRS for part in path.parts):
        return False
    if path.name == ".env.example":
        return True
    return path.suffix.lower() in SCAN_SUFFIXES


def scan_repository(root: Path) -> list[Finding]:
    root = root.resolve()
    findings: list[Finding] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if not _is_scannable(relative):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        findings.extend(scan_text(text, path=relative))
    return findings


def format_finding(finding: Finding) -> str:
    return f"{finding.path}:{finding.line}: {finding.rule}"


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    root = Path(arguments[0]) if arguments else Path.cwd()
    findings = scan_repository(root)
    for finding in findings:
        print(format_finding(finding), file=sys.stderr)
    if findings:
        print(f"secret scan failed: {len(findings)} finding(s)", file=sys.stderr)
        return 1
    print("secret scan passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
