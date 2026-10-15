import re

import pytest
from django.test import Client

from apps.billing.models import Plan
from apps.billing.services import EntitlementError, assign_manual_plan
from apps.workspaces import services
from apps.workspaces.models import Invitation, Membership, Role, Workspace

from .factories import ensure_plans, make_user

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def plans():
    ensure_plans()


def logged_in(user):
    c = Client()
    c.force_login(user)
    return c


class TestTenantIsolation:
    """IDOR: every workspace URL must 404 for non-members and respect roles."""

    def setup_ws(self):
        owner = make_user("owner")
        ws = services.create_workspace(owner, "Secret Team")
        member = make_user("member")
        Membership.objects.create(workspace=ws, user=member, role=Role.MEMBER)
        outsider = make_user("outsider")
        return owner, member, outsider, ws

    @pytest.mark.parametrize("suffix", ["", "settings/", "billing/"])
    def test_outsider_gets_404(self, suffix):
        owner, member, outsider, ws = self.setup_ws()
        r = logged_in(outsider).get(f"/portal/workspaces/{ws.pk}/{suffix}")
        assert r.status_code == 404
        assert b"Secret Team" not in r.content

    def test_outsider_cannot_mutate(self):
        owner, member, outsider, ws = self.setup_ws()
        c = logged_in(outsider)
        m = Membership.objects.get(workspace=ws, user=member)
        assert c.post(f"/portal/workspaces/{ws.pk}/invite/", {"email": "x@example.org"}).status_code == 404
        assert c.post(f"/portal/workspaces/{ws.pk}/members/{m.pk}/remove/").status_code == 404
        assert c.post(f"/portal/workspaces/{ws.pk}/settings/", {"name": "pwned"}).status_code == 404
        assert c.post(f"/portal/workspaces/{ws.pk}/billing/checkout/", {"plan": "pro"}).status_code == 404
        ws.refresh_from_db()
        assert ws.name == "Secret Team" and Membership.objects.filter(pk=m.pk).exists()

    def test_member_id_from_other_workspace_rejected(self):
        owner, member, outsider, ws = self.setup_ws()
        other = services.create_workspace(outsider, "Other")
        victim = Membership.objects.get(workspace=ws, user=member)
        # outsider is owner of `other` but targets a membership of `ws`
        r = logged_in(outsider).post(f"/portal/workspaces/{other.pk}/members/{victim.pk}/remove/")
        assert r.status_code == 404
        assert Membership.objects.filter(pk=victim.pk).exists()

    def test_malformed_ids_are_404_not_500(self):
        owner, *_ = self.setup_ws()
        c = logged_in(owner)
        assert c.get("/portal/workspaces/not-a-uuid/").status_code == 404
        assert c.get("/portal/workspaces/' OR 1=1 --/").status_code == 404

    def test_member_cannot_manage(self):
        owner, member, outsider, ws = self.setup_ws()
        c = logged_in(member)
        assert c.get(f"/portal/workspaces/{ws.pk}/").status_code == 200
        assert c.get(f"/portal/workspaces/{ws.pk}/settings/").status_code == 403
        c.post(f"/portal/workspaces/{ws.pk}/invite/", {"email": "new@example.org"})
        assert not Invitation.objects.filter(workspace=ws).exists()
        om = Membership.objects.get(workspace=ws, user=owner)
        c.post(f"/portal/workspaces/{ws.pk}/members/{om.pk}/remove/")
        assert Membership.objects.filter(pk=om.pk).exists()


class TestInvitations:
    def test_invite_link_flow_and_email_binding(self):
        owner = make_user("o2")
        ws = services.create_workspace(owner, "Team")
        c = logged_in(owner)
        c.post(f"/portal/workspaces/{ws.pk}/invite/", {"email": "Invitee@Example.org", "role": "member"})
        r = c.get(f"/portal/workspaces/{ws.pk}/")
        token = re.search(r"/invite/([^/]+)/", r.content.decode()).group(1)
        inv = Invitation.objects.get(workspace=ws)
        assert inv.token_hash != token and len(inv.token_hash) == 64  # stored hashed
        # The link is shown once
        assert token not in c.get(f"/portal/workspaces/{ws.pk}/").content.decode()
        wrong = make_user("wrong", email="wrong@example.org")
        logged_in(wrong).post(f"/invite/{token}/")
        assert not Membership.objects.filter(workspace=ws, user=wrong).exists()
        right = make_user("invitee", email="invitee@example.org")
        r = logged_in(right).post(f"/invite/{token}/")
        assert Membership.objects.filter(workspace=ws, user=right, role=Role.MEMBER).exists()
        # single use
        assert logged_in(make_user("x3", email="invitee2@example.org")).get(f"/invite/{token}/").status_code == 404

    def test_invalid_token(self):
        assert Client().get("/invite/nope/").status_code == 404


class TestEntitlements:
    def test_seat_limit_counts_pending_invites(self):
        owner = make_user("o3")
        ws = services.create_workspace(owner, "Small")
        free = Plan.objects.get(code="free")
        limit = free.entitlement("max_members")
        for i in range(limit - 1):
            services.invite(owner, ws.pk, f"p{i}@example.org")
        with pytest.raises(EntitlementError):
            services.invite(owner, ws.pk, "one-too-many@example.org")

    def test_upgrade_raises_limit_and_downgrade_keeps_data(self):
        owner = make_user("o4")
        ws = services.create_workspace(owner, "Growing")
        assign_manual_plan(ws, Plan.objects.get(code="pro"))
        for i in range(10):
            services.invite(owner, ws.pk, f"g{i}@example.org")
        assign_manual_plan(ws, Plan.objects.get(code="free"))
        # Nothing deleted on downgrade, but no new seats.
        assert Invitation.objects.filter(workspace=ws).pending().count() == 10
        with pytest.raises(EntitlementError):
            services.invite(owner, ws.pk, "after-downgrade@example.org")

    def test_require_mfa_needs_entitlement(self):
        owner = make_user("o5")
        ws = services.create_workspace(owner, "Strict")
        with pytest.raises(EntitlementError):
            services.update_settings(owner, ws.pk, name="Strict", require_mfa=True, allow_member_invites=False)
        assign_manual_plan(ws, Plan.objects.get(code="pro"))
        services.update_settings(owner, ws.pk, name="Strict", require_mfa=True, allow_member_invites=False)
        assert Workspace.objects.get(pk=ws.pk).require_mfa

    def test_one_free_workspace_per_user(self):
        owner = make_user("o6")
        services.create_workspace(owner, "First")
        with pytest.raises(EntitlementError):
            services.create_workspace(owner, "Second")
