"""Logging helpers: request IDs and redaction.

Logs must never contain passwords, tokens, keys or message content. The
redaction filter is a last line of defence; code should not log such data in
the first place.
"""

from __future__ import annotations

import contextvars
import logging
import re

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

_PATTERNS = [
    (re.compile(r"(?i)(password|passwd|secret|token|api[_-]?key|authorization|cookie|code)=([^&\s]+)"), r"\1=[redacted]"),
    (re.compile(r"(?i)(bearer\s+)[a-z0-9._~+/=-]+"), r"\1[redacted]"),
    (re.compile(r"sk_(live|test)_[A-Za-z0-9]+"), "sk_[redacted]"),
    (re.compile(r"whsec_[A-Za-z0-9]+"), "whsec_[redacted]"),
    (re.compile(r"syt_[A-Za-z0-9_]+"), "syt_[redacted]"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S), "[redacted private key]"),
    (re.compile(r"/(reset/key|invite|setup|recover)/[^/\s?]+"), r"/\1/[redacted]"),
]


def redact(text: str) -> str:
    for pattern, repl in _PATTERNS:
        text = pattern.sub(repl, text)
    return text


class RedactFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - malformed log call
            return True
        cleaned = redact(message)
        if cleaned != message:
            record.msg = cleaned
            record.args = ()
        return True
