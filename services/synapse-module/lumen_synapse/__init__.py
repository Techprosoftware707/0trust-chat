"""Lumen Synapse module: per-user media entitlements.

Loaded through Synapse's documented module API (no changes to Synapse). For
each local user it asks the Lumen ops service which plan limits apply and
enforces them with Synapse's media repository callbacks:

* ``get_media_config_for_user``            -> advertises the per-file limit
* ``is_user_allowed_to_upload_media_of_size`` -> rejects oversized files
* ``get_media_upload_limits_for_user``     -> rolling upload quota

If the ops service is unreachable the last known value (or the configured
Free-plan defaults) is used, so an ops outage can never *raise* limits.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from synapse.config.repository import MediaUploadLimit
from synapse.module_api import ModuleApi

__version__ = "1.0.0"

logger = logging.getLogger(__name__)


class LumenEntitlements:
    def __init__(self, config: dict[str, Any], api: ModuleApi):
        self._api = api
        self._url = config["entitlements_url"]
        with open(config["token_path"], encoding="utf-8") as fh:
            self._token = fh.read().strip()
        self._ttl = int(config.get("cache_seconds", 300))
        self._default_upload = int(config.get("default_upload_max_mb", 25)) * 1024 * 1024
        self._default_quota = int(config.get("default_quota_mb_30d", 1024)) * 1024 * 1024
        self._period_ms = 30 * 24 * 3600 * 1000
        self._info_uri = config.get("info_uri")
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}
        api.register_media_repository_callbacks(
            get_media_config_for_user=self.get_media_config_for_user,
            is_user_allowed_to_upload_media_of_size=self.is_user_allowed_to_upload_media_of_size,
            get_media_upload_limits_for_user=self.get_media_upload_limits_for_user,
        )

    @staticmethod
    def parse_config(config: dict[str, Any]) -> dict[str, Any]:
        for key in ("entitlements_url", "token_path"):
            if key not in config:
                raise ValueError(f"lumen_synapse: missing '{key}'")
        return config

    def _defaults(self) -> dict[str, Any]:
        return {
            "upload_max_bytes": self._default_upload,
            "limits": [{"time_period_ms": self._period_ms, "max_bytes": self._default_quota}],
            "plan": "default",
        }

    async def _entitlements(self, user_id: str) -> dict[str, Any]:
        now = time.monotonic()
        cached = self._cache.get(user_id)
        if cached and now - cached[0] < self._ttl:
            return cached[1]
        try:
            data = await self._api.http_client.get_json(
                self._url,
                args={"user_id": user_id},
                headers={b"Authorization": [f"Bearer {self._token}".encode()]},
            )
            if not isinstance(data, dict) or "upload_max_bytes" not in data:
                raise ValueError("malformed entitlement response")
        except Exception as exc:  # noqa: BLE001 - fall back safely
            logger.warning("lumen_synapse: entitlement lookup failed for %s: %s", user_id, type(exc).__name__)
            if cached:
                return cached[1]
            return self._defaults()
        if len(self._cache) > 50_000:
            self._cache.clear()
        self._cache[user_id] = (now, data)
        return data

    async def get_media_config_for_user(self, user_id: str) -> dict[str, Any] | None:
        ent = await self._entitlements(user_id)
        return {"m.upload.size": int(ent["upload_max_bytes"])}

    async def is_user_allowed_to_upload_media_of_size(self, user_id: str, size: int) -> bool:
        ent = await self._entitlements(user_id)
        return size <= int(ent["upload_max_bytes"])

    async def get_media_upload_limits_for_user(self, user_id: str) -> list[MediaUploadLimit] | None:
        ent = await self._entitlements(user_id)
        limits = []
        for item in ent.get("limits", []):
            limits.append(
                MediaUploadLimit(
                    max_bytes=int(item["max_bytes"]),
                    time_period_ms=int(item["time_period_ms"]),
                    info_uri=self._info_uri,
                    can_upgrade=True,
                )
            )
        return limits or None
