"""Mounted at /automation/ on the public surface (callbacks, webhooks). Not authenticated by
default: protect each view (bearer token, signed webhook, or session)."""

app_name = "automation"

urlpatterns: list = []
