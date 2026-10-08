from __future__ import annotations

import re


REDACTED = "[REDACTED]"

_BEARER_RE = re.compile(r"(?i)(Authorization\s*:\s*Bearer\s+)([^\s,;]+)")
_SUBSCRIPTION_RE = re.compile(r"(?i)(/s/)([A-Za-z0-9_-]{16,})")
_NAMED_SECRET_RE = re.compile(
    r"(?i)\b(enrollmentToken|rawCredential|nodeCredential|privateKey|secret|token)\b"
    r"(\s*[:=]\s*)([^\s,;}]+)"
)
_QUERY_SECRET_RE = re.compile(
    r"(?i)([?&](?:token|key|secret|credential)=)([^&#\s]+)"
)


def redact_text(value: object) -> str:
    text = str(value)
    text = _BEARER_RE.sub(lambda match: f"{match.group(1)}{REDACTED}", text)
    text = _SUBSCRIPTION_RE.sub(lambda match: f"{match.group(1)}{REDACTED}", text)
    text = _NAMED_SECRET_RE.sub(
        lambda match: f"{match.group(1)}{match.group(2)}{REDACTED}",
        text,
    )
    text = _QUERY_SECRET_RE.sub(lambda match: f"{match.group(1)}{REDACTED}", text)
    return text
