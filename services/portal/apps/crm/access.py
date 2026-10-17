"""Authorization of business records: the ONE place that decides who sees and changes what.

Every API view (and every service another team writes) goes through this module:

    actor = actor_for(user, workspace_id)            # 404 unless the user is a member
    qs = for_actor(actor, Contact)                    # tenant-scoped, role-filtered queryset
    obj = get_for_actor(actor, Contact, pk, "change") # 404 if invisible, 403 if visible but read-only
    require(actor, Cap.CRM_CONFIGURE)                 # role capability, 403 otherwise

Rules (see the matrix in docs/nexus/ARCHITECTURE.md):

* owner, admin: everything in the workspace;
* manager: everything except workspace settings and owning integrations;
* agent ("Agent / Broker"): records they own, are assigned to or collaborate on, plus records
  shared with the team; changes only their own/assigned/collaborating records;
* member ("Team member"): reads records shared with the team, creates and works on their own
  tasks;
* readonly: reads records shared with the team.

Objects the actor may not see do not exist for them (404, never 403), so IDs of other
workspaces or private records cannot be probed. Hiding something in the UI is never
authorization: the API enforces all of this.

Other teams register their own record types with ``register(Model, policy)`` so generic
references (``related_type``/``related_id``, ``RecordLink``, ``ExternalRecordMapping``) are
resolved and authorized here too.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import StrEnum
from functools import cached_property

from django.conf import settings
from django.core.exceptions import PermissionDenied
from django.db.models import Model, Q, QuerySet
from django.http import Http404

from apps.api.errors import ValidationFailed
from apps.core.audit import audit
from apps.workspaces.models import Membership, Role
from apps.workspaces.services import membership_for

from . import models as m


class Cap(StrEnum):
    ORG_SETTINGS = "org.settings"  # business profiles, policies (save to record), demo flag
    INTEGRATIONS_OWN = "integrations.own"  # connect/disconnect workspace-wide integrations
    CRM_CONFIGURE = "crm.configure"  # pipelines, stages, custom fields, tag rename/delete
    RECORDS_VIEW_ALL = "records.view_all"  # every record, private ones too
    RECORDS_VIEW_SCOPED = "records.view_scoped"  # own/assigned/collaborating + shared
    RECORDS_VIEW_TEAM = "records.view_team"  # records shared with the team
    RECORDS_CREATE = "records.create"  # contacts, opportunities
    RECORDS_CHANGE_ALL = "records.change_all"
    RECORDS_CHANGE_OWN = "records.change_own"  # own/assigned/collaborating
    RECORDS_DELETE_ALL = "records.delete_all"
    RECORDS_DELETE_OWN = "records.delete_own"  # records they own
    ACTIVITIES_CREATE = "activities.create"  # notes, calls, meetings, conversation links
    TASKS_CREATE = "tasks.create"  # tasks for anyone in the workspace
    TASKS_CREATE_OWN = "tasks.create_own"  # tasks for themselves
    TAGS_CREATE = "tags.create"
    EVENTS_CREATE = "events.create"
    MAPPINGS_VIEW = "mappings.view"  # external record mappings
    MEMBERS_VIEW = "members.view"
    # Lending (verticals): applications, checklists, secure documents. LENDING_SENSITIVE sees
    # every application; LENDING_ACCESS alone (agents/brokers) only the ones assigned to them.
    LENDING_ACCESS = "lending.access"
    LENDING_SENSITIVE = "lending.sensitive"
    LENDING_DECIDE = "lending.decide"  # record a decision (authorised staff; never automatic)
    AUTOMATION_MANAGE = "automation.manage"  # automation rules, their history and retries
    REPORTS_VIEW = "reports.view"  # team reports (aggregated server-side)


_ALL = frozenset(Cap)
_MANAGER = _ALL - {Cap.ORG_SETTINGS, Cap.INTEGRATIONS_OWN}
ROLE_CAPABILITIES: dict[str, frozenset[Cap]] = {
    Role.OWNER: _ALL,
    Role.ADMIN: _ALL,
    Role.MANAGER: _MANAGER,
    Role.AGENT: frozenset(
        {
            Cap.RECORDS_VIEW_SCOPED, Cap.RECORDS_CREATE, Cap.RECORDS_CHANGE_OWN, Cap.RECORDS_DELETE_OWN,
            Cap.ACTIVITIES_CREATE, Cap.TASKS_CREATE, Cap.TASKS_CREATE_OWN, Cap.TAGS_CREATE, Cap.EVENTS_CREATE,
            Cap.MEMBERS_VIEW, Cap.LENDING_ACCESS,
        }
    ),
    Role.MEMBER: frozenset({Cap.RECORDS_VIEW_TEAM, Cap.TASKS_CREATE_OWN, Cap.EVENTS_CREATE, Cap.MEMBERS_VIEW}),
    Role.READONLY: frozenset({Cap.RECORDS_VIEW_TEAM, Cap.MEMBERS_VIEW}),
}

VIEW, CHANGE, DELETE = "view", "change", "delete"
ACTIONS = (VIEW, CHANGE, DELETE)


@dataclass(frozen=True)
class Actor:
    """A user acting inside one workspace (resolved once per request)."""

    user: object
    membership: Membership
    token: object = field(default=None, compare=False)

    @property
    def workspace(self):
        return self.membership.workspace

    @property
    def workspace_id(self):
        return self.membership.workspace_id

    @property
    def role(self) -> str:
        return self.membership.role

    @property
    def capabilities(self) -> frozenset[Cap]:
        return ROLE_CAPABILITIES.get(self.role, frozenset())

    def can(self, cap: Cap) -> bool:
        return cap in self.capabilities

    @property
    def view_level(self) -> str:
        if self.can(Cap.RECORDS_VIEW_ALL):
            return "all"
        if self.can(Cap.RECORDS_VIEW_SCOPED):
            return "scoped"
        if self.can(Cap.RECORDS_VIEW_TEAM):
            return "team"
        return "none"

    @cached_property
    def features(self) -> dict[str, bool]:
        from apps.api.features import workspace_features

        return workspace_features(self.workspace)


def actor_for(user, workspace_id, *, token=None) -> Actor:
    """The user's actor in ``workspace_id``; ``Http404`` if they are not a member."""
    try:
        uuid.UUID(str(workspace_id))
    except ValueError:
        raise Http404() from None
    return Actor(user=user, membership=membership_for(user, workspace_id), token=token)


