import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findArea, isAreaVisible } from "../../src/workspace/registry";
import type { WorkspaceDetail } from "../../src/workspace/types";
import {
  addDays, budgetRange, callDuration, checkUpload, dayBlock, describeRule, eventsOnDay, executionBadgeClass, groupByDay, isoDay, mergeRecentCalls, parseIsoDay,
  parseList, propertyFacts, shiftAnchor, startOfWeek, urgencyBadgeClass, viewRange,
} from "../../src/workspace/verticals/logic";
import { HomeVerticalCards, serviceStatusLabel } from "../../src/workspace/verticals/HomeCards";
import { NoRecordingNote, UrgencyBadge } from "../../src/workspace/verticals/shared";
import { ChecklistProgressBar, MissingBadge, StaffDecisionNote } from "../../src/workspace/areas/lending";
import { parseCalendarPath } from "../../src/workspace/areas/calendar";
import { downloadDocument, uploadDocument } from "../../src/workspace/verticals/files";
import { ApiError, WorkspaceApi } from "../../src/workspace/api";
import type { ChecklistProgress, HomeExtras } from "../../src/workspace/verticals/types";

function ws(features: Record<string, boolean>, capabilities: Record<string, boolean>): WorkspaceDetail {
  return {
    id: "w", name: "W", slug: "w", role: "owner", role_label: "Owner", plan: { code: "business", name: "Business" }, features, view_level: "all", capabilities,
    settings: { business_profiles: [], default_currency: "USD", save_to_record_enabled: false, is_demo: false },
  };
}

describe("verticals areas in the registry", () => {
  it("are ready and gated by their feature and capability", () => {
    for (const id of ["calendar", "calls", "reports", "properties", "lending", "notifications", "automations"]) {
      expect(findArea(id)?.status, id).toBe("ready");
    }
    const lending = findArea("lending")!;
    expect(isAreaVisible(lending, ws({ crm: true, lending: true }, { "lending.access": true }))).toBe(true);
    expect(isAreaVisible(lending, ws({ crm: true, lending: true }, { "lending.access": false }))).toBe(false); // team members, read-only
    expect(isAreaVisible(lending, ws({ crm: true, lending: false }, { "lending.access": true }))).toBe(false);
    const props = findArea("properties")!;
    expect(isAreaVisible(props, ws({ crm: true, real_estate: true }, {}))).toBe(true);
    expect(isAreaVisible(props, ws({ crm: true }, {}))).toBe(false);
    const auto = findArea("automations")!;
    expect(isAreaVisible(auto, ws({ automation: true }, { "automation.manage": false }))).toBe(false);
    expect(isAreaVisible(auto, ws({ automation: true }, { "automation.manage": true }))).toBe(true);
  });
});

describe("calendar maths", () => {
  it("computes views, weeks starting on Monday, and navigation", () => {
    const thu = new Date(2030, 0, 10, 15, 30); // Thursday
    expect(startOfWeek(thu)).toEqual(new Date(2030, 0, 7));
    expect(viewRange("week", thu)).toEqual({ from: new Date(2030, 0, 7), to: new Date(2030, 0, 14) });
    expect(viewRange("day", thu)).toEqual({ from: new Date(2030, 0, 10), to: new Date(2030, 0, 11) });
    expect(viewRange("agenda", thu).to).toEqual(new Date(2030, 0, 24));
    expect(shiftAnchor("week", thu, -1)).toEqual(addDays(thu, -7));
    expect(isoDay(thu)).toBe("2030-01-10");
    expect(parseIsoDay("2030-01-10")).toEqual(new Date(2030, 0, 10));
    expect(parseIsoDay("nope")).toBeNull();
  });
  it("places events on the days they touch, and in the day grid", () => {
    const at = (d: number, h: number, m = 0) => new Date(2030, 0, d, h, m).toISOString();
    const events = [
      { id: "a", start_at: at(10, 9), end_at: at(10, 10) },
      { id: "b", start_at: at(10, 23), end_at: at(11, 1) }, // over midnight
      { id: "c", start_at: at(12, 8), end_at: at(12, 8, 30) },
    ];
    expect(eventsOnDay(events, new Date(2030, 0, 10)).map((e) => e.id)).toEqual(["a", "b"]);
    expect(eventsOnDay(events, new Date(2030, 0, 11)).map((e) => e.id)).toEqual(["b"]);
    expect(groupByDay(events, new Date(2030, 0, 10), new Date(2030, 0, 13)).map((g) => g.events.length)).toEqual([2, 1, 1]);
    expect(dayBlock(events[0], new Date(2030, 0, 10))).toEqual({ top: 540, height: 60 });
    expect(dayBlock(events[1], new Date(2030, 0, 11))).toEqual({ top: 0, height: 60 }); // clamped to the day
    expect(dayBlock({ start_at: at(12, 8), end_at: at(12, 8, 5) }, new Date(2030, 0, 12)).height).toBe(20); // minimum size
  });
  it("parses calendar routes", () => {
    expect(parseCalendarPath(["event", "abc"])).toEqual({ kind: "event", id: "abc" });
    expect(parseCalendarPath(["week", "2030-01-10"])).toEqual({ kind: "view", view: "week", anchor: new Date(2030, 0, 10) });
    const now = new Date(2030, 4, 2, 13);
    expect(parseCalendarPath([], now)).toEqual({ kind: "view", view: "agenda", anchor: new Date(2030, 4, 2) });
  });
});

