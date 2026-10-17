from django.apps import AppConfig


class CrmConfig(AppConfig):
    """Business records of a workspace (Nexus foundation). Authorization: ``access.py``;
    business rules: ``services.py``; API: ``api_views.py`` (mounted at
    /api/v1/workspaces/<id>/crm/). Vertical records (real estate, lending, secure documents)
    and meeting notes: ``models_verticals.py``, ``models_meetings.py``, their policies in
    ``policies_verticals.py`` and services in ``realestate.py``, ``lending.py``,
    ``documents.py``, ``meetings.py`` and ``reports.py``."""

    name = "apps.crm"
    label = "crm"
    verbose_name = "Business records (CRM)"

    def ready(self):
        from . import signals  # noqa: F401  (connects the handlers)
        from .policies_verticals import register_all

        register_all()