def require(actor: Actor, cap: Cap, message: str = "") -> None:
    if not actor.can(cap):
        raise PermissionDenied(message or "Your role doesn't allow that.")


# --- policies ---------------------------------------------------------------------------


class Policy:
    """How one model is filtered for an actor and action (view, change, delete)."""

    model: type[Model]

    def queryset(self, actor: Actor, action: str) -> QuerySet:  # pragma: no cover - interface
        raise NotImplementedError

    def base(self, actor: Actor) -> QuerySet:
        return self.model.objects.filter(workspace_id=actor.workspace_id)


def _none(qs: QuerySet) -> QuerySet:
    return qs.none()


class ContactPolicy(Policy):
    model = m.Contact

    def _mine(self, actor: Actor) -> Q:
        assigned = m.Contact.assignees.through.objects.filter(user_id=actor.user.pk).values("contact_id")
        return Q(owner_id=actor.user.pk) | Q(pk__in=assigned)

    def queryset(self, actor, action):
        qs = self.base(actor)
        level = actor.view_level
        if action == VIEW:
            if level == "all":
                return qs
            if level == "scoped":
                return qs.filter(Q(visibility=m.Visibility.TEAM) | self._mine(actor) | Q(created_by_id=actor.user.pk))
            if level == "team":
                return qs.filter(visibility=m.Visibility.TEAM)
            return _none(qs)
        if action == CHANGE:
            if actor.can(Cap.RECORDS_CHANGE_ALL):
                return qs
            if actor.can(Cap.RECORDS_CHANGE_OWN):
                return qs.filter(self._mine(actor))
            return _none(qs)
        if action == DELETE:
            if actor.can(Cap.RECORDS_DELETE_ALL):
                return qs
            if actor.can(Cap.RECORDS_DELETE_OWN):
                return qs.filter(owner_id=actor.user.pk)
            return _none(qs)
        raise ValueError(action)


class OpportunityPolicy(Policy):
    model = m.Opportunity

    def _mine(self, actor: Actor) -> Q:
        collab = m.Opportunity.collaborators.through.objects.filter(user_id=actor.user.pk).values("opportunity_id")
        return Q(owner_id=actor.user.pk) | Q(pk__in=collab)

    def queryset(self, actor, action):
        qs = self.base(actor)
        level = actor.view_level
        if action == VIEW:
            if level == "all":
                return qs
            if level == "scoped":
                return qs.filter(Q(visibility=m.Visibility.TEAM) | self._mine(actor) | Q(created_by_id=actor.user.pk))
            if level == "team":
                return qs.filter(visibility=m.Visibility.TEAM)
            return _none(qs)
        if action == CHANGE:
            if actor.can(Cap.RECORDS_CHANGE_ALL):
                return qs
            if actor.can(Cap.RECORDS_CHANGE_OWN):
                return qs.filter(self._mine(actor))
            return _none(qs)
        if action == DELETE:
            if actor.can(Cap.RECORDS_DELETE_ALL):
                return qs
            if actor.can(Cap.RECORDS_DELETE_OWN):
                return qs.filter(owner_id=actor.user.pk)
            return _none(qs)
        raise ValueError(action)


