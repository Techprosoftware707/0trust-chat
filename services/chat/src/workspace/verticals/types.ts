/** Shapes of the verticals, meetings, reports and automation APIs (docs/nexus/ARCHITECTURE.md). */

import type { CalendarEvent, Opportunity, Permissions, Pipeline, Stage, Task, UserRef } from "../types";

export interface Ref {
  id: string;
  display_name?: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
}

export type PropertyStatus = "prospect" | "coming_soon" | "active" | "under_contract" | "sold" | "leased" | "withdrawn" | "off_market";

export interface Property {
  id: string;
  type: "crm.property";
  display_name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  listing_type: "sale" | "rent";
  property_type: string;
  status: PropertyStatus;
  status_label: string;
  list_price: string | null;
  currency: string;
  bedrooms: number | null;
  bathrooms: string | null;
  area: number | null;
  area_unit: "sqft" | "sqm";
  year_built: number | null;
  headline: string;
  description: string;
  listed_at: string | null;
  notes: string;
  source: "manual" | "import" | "integration";
  source_label: string;
  source_detail: string;
  owner: UserRef | null;
  visibility: "team" | "private";
  archived: boolean;
  is_demo: boolean;
  updated_at: string;
  permissions: Permissions;
}

export interface PropertyBrief {
  id: string;
  display_name: string;
  status: PropertyStatus;
  list_price: string | null;
  currency: string;
  city: string;
}

export interface PropertyContactLink {
  id: string;
  contact: { id: string; display_name: string; kind: string };
  role: string;
  role_label: string;
  property?: PropertyBrief | null;
  permissions: Permissions;
}

export interface DealPropertyLink {
  id: string;
  property: PropertyBrief;
  opportunity: { id: string; name: string; status: string };
  role: string;
  role_label: string;
  permissions: Permissions;
}

export interface PropertyDetail extends Property {
  contacts: PropertyContactLink[];
  deals: DealPropertyLink[];
  viewings: CalendarEventFull[];
}

export interface CalendarEventFull extends CalendarEvent {
  type: "crm.calendarevent";
  kind: EventKind;
  description: string;
  all_day: boolean;
  attendee_users: UserRef[];
  attendee_contacts: { id: string; display_name: string; kind: string }[];
  contact: { id: string; display_name: string; kind: string } | null;
  opportunity: { id: string; name: string; status: string } | null;
  related: { type: string; id: string } | null;
  visibility: "team" | "private";
  is_demo: boolean;
  permissions: Permissions;
  note_count?: number;
}

export type EventKind = "meeting" | "viewing" | "call" | "closing" | "appointment" | "other";

export interface Preferences {
  id: string;
  listing_type: "sale" | "rent";
  budget_min: string | null;
  budget_max: string | null;
  currency: string;
  areas: string[];
  property_types: string[];
  bedrooms_min: number | null;
  bathrooms_min: string | null;
  area_min: number | null;
  must_haves: string[];
  nice_to_haves: string[];
  timeline: string;
  timeline_label: string;
  move_by: string | null;
  notes: string;
  updated_at: string;
}

export type Urgency = "done" | "overdue" | "due_soon" | "upcoming" | "no_date";

export interface Milestone {
  id: string;
  category: "milestone" | "deadline";
  milestone_type: string;
  milestone_type_label: string;
  title: string;
  due_date: string | null;
  status: "pending" | "done" | "waived" | "missed";
  urgency: Urgency;
  completed_at: string | null;
  completed_by: UserRef | null;
  amount: string | null;
  currency: string;
  notes: string;
  responsible: UserRef | null;
  opportunity: { id: string; name: string } | null;
  application: { id: string; reference: string; title: string } | null;
  is_demo: boolean;
  permissions: Permissions;
}

export interface DealVertical {
  opportunity: Opportunity;
  contacts: { id: string; display_name: string; role: string; role_label: string }[];
  properties: DealPropertyLink[];
  milestones: Milestone[];
  applications: LendingApplication[];
  deadline_templates: string[];
  due_soon_days: number;
  can_change: boolean;
}

export interface ContactVertical {
  real_estate: {
    preferences: Preferences | null;
    viewings: CalendarEventFull[];
    properties: PropertyContactLink[];
    can_edit: boolean;
  } | null;
  lending: { applications: LendingApplication[] } | null;
}

// --- lending ---------------------------------------------------------------------------------------

export type ChecklistStatus = "pending" | "requested" | "received" | "accepted" | "rejected" | "waived";

