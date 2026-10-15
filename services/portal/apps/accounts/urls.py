from django.urls import path

from . import views

urlpatterns = [
    path("dashboard/", views.dashboard, name="dashboard"),
    path("profile/", views.profile, name="profile"),
    path("security/", views.security_center, name="security"),
    path("privacy/", views.privacy_center, name="privacy"),
    path("privacy/export/", views.export_data, name="export"),
    path("privacy/delete/", views.delete_account, name="account_delete"),
    path("privacy/delete/cancel/", views.cancel_deletion, name="account_delete_cancel"),
    path("support/", views.support, name="support"),
    path("workspaces/", views.workspaces, name="workspaces"),
    path("workspaces/<str:workspace_id>/", views.workspace_detail, name="workspace"),
    path("workspaces/<str:workspace_id>/invite/", views.workspace_invite, name="workspace_invite"),
    path("workspaces/<str:workspace_id>/invite/<str:invitation_id>/revoke/", views.workspace_invite_revoke, name="workspace_invite_revoke"),
    path("workspaces/<str:workspace_id>/members/<int:member_id>/role/", views.workspace_member_role, name="workspace_member_role"),
    path("workspaces/<str:workspace_id>/members/<int:member_id>/remove/", views.workspace_member_remove, name="workspace_member_remove"),
    path("workspaces/<str:workspace_id>/members/<int:member_id>/transfer/", views.workspace_transfer, name="workspace_transfer"),
    path("workspaces/<str:workspace_id>/settings/", views.workspace_settings, name="workspace_settings"),
    path("workspaces/<str:workspace_id>/delete/", views.workspace_delete, name="workspace_delete"),
    path("workspaces/<str:workspace_id>/billing/", views.workspace_billing, name="workspace_billing"),
    path("workspaces/<str:workspace_id>/billing/checkout/", views.workspace_checkout, name="workspace_checkout"),
    path("workspaces/<str:workspace_id>/billing/portal/", views.workspace_billing_portal, name="workspace_billing_portal"),
    path("", views.dashboard),
]
