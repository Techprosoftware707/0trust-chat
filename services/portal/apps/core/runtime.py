"""Operator-editable runtime settings with environment defaults."""

from __future__ import annotations

from typing import Any

from django.conf import settings

from .models import RuntimeSetting

DEFAULTS: dict[str, Any] = {
    "maintenance_mode": False,
    "maintenance_message": "",
    "registration_mode": None,  # None -> settings.REGISTRATION_MODE
    "announcement": "",
}

ALLOWED_REGISTRATION_MODES = {"open", "invite", "closed"}


def get(key: str) -> Any:
    if key not in DEFAULTS:
        raise KeyError(key)
    row = RuntimeSetting.objects.filter(key=key).first()
    if row is not None:
        return row.value
    if key == "registration_mode":
        return settings.REGISTRATION_MODE
    return DEFAULTS[key]


def set_value(key: str, value: Any, user=None) -> None:
    if key not in DEFAULTS:
        raise KeyError(key)
    if key == "registration_mode" and value not in ALLOWED_REGISTRATION_MODES:
        raise ValueError("invalid registration mode")
    RuntimeSetting.objects.update_or_create(key=key, defaults={"value": value, "updated_by": user})


def registration_mode() -> str:
    return get("registration_mode") or settings.REGISTRATION_MODE