export interface ChecklistProgress {
  total: number;
  required: number;
  complete: number;
  outstanding: number;
  awaiting_review: number;
  overdue: number;
  by_status: Record<ChecklistStatus, number>;
  percent: number;
}

export interface SecureDocumentMeta {
  id: string;
  name: string;
  content_type: string;
  size: number;
  checklist_item_id: string | null;
  uploaded_by: UserRef | null;
  uploaded_at: string;
  encrypted: true;
}

export interface ChecklistItem {
  id: string;
  name: string;
  description: string;
  required: boolean;
  status: ChecklistStatus;
  status_label: string;
  outstanding: boolean;
  overdue: boolean;
  due_date: string | null;
  requested_at: string | null;
  requested_by: UserRef | null;
  received_at: string | null;
  reviewed_at: string | null;
  reviewed_by: UserRef | null;
  internal_note: string;
  task_id: string | null;
  documents: SecureDocumentMeta[];
  permissions: Permissions;
}

export interface LendingApplication {
  id: string;
  type: "crm.lendingapplication";
  reference: string;
  title: string;
  pipeline_id: string;
  stage: { id: string; name: string; position: number };
  stage_entered_at: string;
  borrowers: { id: string; display_name: string; kind: string; role: string }[];
  hidden_borrowers: number;
  loan_officer: UserRef | null;
  product_type: string;
  product_label: string;
  amount_requested: string | null;
  currency: string;
  status: "active" | "on_hold" | "withdrawn" | "completed";
  decision: "" | "approved" | "conditional" | "declined";
  decision_label: string;
  decision_note: string;
  decision_by: UserRef | null;
  decision_at: string | null;
  opportunity: { id: string; name: string; status: string } | null;
  property: PropertyBrief | null;
  target_close_date: string | null;
  checklist: ChecklistProgress;
  is_demo: boolean;
  updated_at: string;
  permissions: Permissions & { decide: boolean; view_access_log: boolean };
}

export interface OutstandingWork {
  kind: "missing_document" | "rejected_document" | "review_document" | "milestone" | "task";
  id: string;
  title: string;
  due_date: string | null;
  overdue: boolean;
  status: string;
}

export interface LendingApplicationDetail extends LendingApplication {
  checklist_items: ChecklistItem[];
  other_documents: SecureDocumentMeta[];
  outstanding_work: OutstandingWork[];
  milestones: Milestone[];
  pipeline: Pipeline;
  can_request_from_borrower: false;
  storage_ready: boolean;
  max_upload_bytes: number;
  allowed_types: string[];
}

export interface LendingBoard {
  pipeline: Pipeline | null;
  pipelines: Pipeline[];
  columns: { stage: Stage; count: number; applications: LendingApplication[] }[];
  can_create: boolean;
  can_configure?: boolean;
}

export interface ApplicationNote {
  id: string;
  body: string;
  visibility: "staff" | "managers" | "private";
  visibility_label: string;
  author: UserRef | null;
  created_at: string;
  permissions: Permissions;
}

export interface AccessLogRow {
  id: string;
  action: "upload" | "grant" | "download" | "denied" | "delete";
  action_label: string;
  document_id: string | null;
  document_name: string;
  user: UserRef | null;
  reason: string;
  at: string;
}

// --- meetings ---------------------------------------------------------------------------------------

export interface MeetingNote {
  id: string;
  title: string;
  body: string;
  visibility: "team" | "attendees" | "private";
  visibility_label: string;
  event: { id: string; title: string; kind: string; start_at: string; end_at: string; matrix_room_id: string } | null;
  contact: { id: string; display_name: string } | null;
  opportunity: { id: string; name: string } | null;
  room_id: string;
  author: UserRef | null;
  created_at: string;
  permissions: Permissions;
}

export interface ActionItem {
  id: string;
  title: string;
  description: string;
  status: "proposed" | "confirmed" | "dismissed";
  source: "manual" | "ai_suggestion";
  source_label: string;
  suggested_assignee: UserRef | null;
  suggested_due_at: string | null;
  note_id: string | null;
  event: { id: string; title: string } | null;
  contact: { id: string; display_name: string } | null;
  opportunity: { id: string; name: string } | null;
  proposed_by: UserRef | null;
  decided_by: UserRef | null;
  decided_at: string | null;
  task_id: string | null;
  created_at: string;
  permissions: Permissions;
}

// --- home / reports ----------------------------------------------------------------------------------

/** One connected service's state, from apps/integrations/health.py (the integrations team). */
export interface ServiceHealth {
  service: string;
  label: string;
  status: "connected" | "needs_reauth" | "error" | "not_connected" | "not_configured" | string;
  status_label?: string;
  detail?: string;
  checked_at?: string | null;
  link?: string;
  mock?: boolean;
  mock_label?: string | null;
}

