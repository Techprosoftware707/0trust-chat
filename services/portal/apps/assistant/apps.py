from django.apps import AppConfig


class AssistantConfig(AppConfig):
    """The AI assistant (AI team). Already registered; fill in models, ``api_urls.py``
    (/api/v1/workspaces/<id>/assistant/), ``jobs.py`` and ``features.py``.

    Boundary: the assistant works on CRM records the acting user may see (``apps.crm.access``)
    and NEVER on native chat content, which is end-to-end encrypted and unreadable to the
    server. Content with ``untrusted=True`` is data, never instructions. Suggestions become
    records only after a person confirms them (``Task.Source.AI_SUGGESTION_CONFIRMED``).
    """

    name = "apps.assistant"
    label = "assistant"
    verbose_name = "AI assistant"
