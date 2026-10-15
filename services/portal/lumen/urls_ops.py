"""URLs served by the private `ops` process (operator console + internal API)."""

from django.urls import include, path

from apps.accounts import views as account_views
from apps.core import views as core_views

urlpatterns = [
    path("healthz", core_views.healthz, name="healthz"),
    path("internal/", include(("apps.ops.internal_urls", "internal"), namespace="internal")),
    path("accounts/password/reset/", account_views.ops_password_reset_disabled, name="account_reset_password"),
    path("accounts/signup/", account_views.ops_signup_disabled, name="account_signup"),
    path("accounts/", include("allauth.urls")),
    path("setup/<str:token>/", account_views.setup_link, name="setup_link"),
    path("ops/", include(("apps.ops.urls", "ops"), namespace="ops")),
    path("", core_views.ops_root, name="ops_root"),
]
