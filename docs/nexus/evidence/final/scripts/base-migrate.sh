#!/usr/bin/env bash
# Real-database upgrade check: a database at the BASE Lumen schema (eefa6ab's own migrations),
# existing users/workspaces/memberships/invitations/plans written by eefa6ab's own code, then
# this branch's migrate on top. Throwaway database nexus_basemig on nexus-pg (55433).
set -euo pipefail
S=/tmp/claude-0/-home-user/e6bb18e2-ef15-525e-9375-04c4a4514dbf/scratchpad/qa
REPO=/home/user/nexus
BASE="$S/base-eefa6ab"
DB=nexus_basemig
PY=/home/user/nexus-venv/bin/python
psql() { docker exec -i nexus-pg psql -v ON_ERROR_STOP=1 -U lumen_app "$@"; }

echo "### base code: git archive eefa6ab services/portal (no worktree, no branch touched)"
rm -rf "$BASE"; mkdir -p "$BASE"
git -C "$REPO" archive eefa6ab services/portal | tar -x -C "$BASE"
echo "eefa6ab = $(git -C "$REPO" log -1 --format='%h %s' eefa6ab)"

echo "### fresh database $DB"
psql -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"

# shellcheck disable=SC1091
. "$REPO/dev/nexus/env.sh" >/dev/null
export POSTGRES_DB=$DB

echo "### 1. eefa6ab's migrate (base Lumen schema)"
(cd "$BASE/services/portal" && "$PY" manage.py migrate --noinput | tail -3)
(cd "$BASE/services/portal" && "$PY" manage.py showmigrations workspaces billing 2>&1)
(cd "$BASE/services/portal" && "$PY" manage.py lumen_bootstrap >/dev/null && echo "lumen_bootstrap (base) ok")

