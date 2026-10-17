"""Migrating an existing Lumen database (workspaces 0001, no CRM) to the Nexus schema keeps
every membership, invitation and workspace exactly as it was."""

from datetime import timedelta

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone

from apps.billing.models import Plan
from apps.billing.services import backfill_entitlements, seed_plans

BASE = [("workspaces", "0001_initial")]


@pytest.mark.django_db(transaction=True)
def test_existing_memberships_survive_the_nexus_migrations():
    executor = MigrationExecutor(connection)
    leaves = executor.loader.graph.leaf_nodes()
    try:
        executor.migrate(BASE)  # also unapplies everything that depends on workspaces 0002 (crm)
        executor.loader.build_graph()
        old = executor.loader.project_state(BASE).apps
        assert "crm_contact" not in connection.introspection.table_names()
        User = old.get_model("accounts", "User")
        Workspace = old.get_model("workspaces", "Workspace")
        Membership = old.get_model("workspaces", "Membership")
        Invitation = old.get_model("workspaces", "Invitation")
        users = [User.objects.create(username=f"legacy{i}", email=f"legacy{i}@example.org", password="!") for i in range(3)]
        ws = Workspace.objects.create(name="Legacy Co", slug="legacy-co", created_by=users[0])
        for user, role in zip(users, ["owner", "admin", "member"]):
            Membership.objects.create(workspace=ws, user=user, role=role)
        Invitation.objects.create(workspace=ws, email="pending@example.org", role="admin", token_hash="a" * 64,
                                  expires_at=timezone.now() + timedelta(days=3))
        before = sorted(Membership.objects.values_list("user__username", "role", "created_at"))

        executor = MigrationExecutor(connection)
        executor.migrate(leaves)
        executor.loader.build_graph()
        new = executor.loader.project_state(leaves).apps
        NewMembership = new.get_model("workspaces", "Membership")
        after = sorted(NewMembership.objects.values_list("user__username", "role", "created_at"))
        assert after == before
        assert new.get_model("workspaces", "Invitation").objects.get(email="pending@example.org").role == "admin"
        assert new.get_model("workspaces", "Workspace").objects.get(slug="legacy-co").name == "Legacy Co"
        # The new roles can be stored, and the CRM tables exist and start empty.
        m = NewMembership.objects.get(user__username="legacy2")
        m.role = "readonly"
        m.save()
        assert NewMembership.objects.get(pk=m.pk).role == "readonly"
        assert "crm_contact" in connection.introspection.table_names()
        assert new.get_model("crm", "Contact").objects.count() == 0
        # A plain Lumen workspace has no business settings: no business features.
        from apps.api.features import workspace_features
        from apps.workspaces.models import Workspace as CurrentWorkspace

        seed_plans()
        from apps.billing.services import ensure_subscription

        current = CurrentWorkspace.objects.get(slug="legacy-co")
        ensure_subscription(current)
        assert workspace_features(current)["crm"] is False
    finally:
        MigrationExecutor(connection).migrate(leaves)


@pytest.mark.django_db
def test_bootstrap_backfills_new_entitlements_without_overwriting():
    seed_plans()
    pro = Plan.objects.get(code="pro")
    legacy = {k: v for k, v in pro.entitlements.items() if not k.startswith("crm_") and k != "vertical_profiles"}
    legacy["max_members"] = 77  # an operator's own value
    pro.entitlements = legacy
    pro.save()
    added = backfill_entitlements()
    pro.refresh_from_db()
    assert set(added["pro"]) == {"crm_enabled", "crm_max_contacts", "vertical_profiles"}
    assert pro.entitlements["crm_enabled"] is True and pro.entitlements["crm_max_contacts"] == 25000
    assert pro.entitlements["max_members"] == 77
    assert backfill_entitlements() == {}
