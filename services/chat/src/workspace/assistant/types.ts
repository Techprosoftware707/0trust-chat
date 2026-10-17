/** Shapes of the AI assistant and MCP connector APIs (apps/assistant, apps/mcp). */

import type { UserRef } from "../types";

export interface Source {
  type: string;
  id: string;
  label: string;
  url: string;
}

export interface FactGroup {
  tool: string;
  title: string;
  lines: string[];
  sources: Source[];
}

export interface PreviewField {
  label: string;
  value: string;
}

export interface PreviewChange {
  label: string;
  before: string;
  after: string;
}

export interface ActionPreview {
  kind: string;
  title: string;
  fields?: PreviewField[];
  changes?: PreviewChange[];
  note?: string;
}

export type ActionStatus = "pending" | "confirmed" | "canceled" | "failed";

export interface PendingAction {
  pending_action_id: string;
  action: string;
  status: ActionStatus;
  preview: ActionPreview;
  expires_at: string;
  result?: { records?: { type: string; id: string; url?: string }[]; message?: string };
}

export interface ProviderInfo {
  name: string;
  label: string;
  model: string;
  is_model: boolean;
}

export interface ChatAnswer {
  interaction_id: string;
  provider: ProviderInfo;
  mode_label: string;
  answer: string;
  answer_kind: "ai" | "development";
  facts: FactGroup[];
  sources: Source[];
  actions: PendingAction[];
  tool_calls: { name: string; ok: boolean; error_code: string }[];
  untrusted_used: boolean;
  stop: string;
}

export interface ChatContext {
  contact_id?: string;
  opportunity_id?: string;
  room_id?: string;
}

export interface AiSettings {
  assistant_enabled: boolean;
  mcp_enabled: boolean;
  sensitive_data_enabled: boolean;
  content_retention_days: number;
  updated_at?: string;
}

export interface AssistantStatus {
  provider: ProviderInfo & { configured: boolean; problem: string };
  settings: AiSettings;
  features: { assistant: boolean; mcp: boolean; save_to_record: boolean };
  sensitive_in_context: boolean;
  tools: { name: string; title: string; kind: string }[];
  mcp: { installation_enabled: boolean; url: string };
  notes: string[];
}

export interface McpStatus {
  installation_enabled: boolean;
  workspace_enabled: boolean;
  url: string;
  registration: { dcr: boolean; cimd: boolean };
  scopes: Record<string, string>;
  can_manage: boolean;
}

export interface McpConnection {
  id: string;
  client: { name: string; kind: "dcr" | "cimd" | "registered"; host: string; redirect_hosts: string[]; loopback_only: boolean };
  user: UserRef | null;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  last_token_at: string | null;
  active: boolean;
}

/** One exchange in the assistant conversation (kept in this tab only). */
export interface Turn {
  id: string;
  question: string;
  context: ChatContext;
  answer: ChatAnswer | null;
  error: string | null;
  pending: boolean;
}

export interface ChatMessageCandidate {
  eventId: string;
  sender: string;
  senderId: string;
  ts: number;
  text: string;
}
