from django.apps import AppConfig


class IntegrationsConfig(AppConfig):
    """Gmail, GoHighLevel, Slack and the unified inbox (integrations team).

    Already registered in INSTALLED_APPS and the URL confs. Fill in: models (subclass
    ``apps.crm.models.TenantModel``), ``api_urls.py`` (mounted at
    /api/v1/workspaces/<id>/integrations/), ``urls.py`` (mounted at /integrations/ for OAuth
    callbacks and webhooks), ``jobs.py`` (sync jobs for the worker) and ``features.py``.
    Write external records with ``apps.crm.services.record_external_activity`` and
    ``apps.crm.models.ExternalRecordMapping``; connecting/disconnecting a workspace-wide
    integration requires ``Cap.INTEGRATIONS_OWN`` (owner/admin).
    """

    name = "apps.integrations"
    label = "integrations"
    verbose_name = "Integrations"
