"""Mounted at /api/v1/workspaces/<workspace_id>/assistant/ (see apps.assistant.api_views)."""

from django.urls import path

from . import api_views as v

app_name = "assistant_api"

urlpatterns = [
    path("status", v.status, name="status"),
    path("settings", v.ai_settings_view, name="settings"),
    path("chat", v.chat_view, name="chat"),
    path("actions/<uuid:action_id>", v.action_detail, name="action"),
    path("actions/<uuid:action_id>/confirm", v.action_confirm, name="action_confirm"),
    path("actions/<uuid:action_id>/cancel", v.action_cancel, name="action_cancel"),
    path("interactions", v.interactions_view, name="interactions"),
    path("save-to-record", v.save_to_record_view, name="save_to_record"),
]
