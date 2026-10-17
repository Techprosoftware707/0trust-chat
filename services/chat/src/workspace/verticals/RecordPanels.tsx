/**
 * Vertical sections of existing record pages:
 * - the deal page (areas/crm.tsx): people with their roles, properties, milestones and
 *   deadlines (approaching ones highlighted), linked lending applications;
 * - the contact ("buyer") page (areas/contacts.tsx): structured preferences, matching
 *   properties, viewings, related properties and (for lending staff) applications.
 */

import { useId, useState, type FormEvent } from "react";
import { Building2, CalendarDays, Home, Landmark, Pencil, Plus, Target, Users } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Spinner } from "../../components/primitives/Spinner";
import { describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash } from "../define";
import { ErrorState, LoadingState, formatWhen } from "../ui";
import { PROPERTY_TYPE_LABEL, budgetRange, money, parseList, propertyFacts } from "./logic";
import { DeleteButton, Field, MilestonesSection, SearchPicker, fieldErrors } from "./shared";
import type { ContactVertical, DealVertical, LendingApplication, Preferences, Property } from "./types";

const DEAL_ROLES: [string, string][] = [["primary", "Primary contact"], ["buyer", "Buyer"], ["seller", "Seller"], ["borrower", "Borrower"], ["co_borrower", "Co-borrower"], ["other", "Other"]];
const PROPERTY_ROLES: [string, string][] = [["purchase", "Purchase"], ["listing", "Listing (we represent the seller)"], ["considering", "Considering"], ["other", "Other"]];

