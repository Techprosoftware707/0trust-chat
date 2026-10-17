from django.apps import AppConfig


class IntegrationsConfig(AppConfig):
    """Gmail, GoHighLevel, Slack and the unified inbox (integrations team).

    Models: ``models.py`` (TenantModels, policies in ``policies.py`` registered here);
    provider adapters: ``providers/``; OAuth: ``oauth.py``; encrypted tokens: ``tokens.py`` +
    ``crypto.py``; HTTP with retries and rate limits: ``http.py``; webhooks: ``webhooks.py``;
    service functions other teams call: ``services.py``; API: ``api_views.py`` (mounted at
    /api/v1/workspaces/<id>/integrations/); OAuth callbacks, webhooks and the mock consent
    page: ``views.py`` (mounted at /integrations/); sync and retention jobs: ``jobs.py``.
    See docs/nexus/INTEGRATIONS.md.
    """

    name = "apps.integrations"
    label = "integrations"
    verbose_name = "Integrations"

    def ready(self):
        from . import checks  # noqa: F401  (system check: mock mode refused in production)
        from .policies import register_all

        register_all()
