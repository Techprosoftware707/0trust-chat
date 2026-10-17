from django.apps import AppConfig


class ApiConfig(AppConfig):
    """Shared plumbing of the JSON API at /api/v1/ (no models).

    Bearer-token authentication, the error format, input validation, pagination and CORS
    live here so every Nexus app (crm, integrations, assistant, mcp, automation) uses the
    same contract. See docs/nexus/ARCHITECTURE.md, "API conventions".
    """

    name = "apps.api"
    label = "nexus_api"
    verbose_name = "Nexus API"

    def ready(self) -> None:
        from . import signals  # noqa: F401