function ApplicationsList({ apps }: { apps: LendingApplication[] }) {
  return (
    <ul className="ws-list compact">
      {apps.map((a) => (
        <li key={a.id}>
          <a className="ws-row-link" href={areaHash("lending", a.id)}>
            <span className="ws-row-main">
              <span className="ws-row-title">
                {a.reference} · {a.title}
              </span>
              <span className="ws-row-meta">
                {a.stage.name} · {money(a.amount_requested, a.currency)}
                {a.checklist.outstanding ? <span className="vx-missing"> · {a.checklist.outstanding} documents missing</span> : " · documents complete"}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The verticals part of the deal page. */
export function DealVerticalPanels({ opportunityId }: { opportunityId: string }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const res = useApiResource((api, signal) => api.get<DealVertical>(`${ws.crm}/opportunities/${opportunityId}/vertical`, undefined, signal), [ws.crm, opportunityId]);
  const [role, setRole] = useState("buyer");
  const [propRole, setPropRole] = useState("purchase");
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} compact />;
  const d = res.data;
  if (!d) return <LoadingState />;
  const realEstate = ws.hasFeature("real_estate");
  const addContactRole = async (contactId: string) => {
    try {
      await ws.api.post(`${ws.crm}/opportunities/${opportunityId}/contact-roles`, { contact_id: contactId, role });
      res.reload();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't add the person", body: describeError(e) });
    }
  };
  const linkProperty = async (propertyId: string) => {
    try {
      await ws.api.post(`${ws.crm}/opportunities/${opportunityId}/properties`, { property_id: propertyId, role: propRole });
      ui.toast({ kind: "success", title: "Property linked" });
      res.reload();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't link the property", body: describeError(e) });
    }
  };
  return (
    <>
      <MilestonesSection milestones={d.milestones} parent={{ opportunity_id: opportunityId }} canChange={d.can_change}
        templates={realEstate ? d.deadline_templates.filter((t) => t !== "lending") : []} onChanged={res.reload} currency={d.opportunity.currency} dueSoonDays={d.due_soon_days} />
      <section className="ws-section" aria-labelledby={`${uid}-p`}>
        <header className="ws-section-header">
          <h3 id={`${uid}-p`}>
            <Users aria-hidden="true" /> People on this deal
          </h3>
        </header>
        {d.contacts.length === 0 ? <p className="muted small">Nobody yet.</p> : null}
        <ul className="ws-list compact">
          {d.contacts.map((c) => (
            <li key={c.id} className="cluster-between">
              <a href={areaHash("contacts", c.id)}>{c.display_name}</a>
              {d.can_change ? (
                <>
                  <label className="visually-hidden" htmlFor={`${uid}-r-${c.id}`}>
                    Role of {c.display_name}
                  </label>
                  <select id={`${uid}-r-${c.id}`} className="vx-compact" value={c.role}
                    onChange={async (e) => {
                      try {
                        await ws.api.post(`${ws.crm}/opportunities/${opportunityId}/contact-roles`, { contact_id: c.id, role: e.target.value });
                        res.reload();
                      } catch (err) {
                        ui.toast({ kind: "error", title: "Couldn't change the role", body: describeError(err) });
                      }
                    }}>
                    {DEAL_ROLES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <span className="badge">{c.role_label}</span>
              )}
            </li>
          ))}
        </ul>
        {d.can_change ? (
          <div className="vx-template">
            <label className="visually-hidden" htmlFor={`${uid}-nr`}>
              Role
            </label>
            <select id={`${uid}-nr`} value={role} onChange={(e) => setRole(e.target.value)}>
              {DEAL_ROLES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <SearchPicker id={`${uid}-ap`} label="Add a person" placeholder="Add a person: search contacts" hideLabel
              search={async (q, signal) => (await ws.api.list<{ id: string; display_name: string }>(`${ws.crm}/contacts`, { q, limit: 6 }, signal)).data}
              render={(c) => c.display_name} onPick={(c) => void addContactRole(c.id)} />
          </div>
        ) : null}
      </section>
      {realEstate ? (
        <section className="ws-section" aria-labelledby={`${uid}-h`}>
          <header className="ws-section-header">
            <h3 id={`${uid}-h`}>
              <Building2 aria-hidden="true" /> Properties
            </h3>
          </header>
          {d.properties.length === 0 ? <p className="muted small">No property linked yet.</p> : null}
          <ul className="ws-list compact">
            {d.properties.map((l) => (
              <li key={l.id} className="cluster-between">
                <a className="ws-row-link" href={areaHash("properties", l.property.id)}>
                  <span className="ws-row-main">
                    <span className="ws-row-title">{l.property.display_name}</span>
                    <span className="ws-row-meta">
                      {l.role_label} · {money(l.property.list_price, l.property.currency)}
                    </span>
                  </span>
                </a>
                {l.permissions.delete ? (
                  <DeleteButton label={`Unlink ${l.property.display_name}`} onConfirm={async () => {
                    await ws.api.delete(`${ws.crm}/opportunity-properties/${l.id}`);
                    res.reload();
                  }} />
                ) : null}
              </li>
            ))}
          </ul>
          {d.can_change ? (
            <div className="vx-template">
              <label className="visually-hidden" htmlFor={`${uid}-pr`}>
                Property role
              </label>
              <select id={`${uid}-pr`} value={propRole} onChange={(e) => setPropRole(e.target.value)}>
                {PROPERTY_ROLES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <SearchPicker id={`${uid}-lp`} label="Link a property" placeholder="Link a property: search" hideLabel
                search={async (q, signal) => (await ws.api.list<Property>(`${ws.crm}/properties`, { q, limit: 6 }, signal)).data}
                render={(p) => `${p.display_name} · ${money(p.list_price, p.currency)}`} onPick={(p) => void linkProperty(p.id)} />
            </div>
          ) : null}
        </section>
      ) : null}
      {d.applications.length ? (
        <section className="ws-section" aria-label="Lending applications">
          <h3 className="ws-section-title">
            <Landmark aria-hidden="true" /> Lending applications
          </h3>
          <ApplicationsList apps={d.applications} />
        </section>
      ) : null}
    </>
  );
}

// --- the buyer page ---------------------------------------------------------------------------------------

function PreferencesView({ p }: { p: Preferences }) {
  return (
    <dl className="ws-kv">
      <dt>Looking to</dt>
      <dd>{p.listing_type === "rent" ? "Rent" : "Buy"}</dd>
      <dt>Budget</dt>
      <dd>{budgetRange(p.budget_min, p.budget_max, p.currency)}</dd>
      <dt>Areas</dt>
      <dd>{p.areas.length ? p.areas.join(", ") : "Anywhere"}</dd>
      <dt>Home types</dt>
      <dd>{p.property_types.length ? p.property_types.map((t) => PROPERTY_TYPE_LABEL[t] ?? t).join(", ") : "Any"}</dd>
      <dt>Size</dt>
      <dd>
        {[p.bedrooms_min !== null ? `${p.bedrooms_min}+ bedrooms` : "", p.bathrooms_min !== null ? `${Number(p.bathrooms_min)}+ bathrooms` : "", p.area_min ? `${p.area_min}+ sq ft` : ""]
          .filter(Boolean).join(" · ") || "—"}
      </dd>
      <dt>Must-haves</dt>
      <dd>{p.must_haves.length ? p.must_haves.join(", ") : "—"}</dd>
      {p.nice_to_haves.length ? (
        <>
          <dt>Nice to have</dt>
          <dd>{p.nice_to_haves.join(", ")}</dd>
        </>
      ) : null}
      <dt>Timeline</dt>
      <dd>{p.timeline_label || "—"}{p.move_by ? ` · move by ${formatWhen(p.move_by, { time: false })}` : ""}</dd>
      {p.notes ? (
        <>
          <dt>Notes</dt>
          <dd>{p.notes}</dd>
        </>
      ) : null}
    </dl>
  );
}

function PreferencesForm({ contactId, current, onSaved, onCancel }: { contactId: string; current: Preferences | null; onSaved: () => void; onCancel: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const [f, setF] = useState({
    listing_type: current?.listing_type ?? "sale", budget_min: current?.budget_min ?? "", budget_max: current?.budget_max ?? "", areas: (current?.areas ?? []).join(", "),
    property_types: current?.property_types ?? [], bedrooms_min: current?.bedrooms_min?.toString() ?? "", bathrooms_min: current?.bathrooms_min ?? "",
    must_haves: (current?.must_haves ?? []).join(", "), nice_to_haves: (current?.nice_to_haves ?? []).join(", "), timeline: current?.timeline ?? "", notes: current?.notes ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await ws.api.patch(`${ws.crm}/contacts/${contactId}/preferences`, {
          listing_type: f.listing_type, budget_min: f.budget_min || null, budget_max: f.budget_max || null, areas: parseList(f.areas), property_types: f.property_types,
          bedrooms_min: f.bedrooms_min === "" ? null : Number(f.bedrooms_min), bathrooms_min: f.bathrooms_min || null, must_haves: parseList(f.must_haves),
          nice_to_haves: parseList(f.nice_to_haves), timeline: f.timeline, notes: f.notes,
      });
      ui.toast({ kind: "success", title: "Preferences saved" });
      onSaved();
    } catch (e2) {
      setErrors(fieldErrors(e2));
      if (!Object.keys(fieldErrors(e2)).length) ui.toast({ kind: "error", title: "Couldn't save the preferences", body: describeError(e2) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="vx-event-form" onSubmit={submit} noValidate aria-label="Buyer preferences">
      <div className="vx-grid-2">
        <Field id={`${uid}-lt`} label="Looking to">
          <select id={`${uid}-lt`} value={f.listing_type} onChange={set("listing_type")}>
            <option value="sale">Buy</option>
            <option value="rent">Rent</option>
          </select>
        </Field>
        <Field id={`${uid}-tl`} label="Timeline">
          <select id={`${uid}-tl`} value={f.timeline} onChange={set("timeline")}>
            <option value="">Not sure</option>
            <option value="asap">As soon as possible</option>
            <option value="within_3_months">Within 3 months</option>
            <option value="within_6_months">Within 6 months</option>
            <option value="within_12_months">Within a year</option>
            <option value="flexible">Flexible</option>
          </select>
        </Field>
        <Field id={`${uid}-bmin`} label="Budget from (USD)" error={errors.budget_min}>
          <input id={`${uid}-bmin`} type="text" inputMode="decimal" value={f.budget_min} onChange={set("budget_min")} />
        </Field>
        <Field id={`${uid}-bmax`} label="Budget up to (USD)" error={errors.budget_max}>
          <input id={`${uid}-bmax`} type="text" inputMode="decimal" value={f.budget_max} onChange={set("budget_max")} />
        </Field>
        <Field id={`${uid}-bd`} label="Bedrooms (at least)" error={errors.bedrooms_min}>
          <input id={`${uid}-bd`} type="number" min={0} max={50} value={f.bedrooms_min} onChange={set("bedrooms_min")} />
        </Field>
        <Field id={`${uid}-ba`} label="Bathrooms (at least)" error={errors.bathrooms_min}>
          <input id={`${uid}-ba`} type="text" inputMode="decimal" value={f.bathrooms_min} onChange={set("bathrooms_min")} />
        </Field>
      </div>
      <Field id={`${uid}-ar`} label="Areas" hint="Neighbourhoods, towns or postcodes, separated by commas." error={errors.areas}>
        <input id={`${uid}-ar`} type="text" value={f.areas} onChange={set("areas")} />
      </Field>
      <fieldset className="ws-chip-set">
        <legend className="ws-legend">Home types</legend>
        {Object.entries(PROPERTY_TYPE_LABEL).map(([v, l]) => (
          <label key={v} className="ws-chip-check">
            <input type="checkbox" checked={f.property_types.includes(v)}
              onChange={(e) => setF((x) => ({ ...x, property_types: e.target.checked ? [...x.property_types, v] : x.property_types.filter((y) => y !== v) }))} />
            {l}
          </label>
        ))}
      </fieldset>
      <Field id={`${uid}-mh`} label="Must-haves" hint="Separated by commas." error={errors.must_haves}>
        <input id={`${uid}-mh`} type="text" value={f.must_haves} onChange={set("must_haves")} />
      </Field>
      <Field id={`${uid}-nh`} label="Nice to have">
        <input id={`${uid}-nh`} type="text" value={f.nice_to_haves} onChange={set("nice_to_haves")} />
      </Field>
      <Field id={`${uid}-no`} label="Notes">
        <textarea id={`${uid}-no`} rows={2} value={f.notes} maxLength={2000} onChange={set("notes")} />
      </Field>
      <div className="cluster">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
          {busy ? <Spinner size="sm" /> : null} Save preferences
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The real-estate and lending part of a contact's page. */
export function ContactVerticalPanels({ contactId }: { contactId: string }) {
  const ws = useWorkspace();
  const uid = useId();
  const res = useApiResource((api, signal) => api.get<ContactVertical>(`${ws.crm}/contacts/${contactId}/vertical`, undefined, signal), [ws.crm, contactId]);
  const matches = useApiResource((api, signal) => (ws.hasFeature("real_estate") ? api.get<{ matches: Property[] }>(`${ws.crm}/contacts/${contactId}/preferences`, undefined, signal) : Promise.resolve(null)), [ws.crm, contactId]);
  const [editing, setEditing] = useState(false);
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} compact />;
  const d = res.data;
  if (!d) return null;
  const re = d.real_estate;
  return (
    <>
      {re ? (
        <section className="ws-section" aria-labelledby={`${uid}-pref`}>
          <header className="ws-section-header">
            <h3 id={`${uid}-pref`}>
              <Target aria-hidden="true" /> What they're looking for
            </h3>
            {re.can_edit && !editing ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
                {re.preferences ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />} {re.preferences ? "Edit" : "Add preferences"}
              </button>
            ) : null}
          </header>
          {editing ? (
            <PreferencesForm contactId={contactId} current={re.preferences} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); res.reload(); matches.reload(); }} />
          ) : re.preferences ? (
            <PreferencesView p={re.preferences} />
          ) : (
            <p className="muted small">No preferences yet{re.can_edit ? ": add budget, areas, size and must-haves." : "."}</p>
          )}
          {!editing && matches.data?.matches.length ? (
            <>
              <h4 className="ws-subhead">
                <Home aria-hidden="true" className="inline-icon" /> Your listings that fit
              </h4>
              <ul className="ws-list compact">
                {matches.data.matches.map((p) => (
                  <li key={p.id}>
                    <a className="ws-row-link" href={areaHash("properties", p.id)}>
                      <span className="ws-row-main">
                        <span className="ws-row-title">{p.display_name}</span>
                        <span className="ws-row-meta">
                          {money(p.list_price, p.currency)} · {propertyFacts(p)}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
              <p className="xsmall subtle">Only properties your team entered; Nexus doesn't search listing services.</p>
            </>
          ) : null}
        </section>
      ) : null}
      {re ? (
        <section className="ws-section" aria-labelledby={`${uid}-vw`}>
          <header className="ws-section-header">
            <h3 id={`${uid}-vw`}>
              <CalendarDays aria-hidden="true" /> Viewings
            </h3>
          </header>
          {re.viewings.length === 0 ? <p className="muted small">No viewings yet. Schedule one from a property's page.</p> : null}
          <ul className="ws-list compact">
            {re.viewings.map((e) => (
              <li key={e.id}>
                <a className="ws-row-link" href={areaHash("calendar", "event", e.id)}>
                  <span className="ws-row-main">
                    <span className="ws-row-title">{e.title}</span>
                    <span className="ws-row-meta">
                      {formatWhen(e.start_at)}
                      {e.status !== "scheduled" ? ` · ${e.status}` : new Date(e.start_at) < new Date() ? " · past" : ""}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {re.properties.length ? (
            <>
              <h4 className="ws-subhead">Properties</h4>
              <ul className="ws-list compact">
                {re.properties.map((l) =>
                  l.property ? (
                    <li key={l.id} className="cluster-between">
                      <a href={areaHash("properties", l.property.id)}>{l.property.display_name}</a>
                      <span className="badge">{l.role_label}</span>
                    </li>
                  ) : null,
                )}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
      {d.lending && d.lending.applications.length ? (
        <section className="ws-section" aria-label="Lending applications">
          <h3 className="ws-section-title">
            <Landmark aria-hidden="true" /> Lending applications
          </h3>
          <ApplicationsList apps={d.lending.applications} />
        </section>
      ) : null}
    </>
  );
}
