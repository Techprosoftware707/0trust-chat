"""Mounted at /api/v1/workspaces/<workspace_id>/automation/. Views use apps.api.decorators.api_endpoint."""

from django.urls import path

from . import api_views as v

app_name = "automation_api"

urlpatterns = [
    path("catalog", v.catalog, name="catalog"),
    path("rules", v.rules, name="rules"),
    path("rules/<uuid:rule_id>", v.rule_detail, name="rule"),
    path("executions", v.executions, name="executions"),
    path("executions/summary", v.execution_summary, name="execution_summary"),
    path("executions/<uuid:execution_id>/retry", v.execution_retry, name="execution_retry"),
    path("notifications", v.notification_list, name="notifications"),
    path("notifications/unread-count", v.notification_unread, name="notification_unread"),
    path("notifications/read-all", v.notification_read_all, name="notification_read_all"),
    path("notifications/<uuid:notification_id>", v.notification_detail, name="notification"),
    path("preferences", v.preferences, name="preferences"),
    path("preferences/workspace", v.workspace_preferences, name="workspace_preferences"),
]
