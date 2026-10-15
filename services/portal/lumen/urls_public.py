"""URLs served by the public `portal` process (website, portal, IdP, webhooks)."""

from django.urls import include, path

from apps.accounts import views as account_views
from apps.billing import views as billing_views
from apps.core import views as core_views
from apps.oidc import views as oidc_views

urlpatterns = [
    path("healthz", core_views.healthz, name="healthz"),
    path(".well-known/security.txt", core_views.security_txt, name="security_txt"),
    path("robots.txt", core_views.robots_txt, name="robots_txt"),
    # OIDC: our policy gate shadows allauth's authorization endpoint.
    path("identity/o/authorize", oidc_views.authorize, name="lumen_oidc_authorize"),
    path("", include("allauth.idp.urls")),
    # Email-dependent allauth views are guarded when SMTP is not configured.
    path("accounts/password/reset/", account_views.password_reset, name="account_reset_password"),
    path("accounts/email/", account_views.email_management, name="account_email"),
    path("accounts/", include("allauth.urls")),
    path("portal/", include(("apps.accounts.urls", "portal"), namespace="portal")),
    path("invite/<str:token>/", account_views.invitation_landing, name="invitation_landing"),
    path("setup/<str:token>/", account_views.setup_link, name="setup_link"),
    path("billing/webhooks/stripe/", billing_views.stripe_webhook, name="stripe_webhook"),
    path("chat/", oidc_views.matrix_client_redirect, name="chat_redirect"),
    path("", include(("apps.core.urls", "site"), namespace="site")),
]
