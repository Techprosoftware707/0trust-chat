"""Discovery of optional modules of the Nexus apps (``settings.NEXUS_APPS``).

Each Nexus app may ship ``urls.py``, ``api_urls.py``, ``jobs.py`` and ``features.py``;
the portal mounts/collects whatever exists, so adding one never requires editing settings,
URL confs or the worker.
"""

from __future__ import annotations

import importlib
import importlib.util
from types import ModuleType

from django.conf import settings


def app_label(app: str) -> str:
    """``apps.integrations`` -> ``integrations`` (the URL prefix of the app)."""
    return app.rsplit(".", 1)[-1]


def has_module(app: str, submodule: str) -> bool:
    return importlib.util.find_spec(f"{app}.{submodule}") is not None


def nexus_modules(submodule: str) -> list[tuple[str, ModuleType]]:
    """``[(app, module)]`` for every Nexus app that has ``<app>.<submodule>``."""
    found = []
    for app in settings.NEXUS_APPS:
        if has_module(app, submodule):
            found.append((app, importlib.import_module(f"{app}.{submodule}")))
    return found
