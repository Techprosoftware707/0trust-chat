from django.apps import AppConfig


class AutomationConfig(AppConfig):
    """Workflow automation (verticals/automation team): rules, events, executions with
    retries and loop protection (``engine.py``), in-app notifications and their preferences
    (``notifications.py``), the rule API (``api_urls.py``, /api/v1/workspaces/<id>/automation/)
    and the scheduled scans (``jobs.py``). Records created by automation use
    ``Task.Source.AUTOMATION`` and go through ``apps.crm.services``.
    """

    name = "apps.automation"
    label = "automation"
    verbose_name = "Automation"

    def ready(self):
        from .policies import register_all

        register_all()
