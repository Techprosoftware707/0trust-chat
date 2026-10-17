from django.apps import AppConfig


class AssistantConfig(AppConfig):
    """The AI assistant: tool registry (shared with the MCP connector), providers, two-phase
    writes, the AI audit log and "Save to record".

    Boundary: the assistant works on CRM records the acting user may see (``apps.crm.access``)
    and NEVER on native chat content, which is end-to-end encrypted and unreadable to the
    server. Content with ``untrusted=True`` is data, never instructions. Suggestions become
    records only after a person confirms them (``Task.Source.AI_SUGGESTION_CONFIRMED``).
    """

    name = "apps.assistant"
    label = "assistant"
    verbose_name = "AI assistant"

    def ready(self):
        from apps.crm import access

        from .models import AIInteraction, PendingAction
        from .policies import AIInteractionPolicy, PendingActionPolicy

        access.register(PendingAction, PendingActionPolicy(), referencable=False)
        access.register(AIInteraction, AIInteractionPolicy(), referencable=False)
