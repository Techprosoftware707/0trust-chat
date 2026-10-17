from django.apps import AppConfig


class AutomationConfig(AppConfig):
    """Workflow automation and vertical workflows (verticals/automation team). Already
    registered; fill in models, ``api_urls.py`` (/api/v1/workspaces/<id>/automation/),
    ``jobs.py`` (the worker runs ``JOBS``) and ``features.py``. Records created by automation
    use ``Task.Source.AUTOMATION`` and go through ``apps.crm.services``.
    """

    name = "apps.automation"
    label = "automation"
    verbose_name = "Automation"