def _parents_visible(actor: Actor, *, contact: str = "contact", opportunity: str = "opportunity") -> Q:
    """Rows whose related contact/opportunity (when set) are visible to the actor."""
    vc = ContactPolicy().queryset(actor, VIEW).values("pk")
    vo = OpportunityPolicy().queryset(actor, VIEW).values("pk")
    return (Q(**{f"{contact}__isnull": True}) | Q(**{f"{contact}__in": vc})) & (
        Q(**{f"{opportunity}__isnull": True}) | Q(**{f"{opportunity}__in": vo})
    )


class TaskPolicy(Policy):
    model = m.Task

    def queryset(self, actor, action):
        qs = self.base(actor)
        u = actor.user.pk
        if action == VIEW:
            if actor.view_level == "all":
                return qs
            if actor.view_level == "none":
                return _none(qs)
            shared = Q(visibility=m.Visibility.TEAM) & _parents_visible(actor)
            return qs.filter(Q(assignee_id=u) | Q(created_by_id=u) | shared)
        if action in (CHANGE, DELETE):
            if actor.can(Cap.RECORDS_CHANGE_ALL):
                return qs
            if action == CHANGE and (actor.can(Cap.TASKS_CREATE) or actor.can(Cap.TASKS_CREATE_OWN)):
                return qs.filter(Q(assignee_id=u) | Q(created_by_id=u))
            if action == DELETE and (actor.can(Cap.TASKS_CREATE) or actor.can(Cap.TASKS_CREATE_OWN)):
                return qs.filter(created_by_id=u)
            return _none(qs)
        raise ValueError(action)


class ActivityPolicy(Policy):
    model = m.Activity
    EDITABLE_KINDS = (m.Activity.Kind.NOTE, m.Activity.Kind.CALL, m.Activity.Kind.MEETING)

    def queryset(self, actor, action):
        qs = self.base(actor)
        u = actor.user.pk
        if action == VIEW:
            if actor.view_level == "all":
                return qs
            if actor.view_level == "none":
                return _none(qs)
            vt = TaskPolicy().queryset(actor, VIEW).values("pk")
            has_parent = Q(contact__isnull=False) | Q(opportunity__isnull=False) | Q(task__isnull=False)
            parents_ok = _parents_visible(actor) & (Q(task__isnull=True) | Q(task__in=vt))
            return qs.filter((has_parent & parents_ok) | (~has_parent & Q(created_by_id=u)))
        if action in (CHANGE, DELETE):
            if actor.can(Cap.RECORDS_CHANGE_ALL):
                return qs
            if actor.can(Cap.ACTIVITIES_CREATE):
                return qs.filter(created_by_id=u, source=m.Activity.Source.NATIVE, kind__in=self.EDITABLE_KINDS)
            return _none(qs)
        raise ValueError(action)


class CalendarEventPolicy(Policy):
    model = m.CalendarEvent

    def queryset(self, actor, action):
        qs = self.base(actor)
        u = actor.user.pk
        if action == VIEW:
            if actor.view_level == "all":
                return qs
            if actor.view_level == "none":
                return _none(qs)
            attending = m.CalendarEvent.attendee_users.through.objects.filter(user_id=u).values("calendarevent_id")
            shared = Q(visibility=m.Visibility.TEAM) & _parents_visible(actor)
            return qs.filter(Q(organizer_id=u) | Q(created_by_id=u) | Q(pk__in=attending) | shared)
        if action in (CHANGE, DELETE):
            if actor.can(Cap.RECORDS_CHANGE_ALL):
                return qs
            if actor.can(Cap.EVENTS_CREATE):
                return qs.filter(Q(organizer_id=u) | Q(created_by_id=u))
            return _none(qs)
        raise ValueError(action)


class ConfigPolicy(Policy):
    """Pipelines, stages, custom field definitions: everyone with record access reads
    them; managers and up change them."""

    def __init__(self, model):
        self.model = model

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action == VIEW:
            return qs if actor.view_level != "none" else _none(qs)
        return qs if actor.can(Cap.CRM_CONFIGURE) else _none(qs)