echo "### 2. existing rows written by eefa6ab's code"
(cd "$BASE/services/portal" && "$PY" manage.py shell -c '
from django.contrib.auth import get_user_model
from apps.workspaces.models import Workspace, Membership, Invitation, Role
from apps.billing.models import Plan
U = get_user_model()
mk = lambda n: U.objects.create_user(username=n, email=f"{n}@example.com", password="base-upgrade-test-pass-1")
own, adm, mem, solo = mk("base-owner"), mk("base-admin"), mk("base-member"), mk("base-solo")
w1 = Workspace.objects.create(name="Base Workspace One", slug="base-one", created_by=own, require_mfa=True)
w2 = Workspace.objects.create(name="Base Workspace Two", slug="base-two", created_by=solo, allow_member_invites=True)
Membership.objects.create(workspace=w1, user=own, role=Role.OWNER)
Membership.objects.create(workspace=w1, user=adm, role=Role.ADMIN)
Membership.objects.create(workspace=w1, user=mem, role=Role.MEMBER)
Membership.objects.create(workspace=w2, user=solo, role=Role.OWNER)
Membership.objects.create(workspace=w2, user=mem, role=Role.ADMIN)
Invitation.issue(workspace=w1, email="Invitee.Admin@example.com", role=Role.ADMIN, invited_by=own)
Invitation.issue(workspace=w1, email="invitee.member@example.com", role=Role.MEMBER, invited_by=adm)
i3, _ = Invitation.issue(workspace=w2, email="revoked@example.com", role=Role.MEMBER, invited_by=solo)
from django.utils import timezone
i3.revoked_at = timezone.now(); i3.save()
p = Plan.objects.order_by("pk").first()
p.entitlements["max_members"] = 4242   # an operator-edited value that must survive the upgrade
p.save()
print("base plans:", list(Plan.objects.values_list("code", flat=True)), "| operator value on", p.code, "max_members=4242")
')

snapshot() {
  psql -d "$DB" -At -c "SELECT 'user', username, email, is_active FROM accounts_user WHERE username LIKE 'base-%' ORDER BY username" \
    -c "SELECT 'workspace', id, name, slug, require_mfa, allow_member_invites FROM workspaces_workspace WHERE slug LIKE 'base-%' ORDER BY slug" \
    -c "SELECT 'membership', w.slug, u.username, m.role FROM workspaces_membership m JOIN workspaces_workspace w ON w.id=m.workspace_id JOIN accounts_user u ON u.id=m.user_id WHERE w.slug LIKE 'base-%' ORDER BY w.slug, u.username" \
    -c "SELECT 'invitation', w.slug, i.email, i.role, i.token_hash, (i.revoked_at IS NOT NULL) FROM workspaces_invitation i JOIN workspaces_workspace w ON w.id=i.workspace_id WHERE w.slug LIKE 'base-%' ORDER BY i.email"
}
snapshot > "$S/basemig-before.txt"
echo "rows before the upgrade: $(wc -l < "$S/basemig-before.txt")"
cat "$S/basemig-before.txt" | sed -E 's/\|[0-9a-f]{64}\|/|<token_hash>|/'

echo "### 3. this branch's migrate on the same database ($(git -C "$REPO" rev-parse --short HEAD))"
(cd "$REPO/services/portal" && "$PY" manage.py migrate --noinput 2>&1 | grep -E "Applying|No migrations" )
(cd "$REPO/services/portal" && "$PY" manage.py migrate --check --noinput && echo "migrate --check: nothing left to apply")
(cd "$REPO/services/portal" && "$PY" manage.py lumen_bootstrap >/dev/null && echo "lumen_bootstrap (branch) ok")

echo "### 4. the same rows after the upgrade"
snapshot > "$S/basemig-after.txt"
if diff -u "$S/basemig-before.txt" "$S/basemig-after.txt"; then echo "IDENTICAL: every existing user, workspace, membership and invitation row survived unchanged"; else echo "ROWS CHANGED"; exit 1; fi

echo "### 5. roles map correctly in this branch's code"
(cd "$REPO/services/portal" && "$PY" manage.py shell -c '
from django.contrib.auth import get_user_model
from apps.workspaces.models import Workspace, Membership, Invitation, Role
from apps.crm import access
from apps.crm.access import Cap
U = get_user_model()
w1, w2 = Workspace.objects.get(slug="base-one"), Workspace.objects.get(slug="base-two")
for m in Membership.objects.filter(workspace__slug__startswith="base-").select_related("user", "workspace").order_by("workspace__slug", "user__username"):
    a = access.actor_for(m.user, m.workspace.pk)
    print(f"{m.workspace.slug:9} {m.user.username:12} stored={m.role:7} label={m.get_role_display():12} view_level={a.view_level:5} "
          f"configure={a.can(Cap.CRM_CONFIGURE)!s:5} org_settings={a.can(Cap.ORG_SETTINGS)!s:5} records_create={a.can(Cap.RECORDS_CREATE)!s:5}")
for i in Invitation.objects.filter(workspace__slug__startswith="base-").order_by("email"):
    print(f"invitation {i.email:28} stored={i.role:7} label={i.get_role_display():12} state={i.state}")
expected = {("base-one","base-owner"):"owner",("base-one","base-admin"):"admin",("base-one","base-member"):"member",("base-two","base-solo"):"owner",("base-two","base-member"):"admin"}
got = {(m.workspace.slug, m.user.username): m.role for m in Membership.objects.filter(workspace__slug__startswith="base-").select_related("user","workspace")}
assert got == expected, got
assert Membership.objects.get(workspace=w1, user__username="base-member").get_role_display() == "Team member"
from apps.crm.models import OrgSettings
print("business profiles after upgrade (none until an owner opts in):", {w.slug: list(OrgSettings.objects.filter(workspace=w).values_list("business_profiles", flat=True)) for w in (w1, w2)})
from apps.billing.models import Plan
p = Plan.objects.order_by("pk").first()
print("plan", p.code, "after the branch bootstrap: max_members =", p.entitlements.get("max_members"), "| new keys:", {k: p.entitlements.get(k) for k in ("crm_enabled", "crm_max_contacts", "vertical_profiles")})
assert p.entitlements.get("max_members") == 4242, "operator value overwritten"
assert all(k in p.entitlements for k in ("crm_enabled", "crm_max_contacts", "vertical_profiles"))
print("ROLE MAPPING OK")
')
(cd "$REPO/services/portal" && "$PY" manage.py check 2>&1 | tail -2)
echo "### cleanup"
psql -d postgres -c "DROP DATABASE $DB"
rm -rf "$BASE"
echo "done"
