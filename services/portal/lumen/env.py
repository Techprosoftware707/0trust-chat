"""Environment and secret-file helpers.

Secrets are never passed as plain environment variables in production. Each
secret ``FOO`` is read from the file named by ``FOO_FILE`` (a Docker secret
mounted read-only). Plain ``FOO`` is accepted only when ``LUMEN_ALLOW_ENV_SECRETS``
is set, which the test-suite and local development use.
"""

from __future__ import annotations

import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

_TRUE = {"1", "true", "yes", "on"}


def env(name: str, default: str | None = None, *, required: bool = False) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        if required and default is None:
            raise ImproperlyConfigured(f"Missing required environment variable {name}")
        return default if default is not None else ""
    return value


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in _TRUE


def env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ImproperlyConfigured(f"{name} must be an integer") from exc


def env_list(name: str, default: list[str] | None = None) -> list[str]:
    value = os.environ.get(name)
    if not value:
        return list(default or [])
    return [item.strip() for item in value.split(",") if item.strip()]


def secret(name: str, *, required: bool = False, default: str = "") -> str:
    """Read secret ``name`` from ``<name>_FILE`` (preferred) or the environment."""
    path = os.environ.get(f"{name}_FILE")
    if path:
        p = Path(path)
        try:
            data = p.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise ImproperlyConfigured(f"Cannot read secret file for {name}: {exc}") from exc
        if not data and required:
            raise ImproperlyConfigured(f"Secret file for {name} is empty")
        return data
    if env_bool("LUMEN_ALLOW_ENV_SECRETS"):
        value = os.environ.get(name, "")
        if value:
            return value
    if required:
        raise ImproperlyConfigured(f"Secret {name} is not configured (set {name}_FILE)")
    return default
