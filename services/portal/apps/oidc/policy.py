"""Server-side policy for chat (homeserver) sign-in via the portal IdP."""

from __future__ import annotations

from dataclasses import dataclass

from allauth.mfa.utils import is_mfa_enabled

from apps.accounts.models import AccountStatus


@dataclass
class Decision:
    allowed: bool
    reason: str = ""
    message: str = ""
    action_url_name: str = ""


def chat_signin_decision(user) -> Decision:
    if not user.is_active or user.status != AccountStatus.ACTIVE:
        if user.status == AccountStatus.PENDING_DELETION:
            return Decision(
                False,
                "pending_deletion",
                "Your account is scheduled for deletion. Cancel the deletion to use chat again.",
                "portal:account_delete",
            )
        return Decision(False, "inactive", "This account is not active.")
    from apps.workspaces.models import Membership

    requiring = Membership.objects.filter(user=user, workspace__require_mfa=True).select_related("workspace")
    if requiring.exists() and not is_mfa_enabled(user):
        names = ", ".join(sorted(m.workspace.name for m in requiring)[:3])
        return Decision(
            False,
            "mfa_required",
            f"{names} requires two-factor authentication. Set it up, then sign in to chat again.",
            "mfa_index",
        )
    return Decision(True)