export interface HomeExtras {
  meetings_today?: CalendarEventFull[];
  approaching_deadlines?: Milestone[];
  applications_missing_documents?: { id: string; reference: string; title: string; missing: number; stage: string; target_close_date: string | null }[] | null;
  suggested_next_steps?: number;
  connected_services?: ServiceHealth[] | null;
}

export interface PipelineReport {
  pipeline: { id: string; name: string; kind: string; currency: string } | null;
  stages: { id: string; name: string; is_won: boolean; is_lost: boolean; probability: number | null; count: number; value: string; weighted_value: string }[];
  owners: { owner: UserRef | null; count: number; value: string }[];
  totals: { open_count?: number; open_value?: string; weighted_value?: string; won_count?: number; won_value?: string; lost_count?: number };
}

export interface TeamWeek {
  week_start: string;
  new_count: number;
  new_value: string;
  moved_count: number;
  won_count: number;
  won_value: string;
  lost_count: number;
  people: { owner: UserRef | null; new: number; new_value: string; won: number; won_value: string; lost: number }[];
}

export interface ActivityReport {
  days: number;
  total: number;
  by_kind: Record<string, number>;
  by_person: { person: UserRef | null; count: number }[];
  per_day: { date: string; count: number }[];
}

export interface TaskReport {
  days: number;
  created: number;
  completed: number;
  open: number;
  overdue: number;
  due_in_period: number;
  completed_on_time: number;
  on_time_rate: number | null;
  by_source: Record<string, number>;
  people: { person: UserRef | null; open: number; overdue: number; done: number }[];
}

export interface LendingReport {
  available: boolean;
  applications?: number;
  amount_requested?: string;
  by_stage?: { stage: string; count: number; amount: string }[];
  checklist?: Record<ChecklistStatus, number>;
  outstanding_required?: number;
  overdue_items?: number;
  applications_missing_documents?: number;
  awaiting_review?: number;
  decisions?: Record<string, number>;
}

export interface DeadlinesReport {
  days: number;
  count: number;
  overdue: number;
  due_soon: number;
  items: {
    id: string;
    title: string;
    category: string;
    type: string;
    due_date: string | null;
    urgency: Urgency;
    opportunity: { id: string; name: string } | null;
    application: { id: string; reference: string } | null;
    responsible: UserRef | null;
  }[];
}

// --- automation ---------------------------------------------------------------------------------------

export interface RuleAction {
  type: "assign_owner" | "create_task" | "notify_user" | "update_related_tasks";
  params: Record<string, unknown>;
}

export interface RuleCondition {
  field: string;
  op: "equals" | "not_equals" | "in" | "contains";
  value: string | boolean | number | (string | boolean | number)[];
}

export interface AutomationRule {
  id: string;
  name: string;
  description: string;
  trigger: string;
  trigger_label: string;
  conditions: RuleCondition[];
  actions: RuleAction[];
  enabled: boolean;
  template_key: string;
  max_runs_per_hour: number;
  run_count: number;
  last_run_at: string | null;
  last_status: string;
  owner: UserRef | null;
  is_demo: boolean;
  updated_at: string;
}

export interface AutomationCatalog {
  triggers: { value: string; label: string; condition_fields: string[]; actions: string[]; placeholders: string[] }[];
  operators: string[];
  actions: { value: string; label: string }[];
  recipients: { value: string; label: string }[];
  assignees: { value: string; label: string }[];
  external_actions: string;
}

export interface Execution {
  id: string;
  rule: { id: string; name: string };
  event: { type: string; subject: { type: string; id: string | null }; depth: number };
  status: string;
  status_label: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string;
  result: { actions?: Record<string, unknown>[] };
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  can_retry: boolean;
}

export interface NotificationRow {
  id: string;
  event_type: string;
  title: string;
  body: string;
  link: string;
  count: number;
  read: boolean;
  created_at: string;
  updated_at: string;
}

export interface NotificationPrefs {
  scope: "user" | "workspace";
  muted: boolean;
  muted_until: string | null;
  grouping: boolean;
  events: Record<string, boolean>;
  event_labels: Record<string, string>;
}

export interface PreferencesResponse {
  mine: NotificationPrefs;
  workspace: NotificationPrefs;
  effective: { muted: boolean; muted_until: string | null; grouping: boolean; events: Record<string, boolean> };
  can_edit_workspace: boolean;
}

export type { Task };
