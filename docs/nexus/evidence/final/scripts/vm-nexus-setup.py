# Runs in the installed server's tool container (lumenctl manage shell): a synthetic owner with a
# business workspace (general + lending) and a 10-minute nexus-web access token for the API checks.
import secrets
from datetime import timedelta

from allauth.idp.oidc.adapter import get_adapter
from allauth.idp.oidc.models import Token
from django.utils import timezone

from apps.accounts.models import User
from apps.api.oauth import ensure_nexus_web_client
from apps.billing.models import Plan
from apps.billing.services import assign_manual_plan, ensure_subscription
from apps.crm.models import OrgSettings, Pipeline
from apps.crm.services import create_default_pipeline
from apps.workspaces.models import Membership, Role, Workspace

u, _ = User.objects.get_or_create(username="nexus-qa-owner", defaults={"email": "nexus-qa-owner@example.com"})
u.set_unusable_password()
u.save()
ws, _ = Workspace.objects.get_or_create(slug="nexus-qa-check", defaults={"name": "Nexus QA check (synthetic)", "created_by": u})
Membership.objects.get_or_create(workspace=ws, user=u, defaults={"role": Role.OWNER})
ensure_subscription(ws)
assign_manual_plan(ws, Plan.objects.get(code="business"))
org, _ = OrgSettings.objects.get_or_create(workspace=ws)
org.business_profiles = ["general", "lending"]
org.save()
for kind in ("general", "lending"):
    if not Pipeline.objects.filter(workspace=ws, kind=kind).exists():
        create_default_pipeline(ws, kind, user=u)
ensure_nexus_web_client()
value = secrets.token_urlsafe(64)
t = Token(type=Token.Type.ACCESS_TOKEN, hash=get_adapter().hash_token(value), client_id="nexus-web", user=u,
          expires_at=timezone.now() + timedelta(seconds=600))
t.set_scopes(["workspace:read", "workspace:write"])
t.save()
print("WS=" + str(ws.pk))
print("TOKEN=" + value)
