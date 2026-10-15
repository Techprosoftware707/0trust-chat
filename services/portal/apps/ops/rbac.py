"""Role-based access control for the operator console."""

from __future__ import annotations

from functools import wraps

from allauth.account.decorators import reauthentication_required
from django.contrib.auth.views import redirect_to_login
from django.core.exceptions import PermissionDenied

OWNER, ADMIN, SUPPORT, BILLING, AUDITOR = "owner", "admin", "support", "billing", "auditor"
ALL = {OWNER, ADMIN, SUPPORT, BILLING, AUDITOR}

PERMISSIONS: dict[str, set[str]] = {
    "view_console": ALL,
    "view_users": {OWNER, ADMIN, SUPPORT, AUDITOR, BILLING},
    "manage_users": {OWNER, ADMIN, SUPPORT},
    "delete_users": {OWNER, ADMIN},
    "manage_staff": {OWNER},
    "view_workspaces": ALL,
    "view_billing": {OWNER, ADMIN, BILLING, AUDITOR},
    "manage_billing": {OWNER, ADMIN, BILLING},
    "manage_plans": {OWNER, ADMIN, BILLING},
    "view_security": {OWNER, ADMIN, AUDITOR, SUPPORT},
    "view_audit": {OWNER, ADMIN, AUDITOR},
    "view_platform": ALL,
    "manage_platform": {OWNER, ADMIN},
    "manage_wireguard": {OWNER, ADMIN},
    "manage_support": {OWNER, ADMIN, SUPPORT},
}


def has_perm(user, perm: str) -> bool:
    if user is None or not user.is_authenticated or not getattr(user, "is_operator", False):
        return False
    return user.staff_role in PERMISSIONS.get(perm, set())


def ops_view(perm: str = "view_console", *, step_up: bool = False):
    """Decorator: login + operator role + permission (+ recent re-auth)."""

    def decorator(view):
        inner = reauthentication_required(view) if step_up else view

        @wraps(view)
        def wrapper(request, *args, **kwargs):
            if not request.user.is_authenticated:
                return redirect_to_login(request.get_full_path())
            if not has_perm(request.user, perm):
                from apps.core.audit import security_event

                security_event(request, "ops_access_denied", detail={"perm": perm, "path": request.path[:100]})
                raise PermissionDenied(f"Your role does not include '{perm}'.")
            return inner(request, *args, **kwargs)

        wrapper.ops_permission = perm
        wrapper.ops_step_up = step_up
        return wrapper

    return decorator


def perms_for(user) -> dict[str, bool]:
    return {p: has_perm(user, p) for p in PERMISSIONS}
