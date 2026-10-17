/** Shapes of the Nexus API (docs/nexus/ARCHITECTURE.md). Dates are ISO 8601 strings. */

export interface Page<T> {
  data: T[];
  page: { limit: number; next_cursor: string | null; total: number };
}

export interface UserRef {
  id: string;
  username: string;
  name: string;
  matrix_id: string;
}

export interface Member extends UserRef {
  role: Role;
  role_label: string;
}

export type Role = "owner" | "admin" | "manager" | "agent" | "member" | "readonly";
export type ViewLevel = "all" | "scoped" | "team" | "none";
export type Priority = "low" | "normal" | "high" | "urgent";
export type Visibility = "team" | "private";

export interface Permissions {
  change: boolean;
  delete: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  role_label: string;
  features: Record<string, boolean>;
}

export interface Me {
  user: UserRef;
  environment: string;
  scopes: string[];
  workspaces: WorkspaceSummary[];
}

export interface WorkspaceDetail {
  id: string;
  name: string;
  slug: string;
  role: Role;
  role_label: string;
  plan: { code: string; name: string };
  features: Record<string, boolean>;
  view_level: ViewLevel;
  capabilities: Record<string, boolean>;
  settings: { business_profiles: string[]; default_currency: string; save_to_record_enabled: boolean; is_demo: boolean };
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  contact_count?: number;
}

export type ContactKind = "lead" | "prospect" | "client" | "past_client" | "partner";

export interface Contact {
  id: string;
  type: "crm.contact";
  kind: ContactKind;
  roles: string[];
  first_name: string;
  last_name: string;
  display_name: string;
  company: string;
  job_title: string;
  email: string;
  phone: string;
  owner: UserRef | null;
  assignees: UserRef[];
  visibility: Visibility;
  source: string;
  campaign: string;
  follow_up_at: string | null;
  priority: Priority;
  tags: Tag[];
  custom_fields: Record<string, unknown>;
  last_activity_at: string | null;
  archived: boolean;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  permissions: Permissions;
}

export interface FieldDefinition {
  id: string;
  entity: "contact" | "opportunity";
  key: string;
  label: string;
  field_type: string;
  options: { value: string; label: string }[];
  required: boolean;
  sensitive: boolean;
  profile: string;
  position: number;
  archived: boolean;
}

export interface Stage {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  probability: number | null;
}

export interface Pipeline {
  id: string;
  name: string;
  kind: "general" | "real_estate" | "lending";
  position: number;
  is_default: boolean;
  currency: string;
  archived: boolean;
  stages: Stage[];
}

export interface Opportunity {
  id: string;
  type: "crm.opportunity";
  name: string;
  pipeline_id: string;
  stage_id: string;
  stage: { id: string; name: string; is_won: boolean; is_lost: boolean };
  status: "open" | "won" | "lost";
  value: string | null;
  currency: string;
  owner: UserRef | null;
  collaborators: UserRef[];
  visibility: Visibility;
  priority: Priority;
  expected_close_date: string | null;
  closed_at: string | null;
  contacts: { id: string; display_name: string; role: string }[];
  custom_fields: Record<string, unknown>;
  is_demo: boolean;
  updated_at: string;
  permissions: Permissions;
}

export interface BoardColumn {
  stage: Stage;
  count: number;
  total_value: string;
  opportunities: Opportunity[];
}

export interface Board {
  pipeline: Pipeline;
  columns: BoardColumn[];
  can_configure: boolean;
  can_create: boolean;
}

export type TaskStatus = "open" | "in_progress" | "done" | "canceled";

export interface Task {
  id: string;
  type: "crm.task";
  title: string;
  description: string;
  assignee: UserRef | null;
  due_at: string | null;
  is_overdue: boolean;
  priority: Priority;
  status: TaskStatus;
  completed_at: string | null;
  completed_by: UserRef | null;
  contact: { id: string; display_name: string; kind: string } | null;
  opportunity: { id: string; name: string; status: string } | null;
  source: string;
  visibility: Visibility;
  is_demo: boolean;
  created_by: UserRef | null;
  permissions: Permissions;
}

export interface Activity {
  id: string;
  kind: string;
  source: string;
  actor: UserRef | null;
  occurred_at: string;
  summary: string;
  body: string;
  room_id: string;
  event_id: string;
  untrusted: boolean;
  contact: { id: string; display_name: string } | null;
  opportunity: { id: string; name: string } | null;
  task: { id: string; title: string } | null;
  is_demo: boolean;
  permissions: Permissions;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start_at: string;
  end_at: string;
  location: string;
  organizer: UserRef | null;
  matrix_room_id: string;
  status: string;
}

export interface RoomLink {
  id: string;
  room_id: string;
  event_id: string;
  contact: { id: string; display_name: string; kind: string } | null;
  opportunity: { id: string; name: string; status: string } | null;
  created_by: UserRef | null;
  created_at: string;
  permissions: Permissions;
}

export interface ContactSummary {
  contact: Contact;
  open_tasks: Task[];
  open_task_count: number;
  next_event: CalendarEvent | null;
  last_activity: Activity | null;
  open_opportunities: Opportunity[];
}

export interface Dashboard {
  scope: "mine" | "team";
  generated_at: string;
  tasks_today: Task[];
  overdue_task_count: number;
  overdue_follow_ups: Contact[];
  assigned_leads: Contact[];
  recent_activity: Activity[];
  pipeline_summary: {
    pipeline: { id: string; name: string; currency: string };
    stages: { id: string; name: string; is_won: boolean; is_lost: boolean; count: number; total_value: string }[];
    open_value: string;
  } | null;
}