class StagePolicy(ConfigPolicy):
    def __init__(self):
        super().__init__(m.Stage)


class StageHistoryPolicy(Policy):
    model = m.StageHistory

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action == VIEW:
            return qs.filter(opportunity__in=OpportunityPolicy().queryset(actor, VIEW).values("pk"))
        return _none(qs)  # history is written by the server only


class ConversationLinkPolicy(Policy):
    model = m.ConversationLink

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action == VIEW:
            if actor.view_level == "none":
                return _none(qs)
            return qs.filter(_parents_visible(actor))
        if actor.can(Cap.RECORDS_CHANGE_ALL):
            return qs
        if actor.can(Cap.ACTIVITIES_CREATE):
            return qs.filter(created_by_id=actor.user.pk)
        return _none(qs)


class MappingPolicy(Policy):
    model = m.ExternalRecordMapping

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action == VIEW and actor.can(Cap.MAPPINGS_VIEW):
            return qs
        # Mappings are written by the server (integration sync), never through the API.
        return _none(qs)


class RecordLinkPolicy(Policy):
    model = m.RecordLink

    def queryset(self, actor, action):
        qs = self.base(actor)
        if actor.view_level == "none":
            return _none(qs)
        if action == VIEW:
            # Both ends must be visible; checked per row by the caller via resolve_ref,
            # because the ends can be of any registered type.
            return qs
        if actor.can(Cap.RECORDS_CHANGE_ALL):
            return qs
        if actor.can(Cap.RECORDS_CREATE):
            return qs.filter(created_by_id=actor.user.pk)
        return _none(qs)


class TagPolicy(Policy):
    model = m.Tag

    def queryset(self, actor, action):
        qs = self.base(actor)
        if action == VIEW:
            return qs if actor.view_level != "none" else _none(qs)
        return qs if actor.can(Cap.CRM_CONFIGURE) else _none(qs)


# --- registry ---------------------------------------------------------------------------

_POLICIES: dict[type[Model], Policy] = {}
_TYPES: dict[str, type[Model]] = {}


def register(model: type[Model], policy: Policy, *, referencable: bool = True) -> None:
    """Registers ``model``'s access policy. With ``referencable`` the model can be the target
    of generic references (``related_type``/``related_id``, record links, mappings)."""
    policy.model = model
    _POLICIES[model] = policy
    if referencable:
        _TYPES[model._meta.label_lower] = model


for _model, _policy in [
    (m.Contact, ContactPolicy()),
    (m.Opportunity, OpportunityPolicy()),
    (m.Task, TaskPolicy()),
    (m.Activity, ActivityPolicy()),
    (m.CalendarEvent, CalendarEventPolicy()),
    (m.Pipeline, ConfigPolicy(m.Pipeline)),
    (m.Stage, StagePolicy()),
    (m.FieldDefinition, ConfigPolicy(m.FieldDefinition)),
    (m.Tag, TagPolicy()),
]:
    register(_model, _policy)
for _model, _policy in [
    (m.StageHistory, StageHistoryPolicy()),
    (m.ConversationLink, ConversationLinkPolicy()),
    (m.ExternalRecordMapping, MappingPolicy()),
    (m.RecordLink, RecordLinkPolicy()),
]:
    register(_model, _policy, referencable=False)


def policy_for(model: type[Model]) -> Policy:
    try:
        return _POLICIES[model]
    except KeyError:
        raise LookupError(f"No access policy registered for {model._meta.label}") from None


def for_actor(actor: Actor, model: type[Model], action: str = VIEW) -> QuerySet:
    """The rows of ``model`` the actor may ``action`` (view/change/delete), scoped to the
    actor's workspace. The ONLY way to list or look up tenant records."""
    if action not in ACTIONS:
        raise ValueError(action)
    return policy_for(model).queryset(actor, action)


def _as_uuid(pk) -> uuid.UUID | None:
    if isinstance(pk, uuid.UUID):
        return pk
    try:
        return uuid.UUID(str(pk))
    except (ValueError, TypeError, AttributeError):
        return None


