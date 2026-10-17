from django.apps import AppConfig


class CrmConfig(AppConfig):
    """Business records of a workspace (Nexus foundation). Authorization: ``access.py``;
    business rules: ``services.py``; API: ``api_views.py`` (mounted at
    /api/v1/workspaces/<id>/crm/)."""

    name = "apps.crm"
    label = "crm"
    verbose_name = "Business records (CRM)"