describe("labels and checks", () => {
  it("describes properties, budgets and lists", () => {
    expect(propertyFacts({ bedrooms: 3, bathrooms: "2.5", area: 1650, area_unit: "sqft", property_type: "house" })).toBe("3 bd · 2.5 ba · 1,650 sq ft");
    expect(propertyFacts({ bedrooms: null, bathrooms: null, area: null, area_unit: "sqft", property_type: "land" })).toBe("Land");
    expect(budgetRange("300000", "400000", "USD")).toMatch(/300,000.*400,000/);
    expect(budgetRange(null, "400000", "USD")).toMatch(/^up to/);
    expect(budgetRange(null, null, "USD")).toBe("—");
    expect(parseList("Garden, garage,\nGarden ,")).toEqual(["Garden", "garage"]);
  });
  it("highlights urgency and execution states with contrast-checked badges", () => {
    expect(urgencyBadgeClass("overdue")).toBe("badge-danger");
    expect(urgencyBadgeClass("due_soon")).toBe("badge-warning");
    expect(urgencyBadgeClass("upcoming")).toBe("");
    expect(executionBadgeClass("failed")).toBe("badge-danger");
    expect(executionBadgeClass("loop_blocked")).toBe("badge-warning");
    expect(renderToStaticMarkup(<UrgencyBadge urgency="due_soon" />)).toContain("Due soon");
    expect(renderToStaticMarkup(<UrgencyBadge urgency="upcoming" quiet />)).toBe("");
  });
  it("pre-checks uploads (the server checks the contents again)", () => {
    const allowed = ["application/pdf", "image/png"];
    expect(checkUpload({ name: "a.pdf", size: 10, type: "application/pdf" }, allowed, 100)).toBeNull();
    expect(checkUpload({ name: "a.pdf", size: 0, type: "application/pdf" }, allowed, 100)).toMatch(/empty/);
    expect(checkUpload({ name: "a.pdf", size: 200, type: "application/pdf" }, allowed, 100)).toMatch(/at most/);
    expect(checkUpload({ name: "a.exe", size: 10, type: "application/x-msdownload" }, allowed, 100)).toMatch(/PDF/);
  });
  it("describes rules in plain words", () => {
    const text = describeRule({
      trigger: "lead.created", trigger_label: "A lead is created", conditions: [{ field: "contact.source", op: "equals", value: "Website" }],
      actions: [{ type: "assign_owner", params: { only_if_unassigned: true } }, { type: "create_task", params: { title: "Call {contact.name}", due_in_hours: 24 } }],
    });
    expect(text).toBe("When a lead is created and contact.source equals Website: assign an owner if it has none, then create the task “Call {contact.name}” due in 24 h.");
  });
});

describe("recent calls", () => {
  it("merges per-room histories newest first and formats durations", () => {
    const calls = mergeRecentCalls([
      { roomId: "!a", roomName: "A", calls: [{ startEventId: "$1", startTs: 1000, endTs: 61_000, intent: "video", participants: ["@x", "@y"], ongoing: false, outcome: "answered" }] },
      { roomId: "!b", roomName: "B", calls: [{ startEventId: "$2", startTs: 5000, endTs: null, intent: null, participants: ["@x"], ongoing: true, outcome: "ongoing" }] },
    ]);
    expect(calls.map((c) => c.eventId)).toEqual(["$2", "$1"]);
    expect(calls[1]).toMatchObject({ roomId: "!a", participants: 2 });
    expect(callDuration(calls[1])).toBe("1 min");
    expect(callDuration(calls[0])).toBe("");
  });
});