def get_for_actor(actor: Actor, model: type[Model], pk, action: str = VIEW, *, queryset: QuerySet | None = None):
    """One object: ``Http404`` if it does not exist for the actor (other workspace, private,
    malformed ID), ``PermissionDenied`` if visible but not ``action``-able."""
    key = _as_uuid(pk)
    if key is None:
        raise Http404()
    visible = queryset if queryset is not None else for_actor(actor, model, VIEW)
    obj = visible.filter(pk=key).first()
    if obj is None:
        raise Http404()
    if action != VIEW and not for_actor(actor, model, action).filter(pk=key).exists():
        raise PermissionDenied("You can view this record but not change it.")
    return obj


def resolve(actor: Actor, model: type[Model], ids: Iterable, *, field_name: str, action: str = VIEW) -> list:
    """Objects for IDs sent in a request body. Unknown, other-workspace and invisible IDs
    give the same validation error, so bodies can't be used to probe IDs either."""
    keys = []
    for raw in ids:
        key = _as_uuid(raw)
        if key is None:
            raise ValidationFailed(fields={field_name: ["Unknown or inaccessible ID."]})
        keys.append(key)
    if not keys:
        return []
    found = {o.pk: o for o in for_actor(actor, model, action).filter(pk__in=keys)}
    if len(found) != len(set(keys)):
        raise ValidationFailed(fields={field_name: ["Unknown or inaccessible ID."]})
    return [found[k] for k in keys]


def resolve_one(actor: Actor, model: type[Model], raw, *, field_name: str, action: str = VIEW):
    if raw is None:
        return None
    return resolve(actor, model, [raw], field_name=field_name, action=action)[0]


def referencable_types() -> list[str]:
    return sorted(_TYPES)


def resolve_ref(actor: Actor, type_label: str, raw_id, *, field_name: str = "related"):
    """A generic reference (``{"type": "crm.contact", "id": ...}``) resolved for the actor."""
    model = _TYPES.get(type_label or "")
    if model is None:
        raise ValidationFailed(fields={field_name: ["Unknown record type."]})
    return resolve_one(actor, model, raw_id, field_name=field_name)


def ref_visible(actor: Actor, type_label: str, raw_id) -> bool:
    model = _TYPES.get(type_label or "")
    key = _as_uuid(raw_id)
    return bool(model and key and for_actor(actor, model, VIEW).filter(pk=key).exists())


def members(actor: Actor) -> QuerySet:
    """Memberships of the actor's workspace (for assignee pickers and owner fields)."""
    return Membership.objects.filter(workspace_id=actor.workspace_id).select_related("user")


def resolve_members(actor: Actor, public_ids: Iterable, *, field_name: str) -> list:
    """Users of the actor's workspace by ``public_id`` (the only user ID the API exposes)."""
    keys = []
    for raw in public_ids:
        key = _as_uuid(raw)
        if key is None:
            raise ValidationFailed(fields={field_name: ["Unknown workspace member."]})
        keys.append(key)
    if not keys:
        return []
    found = {ms.user.public_id: ms.user for ms in members(actor).filter(user__public_id__in=keys, user__is_active=True)}
    if len(found) != len(set(keys)):
        raise ValidationFailed(fields={field_name: ["Unknown workspace member."]})
    return [found[k] for k in keys]


def resolve_member(actor: Actor, public_id, *, field_name: str):
    if public_id is None:
        return None
    return resolve_members(actor, [public_id], field_name=field_name)[0]


# --- audit --------------------------------------------------------------------------------


def audit_write(request, actor: Actor, verb: str, obj, *, fields: Iterable[str] = (), extra: dict | None = None) -> None:
    """Hash-chained audit event for every write: ``crm.<type>.<verb>``. Field *names*
    only: record contents never go into the audit log."""
    meta = {"workspace": str(actor.workspace_id)}
    names = sorted(set(fields))
    if names:
        meta["fields"] = names
    if extra:
        meta.update(extra)
    audit(request, f"{obj._meta.app_label}.{obj._meta.model_name}.{verb}", target=obj, actor=actor.user, metadata=meta)


def audit_read(request, actor: Actor, obj, *, reason: str) -> None:
    """Audit hook for sensitive reads (contact details, sensitive custom fields, exports)."""
    if not settings.NEXUS_AUDIT_SENSITIVE_READS:
        return
    audit(
        request,
        f"{obj._meta.app_label}.{obj._meta.model_name}.read",
        target=obj,
        actor=actor.user,
        metadata={"workspace": str(actor.workspace_id), "reason": reason},
    )


# --- capability summary for clients ---------------------------------------------------------


def capability_summary(actor: Actor) -> dict[str, bool]:
    """What the SPA may offer (for showing/hiding controls; the API still enforces)."""
    return {cap.value: actor.can(cap) for cap in Cap}

