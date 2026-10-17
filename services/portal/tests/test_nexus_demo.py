"""The synthetic demo seeder and reset: idempotent, fictional, and never touches real data."""

import re
from io import StringIO

import pytest
from django.core.management import CommandError, call_command
from django.test import override_settings

from apps.accounts.models import User
from apps.api.features import workspace_features
from apps.crm import demo
from apps.crm import models as m
from apps.workspaces.models import Membership, Workspace

from .factories import ensure_plans
from .nexus_helpers import business_workspace, make_user

pytestmark = pytest.mark.django_db
CRM_MODELS = [m.Contact, m.Opportunity, m.Task, m.Activity, m.CalendarEvent, m.Pipeline, m.Stage, m.Tag, m.FieldDefinition, m.StageHistory]


def seed(**kw):
    out = StringIO()
    call_command("nexus_demo_seed", stdout=out, **kw)
    return out.getvalue()


def counts(ws):
    return {model.__name__: model.objects.filter(workspace=ws).count() for model in CRM_MODELS}


@pytest.mark.parametrize("command", ["nexus_demo_seed", "nexus_demo_reset"])
def test_refuses_in_production(command):
    with override_settings(NEXUS_ENVIRONMENT="production"):
        with pytest.raises(CommandError, match="only allowed in development or test"):
            call_command(command, stdout=StringIO())
    assert not Workspace.objects.filter(slug=demo.DEMO_SLUG).exists()


def test_seed_creates_fictional_flagged_data_and_is_idempotent():
    out = seed(password="demo-password-123")
    ws = Workspace.objects.get(slug=demo.DEMO_SLUG)
    assert ws.crm_settings.is_demo and set(ws.crm_settings.business_profiles) == {"general", "real_estate", "lending"}
    flags = workspace_features(ws)
    assert flags["crm"] and flags["real_estate"] and flags["lending"] and not flags["save_to_record"]
    first = counts(ws)
    assert first["Contact"] == len(demo.CONTACTS) and first["Opportunity"] == len(demo.OPPORTUNITIES) and first["Pipeline"] == 3
    for model in CRM_MODELS:
        assert not model.objects.filter(workspace=ws, is_demo=False).exists(), model
    for c in m.Contact.objects.filter(workspace=ws):
        assert re.search(r"@example\.(com|org|net)$", c.email)
        assert re.search(r"555-01\d\d$", c.phone)
    for u in User.objects.filter(username__startswith="demo-"):
        assert re.search(r"@example\.(com|org|net)$", u.email) and u.check_password("demo-password-123")
    assert {ms.role for ms in Membership.objects.filter(workspace=ws)} == {"owner", "manager", "agent", "member", "readonly"}
    assert "demo seed complete" in out
    # Second run: nothing duplicated, passwords untouched without --reset-passwords.
    out2 = seed(password="other-password-456")
    assert counts(ws) == first and "already present" in out2
    assert User.objects.get(username="demo-avery").check_password("demo-password-123")
    assert Workspace.objects.filter(slug=demo.DEMO_SLUG).count() == 1


def test_seed_prints_a_generated_password_once():
    out = seed()
    pw = re.search(r"shown once\): (\S+)", out).group(1)
    assert User.objects.get(username="demo-sam").check_password(pw)
    assert "shown once" not in seed()


def test_seed_refuses_to_take_over_real_accounts_or_workspaces():
    ensure_plans()
    make_user("demo-avery", email="real.person@company.test")
    with pytest.raises(CommandError, match="non-demo account"):
        seed(password="x" * 12)
    User.objects.filter(username="demo-avery").delete()
    real_owner = make_user("realowner")
    Workspace.objects.create(name="Real", slug=demo.DEMO_SLUG, created_by=real_owner)
    with pytest.raises(CommandError, match="not a demo workspace"):
        seed(password="x" * 12)
    assert not m.Contact.objects.exists()


def test_reset_deletes_only_demo_rows_of_demo_workspaces():
    seed(password="demo-password-123")
    ws = Workspace.objects.get(slug=demo.DEMO_SLUG)
    owner = User.objects.get(username="demo-avery")
    # Real records inside the demo workspace.
    real_contact = m.Contact.objects.create(workspace=ws, first_name="Real", owner=owner)
    demo_contact = m.Contact.objects.filter(workspace=ws, is_demo=True).first()
    real_note = m.Activity.objects.create(workspace=ws, kind="note", summary="A real note on a demo contact", contact=demo_contact)
    pipeline = m.Pipeline.objects.filter(workspace=ws, is_demo=True).first()
    real_opp = m.Opportunity.objects.create(workspace=ws, name="Real deal", pipeline=pipeline, stage=pipeline.stages.first())
    # A real workspace whose rows were (wrongly) flagged is_demo: not a demo workspace, so untouched.
    other_owner = make_user("someone")
    other_ws = business_workspace(other_owner, "Real Org")
    flagged_but_real = m.Contact.objects.create(workspace=other_ws, first_name="Keep me", is_demo=True)

    out = StringIO()
    call_command("nexus_demo_reset", stdout=out)
    text = out.getvalue()

    assert m.Contact.objects.filter(pk=real_contact.pk).exists()
    assert m.Activity.objects.filter(pk=real_note.pk).exists()
    assert m.Contact.objects.filter(pk=demo_contact.pk).exists()  # kept: a real note depends on it
    assert m.Opportunity.objects.filter(pk=real_opp.pk).exists()
    assert m.Pipeline.objects.filter(pk=pipeline.pk).exists()  # kept: a real opportunity uses it
    assert m.Contact.objects.filter(pk=flagged_but_real.pk).exists()
    assert m.Contact.objects.filter(workspace=ws, is_demo=True).count() == 1
    assert not m.Task.objects.filter(workspace=ws, is_demo=True).exists()
    assert not m.CalendarEvent.objects.filter(workspace=ws, is_demo=True).exists()
    assert "kept 1 crm.Contact" in text and "deleted" in text
    # Accounts, memberships and the workspace stay; a new seed refills it.
    assert User.objects.filter(username__startswith="demo-").count() == len(demo.TEAM)
    assert Membership.objects.filter(workspace=ws).count() == len(demo.TEAM)
    m.Activity.objects.filter(pk=real_note.pk).delete()
    m.Opportunity.objects.filter(pk=real_opp.pk).delete()
    call_command("nexus_demo_reset", stdout=StringIO())
    assert not m.Contact.objects.filter(workspace=ws, is_demo=True).exists()
    seed()
    assert m.Contact.objects.filter(workspace=ws, is_demo=True).count() == len(demo.CONTACTS)
    assert m.Contact.objects.filter(pk=real_contact.pk).exists()