describe("honest UI copy", () => {
  it("says decisions are made by people, recording isn't available, and what's missing", () => {
    expect(renderToStaticMarkup(<StaffDecisionNote />)).toMatch(/Authorised staff make every lending decision.*never approves or rejects/);
    expect(renderToStaticMarkup(<NoRecordingNote />)).toMatch(/Recording and transcription aren(&#x27;|')t available/);
    const progress: ChecklistProgress = { total: 5, required: 4, complete: 1, outstanding: 3, awaiting_review: 1, overdue: 1, percent: 25,
      by_status: { pending: 1, requested: 2, received: 1, accepted: 1, rejected: 0, waived: 0 } };
    expect(renderToStaticMarkup(<MissingBadge app={{ checklist: progress }} />)).toContain("3 missing, 1 overdue");
    expect(renderToStaticMarkup(<MissingBadge app={{ checklist: { ...progress, outstanding: 0, overdue: 0 } }} />)).toContain("Documents complete");
    expect(renderToStaticMarkup(<ChecklistProgressBar app={{ checklist: progress }} />)).toContain("1/4 documents · 1 to review");
  });
});

describe("Home cards", () => {
  const base: HomeExtras = { meetings_today: [], approaching_deadlines: [], applications_missing_documents: null, suggested_next_steps: 0, connected_services: null };
  it("shows no connected-services card until an integration provides health, and labels mock providers", () => {
    expect(renderToStaticMarkup(<HomeVerticalCards d={base} team={false} />)).not.toContain("Connected services");
    const html = renderToStaticMarkup(
      <HomeVerticalCards d={{ ...base, connected_services: [
        { service: "gmail", label: "Gmail", status: "connected", status_label: "Connected", detail: "you@example.com", link: "#/integrations", mock: true, mock_label: "Mock provider (development)" },
        { service: "slack", label: "Slack", status: "not_configured", link: "#/integrations", mock: false, mock_label: null },
      ] }} team={false} />,
    );
    expect(html).toContain("Connected services");
    expect(html).toContain("Mock provider (development)");
    expect(html.match(/Mock provider/g)).toHaveLength(1);
    expect(html).toContain("Not set up on this server");
    expect(serviceStatusLabel({ service: "x", label: "X", status: "needs_reauth" })).toBe("Needs sign-in again");
  });
  it("shows the lending card only for people with lending access", () => {
    expect(renderToStaticMarkup(<HomeVerticalCards d={base} team={false} />)).not.toContain("Applications missing documents");
    const html = renderToStaticMarkup(<HomeVerticalCards d={{ ...base, applications_missing_documents: [
      { id: "1", reference: "APP-0001", title: "T", missing: 2, stage: "Documents Pending", target_close_date: null }] }} team={false} />);
    expect(html).toContain("APP-0001");
    expect(html).toContain("2 missing");
  });
});

describe("secure document transfer", () => {
  afterEach(() => vi.unstubAllGlobals());
  const auth = { accessToken: vi.fn(async () => "tok"), invalidateAccessToken: vi.fn() } as unknown as ConstructorParameters<typeof WorkspaceApi>[1];

  it("uploads the raw file with its type and an encoded name, with the bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: "d1" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new WorkspaceApi("https://example.com/api/v1", auth);
    const file = new File([new Uint8Array([37, 80, 68, 70])], "pay stub (May).pdf", { type: "application/pdf" });
    const out = await uploadDocument<{ id: string }>({ api, auth }, "/workspaces/w/crm", "app1", file, "item1");
    expect(out.id).toBe("d1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.com/api/v1/workspaces/w/crm/lending/applications/app1/documents?checklist_item=item1");
    const h = init.headers as Record<string, string>;
    expect(h["Content-Type"]).toBe("application/pdf");
    expect(h["X-Nexus-Filename"]).toBe("pay%20stub%20(May).pdf");
    expect(h.Authorization).toBe("Bearer tok");
    expect(init.credentials).toBe("omit");
  });

  it("turns API errors into ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "validation_error", message: "Some fields are not valid.", fields: { file: ["The file's contents don't match its type."] } } }), { status: 400 })));
    const api = new WorkspaceApi("https://example.com/api/v1", auth);
    const err = await uploadDocument({ api, auth }, "/workspaces/w/crm", "app1", new File(["x"], "a.pdf", { type: "application/pdf" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).field("file")).toMatch(/don't match/);
  });

  it("downloads through a single-use token sent in the body, never in the URL", async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      bodies.push(String(init?.body ?? ""));
      if (url.endsWith("/download-token")) return new Response(JSON.stringify({ data: { token: "signed.token.value", expires_at: "x" } }), { status: 201 });
      return new Response("%PDF", { status: 200, headers: { "Content-Type": "application/pdf" } });
    }));
    const created: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => { created.push("blob"); return "blob:x"; }, revokeObjectURL: () => undefined }));
    const api = new WorkspaceApi("https://example.com/api/v1", auth);
    await downloadDocument({ api, auth }, "/workspaces/w/crm", { id: "d1", name: "w2.pdf" });
    expect(urls[1]).toBe("https://example.com/api/v1/workspaces/w/crm/lending/documents/download");
    expect(urls.every((u) => !u.includes("signed.token.value"))).toBe(true);
    expect(JSON.parse(bodies[1])).toEqual({ token: "signed.token.value" });
    expect(created).toHaveLength(1);
  });
});

describe("calendar lanes", () => {
  it("puts overlapping events side by side and leaves the rest full width", async () => {
    const { layoutLanes } = await import("../../src/workspace/verticals/logic");
    const at = (h: number, m = 0) => new Date(2030, 0, 10, h, m).toISOString();
    const day = new Date(2030, 0, 10);
    const lanes = layoutLanes([
      { id: "a", start_at: at(10), end_at: at(10, 45) },
      { id: "b", start_at: at(10), end_at: at(11) },
      { id: "c", start_at: at(10, 50), end_at: at(11, 30) }, // overlaps b only: reuses a's lane
      { id: "d", start_at: at(14), end_at: at(15) },
    ], day);
    expect(lanes.get("b")).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get("a")).toEqual({ lane: 1, lanes: 2 });
    expect(lanes.get("c")).toEqual({ lane: 1, lanes: 2 });
    expect(lanes.get("d")).toEqual({ lane: 0, lanes: 1 });
  });
});
