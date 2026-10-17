"""Mounted at /api/v1/workspaces/<workspace_id>/integrations/ (see apps.api.urls)."""

from django.urls import path

from . import api_views as v

app_name = "integrations_api"

urlpatterns = [
    path("providers", v.providers, name="providers"),
    path("connections", v.connection_list, name="connections"),
    path("connections/oauth-start", v.oauth_start, name="oauth_start"),
    path("connections/private-token", v.private_token, name="private_token"),
    path("connections/<uuid:connection_id>", v.connection_detail, name="connection"),
    path("connections/<uuid:connection_id>/sync", v.connection_sync, name="connection_sync"),
    path("connections/<uuid:connection_id>/disconnect", v.connection_disconnect, name="connection_disconnect"),
    path("connections/<uuid:connection_id>/slack-channels", v.slack_channels, name="slack_channels"),
    path("inbox", v.inbox, name="inbox"),
    path("inbox/counts", v.inbox_counts, name="inbox_counts"),
    path("inbox/mark", v.inbox_mark, name="inbox_mark"),
    path("inbox/mutes", v.inbox_mutes, name="inbox_mutes"),
    path("inbox/mutes/<uuid:mute_id>", v.inbox_mute_detail, name="inbox_mute"),
    path("inbox/<uuid:item_id>", v.inbox_item, name="inbox_item"),
    path("inbox/<uuid:item_id>/suggestions", v.inbox_suggestions, name="inbox_suggestions"),
    path("inbox/<uuid:item_id>/links", v.inbox_links, name="inbox_links"),
    path("inbox/<uuid:item_id>/links/<uuid:link_id>", v.inbox_link_detail, name="inbox_link"),
    path("inbox/<uuid:item_id>/permalink", v.inbox_permalink, name="inbox_permalink"),
    path("inbox/<uuid:item_id>/drafts", v.item_drafts, name="item_drafts"),
    path("inbox/<uuid:item_id>/messages/<uuid:message_id>/body", v.message_body, name="message_body"),
    path("inbox/<uuid:item_id>/messages/<uuid:message_id>/attachments/<str:attachment_id>", v.message_attachment, name="message_attachment"),
    path("gmail/search", v.gmail_search, name="gmail_search"),
    path("drafts/<uuid:draft_id>", v.draft_detail, name="draft"),
    path("drafts/<uuid:draft_id>/send-request", v.draft_send_request, name="draft_send_request"),
    path("slack/post-request", v.slack_post_request, name="slack_post_request"),
    path("ghl/actions", v.ghl_action_request, name="ghl_actions"),
    path("actions/<uuid:action_id>", v.action_detail, name="action"),
    path("actions/<uuid:action_id>/confirm", v.action_confirm, name="action_confirm"),
    path("ghl/contacts", v.ghl_contacts, name="ghl_contacts"),
    path("ghl/contacts/<str:external_id>", v.ghl_contact_detail, name="ghl_contact"),
    path("ghl/contacts/<str:external_id>/link", v.ghl_contact_link, name="ghl_contact_link"),
    path("ghl/contacts/<str:external_id>/import", v.ghl_contact_import, name="ghl_contact_import"),
    path("ghl/opportunities", v.ghl_opportunities, name="ghl_opportunities"),
    path("ghl/opportunities/<str:external_id>/link", v.ghl_opportunity_link, name="ghl_opportunity_link"),
    path("ghl/pipelines", v.ghl_pipelines, name="ghl_pipelines"),
    path("ghl/tags", v.ghl_tags, name="ghl_tags"),
    path("ghl/custom-fields", v.ghl_custom_fields, name="ghl_custom_fields"),
    path("ghl/workflows", v.ghl_workflows, name="ghl_workflows"),
]
