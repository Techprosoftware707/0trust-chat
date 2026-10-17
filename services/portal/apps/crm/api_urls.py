"""Mounted at /api/v1/workspaces/<workspace_id>/crm/ (see apps.api.urls)."""

from django.urls import path

from . import api_views as v

app_name = "crm_api"

urlpatterns = [
    path("dashboard", v.dashboard, name="dashboard"),
    path("search", v.search, name="search"),
    path("contacts", v.contacts, name="contacts"),
    path("contacts/<uuid:contact_id>", v.contact_detail, name="contact"),
    path("contacts/<uuid:contact_id>/summary", v.contact_summary, name="contact_summary"),
    path("tags", v.tags, name="tags"),
    path("tags/<uuid:tag_id>", v.tag_detail, name="tag"),
    path("fields", v.field_definitions, name="fields"),
    path("fields/<uuid:field_id>", v.field_definition_detail, name="field"),
    path("pipelines", v.pipelines, name="pipelines"),
    path("pipelines/<uuid:pipeline_id>", v.pipeline_detail, name="pipeline"),
    path("pipelines/<uuid:pipeline_id>/board", v.pipeline_board, name="pipeline_board"),
    path("pipelines/<uuid:pipeline_id>/stages", v.pipeline_stages, name="pipeline_stages"),
    path("pipelines/<uuid:pipeline_id>/stage-order", v.pipeline_stage_order, name="pipeline_stage_order"),
    path("stages/<uuid:stage_id>", v.stage_detail, name="stage"),
    path("opportunities", v.opportunities, name="opportunities"),
    path("opportunities/<uuid:opportunity_id>", v.opportunity_detail, name="opportunity"),
    path("opportunities/<uuid:opportunity_id>/move", v.opportunity_move, name="opportunity_move"),
    path("opportunities/<uuid:opportunity_id>/history", v.opportunity_history, name="opportunity_history"),
    path("tasks", v.tasks, name="tasks"),
    path("tasks/<uuid:task_id>", v.task_detail, name="task"),
    path("activities", v.activities, name="activities"),
    path("activities/<uuid:activity_id>", v.activity_detail, name="activity"),
    path("events", v.events, name="events"),
    path("events/<uuid:event_id>", v.event_detail, name="event"),
    path("room-links", v.room_links, name="room_links"),
    path("room-links/<uuid:link_id>", v.room_link_detail, name="room_link"),
    path("mappings", v.mappings, name="mappings"),
]
