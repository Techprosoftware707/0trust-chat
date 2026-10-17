/** Shapes of the integrations API (/api/v1/workspaces/<id>/integrations, docs/nexus/INTEGRATIONS.md). */

import type { Priority, UserRef } from "../types";

export type ProviderId = "gmail" | "gohighlevel" | "slack";
export type ConnectionStatus = "connected" | "needs_reauth" | "error" | "disconnected";

export interface Connection {
  id: string;
  provider: ProviderId;
  provider_label: string;
  scope: "personal" | "workspace";
  account: { id: string; label: string };
  owner: UserRef | null;
  is_mine: boolean;
  status: ConnectionStatus;
  status_label: string;
  auth_method: "oauth" | "private_token";
  is_mock: boolean;
  mock_label: string | null;
  granted_scopes: string[];
  missing_scopes: string[];
  connected_at: string;
  last_sync_at: string | null;
  next_sync_at: string | null;
  last_webhook_at: string | null;
  syncing: boolean;
  last_error: { code: string; message: string; at: string | null } | null;
  actions: { reconnect: boolean; retry: boolean; disconnect: boolean };
  permissions: { change: boolean; delete: boolean };
  settings: {
    channels?: { id: string; name: string; is_private: boolean }[];
    private_channels?: boolean;
    my_slack_user_id?: string;
    workflow_triggers_enabled?: boolean;
    workflow_triggers_active?: boolean;
    environment_blocks_workflows?: boolean;
  };
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  description: string;
  scope: "personal" | "workspace";
  configured: boolean;
  oauth_configured: boolean;
  mock: boolean;
  mock_label: string | null;
  mock_refused: boolean;
  methods: ("oauth" | "private_token")[];
  can_connect: boolean;
  scopes: { scope: string; why: string; optional?: boolean }[];
  setup: {
    env: { name: string; secret: boolean; set: boolean; note: string }[];
    steps: string[];
    redirect_uri: string;
    webhook_url: string;
    docs_url: string;
  };
  connections: Connection[];
}

export type ItemOrigin = "synced_email" | "external_message" | "imported_record" | "external_notification";
export type ItemKind = "email_thread" | "slack_message" | "ghl_conversation" | "missed_call";

export interface InboxLinkRef {
  id: string;
  target: { type: string; id: string; label: string };
  created_by: UserRef | null;
  created_at: string;
  on_timeline: boolean;
  permissions: { delete: boolean };
}

export interface ServerInboxItem {
  id: string;
  type: "integrations.inboxitem";
  source: ProviderId;
  source_label: string;
  kind: ItemKind;
  kind_label: string;
  origin: ItemOrigin;
  external: true;
  untrusted: true;
  is_mock: boolean;
  mock_label: string | null;
  visibility: "personal" | "workspace";
  title: string;
  snippet: string;
  participants: { name: string; address: string }[];
  occurred_at: string;
  unread: boolean;
  provider_unread: boolean;
  priority: Priority;
  assignee: UserRef | null;
  labels: string[];
  status: "open" | "done";
  group: { key: string; label: string };
  muted: boolean;
  message_count: number;
  has_attachments: boolean;
  external_url: string;
  open_label: string;
  connection: { id: string; provider: ProviderId; account_label: string; status: ConnectionStatus };
  links: InboxLinkRef[];
  meta: Record<string, unknown>;
  capabilities: { change: boolean; link: boolean; reply: boolean; reply_unsupported_reason: string };
  messages?: EmailMessageMeta[];
  drafts?: Draft[];
}

export interface EmailMessageMeta {
  id: string;
  external_id: string;
  from: { name: string; address: string };
  reply_to: string;
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  subject: string;
  sent_at: string;
  snippet: string;
  outgoing: boolean;
  unread: boolean;
  attachments: { id: string; filename: string; mime_type: string; size: number }[];
}

export interface MessageBody {
  message_id: string;
  text: string;
  html: string;
  has_html: boolean;
  images_blocked: number;
  attachments: EmailMessageMeta["attachments"];
  untrusted: true;
}

export interface Draft {
  id: string;
  item_id: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  status: "draft" | "sent" | "failed" | "discarded";
  status_label: string;
  sent_at: string | null;
  last_error_code: string;
  created_at: string;
  updated_at: string;
}

export interface PendingAction {
  id: string;
  kind: string;
  kind_label: string;
  status: "pending" | "executed" | "failed" | "canceled";
  status_label: string;
  preview: Record<string, unknown>;
  expires_at: string;
  result: Record<string, unknown>;
  error: { code: string; message: string } | null;
  connection: { id: string; provider: ProviderId; is_mock: boolean };
  confirmation_token?: string;
}

export interface Suggestion {
  type: string;
  id: string;
  label: string;
  reason: string;
  email?: string;
}

export interface Mute {
  id: string;
  group_key: string;
  label: string;
}

export interface GhlMessage {
  id: string;
  type: string;
  direction: string;
  status: string;
  body: string;
  date: string;
  call_status: string;
  call_duration: string;
  attachments: number;
}

/** A workspace notification (apps.automation, owned by the verticals team). */
export interface WorkspaceNotification {
  id: string;
  event_type: string;
  title: string;
  body: string;
  link: string;
  related: { type: string; id: string } | null;
  count: number;
  read: boolean;
  created_at: string;
  updated_at: string;
}
