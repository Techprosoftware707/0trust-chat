"""Mounted at /integrations/ on the public surface: OAuth begin/callback (portal session),
provider webhooks (signature-verified) and the mock consent page (mock mode only)."""

from django.urls import path

from . import views

app_name = "integrations"

urlpatterns = [
    path("oauth/begin", views.oauth_begin, name="oauth_begin"),
    path("oauth/<slug:slug>/callback", views.oauth_callback, name="oauth_callback"),
    path("mock/<slug:slug>/authorize", views.mock_authorize, name="mock_authorize"),
    path("webhooks/slack/events", views.slack_events, name="slack_events"),
    path("webhooks/gohighlevel", views.ghl_events, name="ghl_events"),
]
