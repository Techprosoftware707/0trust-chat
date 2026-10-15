"""Minimal client for the Synapse Admin API (internal network only).

Holds the homeserver admin token, which only the ops and worker processes
receive. Nothing here can read encrypted message content: Synapse only has
ciphertext for E2EE rooms.
"""

from __future__ import annotations

from urllib.parse import quote

import requests
from django.conf import settings


class SynapseError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class SynapseAdmin:
    def __init__(self, base_url: str | None = None, token: str | None = None, timeout: float = 8.0):
        self.base = (base_url or settings.SYNAPSE_INTERNAL_URL).rstrip("/")
        self.token = token if token is not None else settings.SYNAPSE_ADMIN_TOKEN
        self.timeout = timeout
        self.session = requests.Session()
        self.session.trust_env = False  # never route internal calls through a proxy

    @property
    def configured(self) -> bool:
        return bool(self.token)

    def _req(self, method: str, path: str, *, json=None, params=None, auth: bool = True):
        headers = {"Authorization": f"Bearer {self.token}"} if auth else {}
        if auth and not self.token:
            raise SynapseError("Synapse admin token is not configured")
        try:
            r = self.session.request(method, self.base + path, json=json, params=params, headers=headers, timeout=self.timeout)
        except requests.RequestException as exc:
            raise SynapseError(f"homeserver unreachable: {type(exc).__name__}") from exc
        if r.status_code >= 400:
            try:
                err = r.json().get("error", r.text[:200])
            except ValueError:
                err = r.text[:200]
            raise SynapseError(f"{r.status_code}: {err}", r.status_code)
        if not r.content:
            return {}
        try:
            return r.json()
        except ValueError:
            return {"raw": r.text[:500]}

    @staticmethod
    def _uid(user_id: str) -> str:
        return quote(user_id, safe="")

    # --- health / server ---------------------------------------------------------
    def health(self) -> bool:
        try:
            r = self.session.get(self.base + "/health", timeout=self.timeout)
            return r.status_code == 200 and r.text.strip() == "OK"
        except requests.RequestException:
            return False

    def server_version(self) -> dict:
        return self._req("GET", "/_synapse/admin/v1/server_version")

    def counts(self) -> dict:
        users = self._req("GET", "/_synapse/admin/v2/users", params={"limit": 1, "guests": "false"}).get("total", 0)
        rooms = self._req("GET", "/_synapse/admin/v1/rooms", params={"limit": 1}).get("total_rooms", 0)
        return {"users": users, "rooms": rooms}

    def federation_destinations(self, limit: int = 100) -> dict:
        return self._req(
            "GET", "/_synapse/admin/v1/federation/destinations", params={"limit": limit, "order_by": "destination"}
        )

    def media_statistics(self, limit: int = 20) -> dict:
        return self._req(
            "GET", "/_synapse/admin/v1/statistics/users/media", params={"limit": limit, "order_by": "media_length", "dir": "b"}
        )

    def room_size_statistics(self) -> dict:
        return self._req("GET", "/_synapse/admin/v1/statistics/database/rooms")

    def event_reports(self, limit: int = 50) -> dict:
        return self._req("GET", "/_synapse/admin/v1/event_reports", params={"limit": limit, "dir": "b"})

    def background_updates(self) -> dict:
        return self._req("GET", "/_synapse/admin/v1/background_updates/status")

    # --- users -------------------------------------------------------------------
    def user(self, user_id: str) -> dict | None:
        try:
            return self._req("GET", f"/_synapse/admin/v2/users/{self._uid(user_id)}")
        except SynapseError as exc:
            if exc.status == 404:
                return None
            raise

    def devices(self, user_id: str) -> list[dict]:
        return self._req("GET", f"/_synapse/admin/v2/users/{self._uid(user_id)}/devices").get("devices", [])

    def delete_devices(self, user_id: str, device_ids: list[str]) -> None:
        if device_ids:
            self._req("POST", f"/_synapse/admin/v2/users/{self._uid(user_id)}/delete_devices", json={"devices": device_ids})

    def logout_all(self, user_id: str) -> int:
        ids = [d["device_id"] for d in self.devices(user_id)]
        self.delete_devices(user_id, ids)
        return len(ids)

    def set_suspended(self, user_id: str, suspended: bool) -> None:
        self._req("PUT", f"/_synapse/admin/v1/suspend/{self._uid(user_id)}", json={"suspend": suspended})

    def deactivate(self, user_id: str, *, erase: bool) -> None:
        self._req("POST", f"/_synapse/admin/v1/deactivate/{self._uid(user_id)}", json={"erase": erase})

    def set_directory_visibility(self, user_id: str, visible: bool) -> None:
        # Hiding from the user directory is done client-side in Matrix; recorded for completeness.
        return None
