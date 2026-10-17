/** Properties (real estate): list with search and filters | detail with people, deals and
 * viewings | create and edit. Listings are entered by the team (or labelled imports): Nexus
 * has no MLS access and never invents listings. */

import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, Building2, CalendarPlus, Info, Pencil, Plus, Search, Trash2, UserPlus } from "lucide-react";
import { useUi } from "../../components/UiContext";
import { Dialog } from "../../components/primitives/Dialog";
import { Spinner } from "../../components/primitives/Spinner";
import { navigate } from "../../hooks/useRoute";
import { describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import { ConnectionGate, DemoBadge, EmptyState, ErrorState, LoadingState, UserLabel, formatWhen, fromLocalInput, toLocalInput } from "../ui";
import { listKeys } from "./contacts";
import { PROPERTY_STATUS_LABEL, PROPERTY_TYPE_LABEL, money, propertyFacts, propertyStatusClass } from "../verticals/logic";
import { DeleteButton, Field, MemberChips, SearchPicker, fieldErrors, useContactSearch } from "../verticals/shared";
import type { CalendarEventFull, Property, PropertyDetail } from "../verticals/types";

const STATUSES = Object.keys(PROPERTY_STATUS_LABEL);
const CONTACT_ROLES: [string, string][] = [["seller", "Seller"], ["buyer", "Buyer"], ["interested", "Interested buyer"], ["landlord", "Landlord"], ["tenant", "Tenant"], ["other", "Other"]];

export function PropertyStatusBadge({ status }: { status: string }) {
  return <span className={`badge ${propertyStatusClass(status)}`}>{PROPERTY_STATUS_LABEL[status] ?? status}</span>;
}

function SourceNote({ p }: { p: Property }) {
  return (
    <p className="xsmall subtle">
      <Info aria-hidden="true" className="inline-icon" /> {p.source === "manual" ? "Entered by your team." : `${p.source_label}${p.source_detail ? `: ${p.source_detail}` : ""}.`} Nexus has
      no MLS or listing-service access.
    </p>
  );
}

function ViewingDialog({ property, onClose, onSaved }: { property: Property; onClose: () => void; onSaved: (e: CalendarEventFull) => void }) {
  const { api, crm, me, members } = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const mine = members.find((m) => m.id === me?.user.id)?.id;
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  const [when, setWhen] = useState(toLocalInput(start.toISOString()));
  const [minutes, setMinutes] = useState(45);
  const [contacts, setContacts] = useState<{ id: string; display_name: string }[]>([]);
  const [attendees, setAttendees] = useState<string[]>(mine ? [mine] : []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const search = useContactSearch();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const s = fromLocalInput(when);
    if (!s) {
      setErrors({ start_at: "Pick a date and time." });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const ev = await api.post<CalendarEventFull>(`${crm}/properties/${property.id}/viewings`, {
        start_at: s, end_at: new Date(new Date(s).getTime() + minutes * 60_000).toISOString(), contact_ids: contacts.map((c) => c.id), attendee_user_ids: attendees,
      });
      ui.toast({ kind: "success", title: "Viewing scheduled", body: formatWhen(ev.start_at) });
      onSaved(ev);
    } catch (e2) {
      setErrors(fieldErrors(e2));
      if (!Object.keys(fieldErrors(e2)).length) ui.toast({ kind: "error", title: "Couldn't schedule the viewing", body: describeError(e2) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Schedule a viewing" description={property.display_name} onClose={onClose} dismissible={!busy}>
      <form className="form" onSubmit={submit} noValidate>
        <div className="vx-grid-2">
          <Field id={`${uid}-w`} label="When" error={errors.start_at}>
            <input id={`${uid}-w`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <Field id={`${uid}-m`} label="Length">
            <select id={`${uid}-m`} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {[30, 45, 60, 90].map((n) => (
                <option key={n} value={n}>
                  {n} minutes
                </option>
              ))}
            </select>
          </Field>
        </div>
        <SearchPicker id={`${uid}-c`} label="Add a buyer or tenant" placeholder="Search contacts" search={search} render={(c) => c.display_name}
          onPick={(c) => setContacts((x) => (x.some((y) => y.id === c.id) ? x : [...x, { id: c.id, display_name: c.display_name }]))} />
        {contacts.length ? (
          <div className="vx-list-chips">
            {contacts.map((c) => (
              <span key={c.id} className="badge badge-accent">
                {c.display_name}{" "}
                <button type="button" className="link-button xsmall" aria-label={`Remove ${c.display_name}`} onClick={() => setContacts((x) => x.filter((y) => y.id !== c.id))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {errors.contact_ids ? <p className="form-error">{errors.contact_ids}</p> : null}
        <MemberChips legend="From the team" value={attendees} onChange={setAttendees} />
        <p className="xsmall subtle">On your team's calendar only: buyers aren't emailed an invitation (that comes with the Gmail integration).</p>
        <div className="cluster">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size="sm" /> : <CalendarPlus aria-hidden="true" />} Schedule viewing
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function PropertyDetailView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { api, crm } = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const res = useApiResource((a, signal) => a.get<PropertyDetail>(`${crm}/properties/${id}`, undefined, signal), [crm, id]);
  const [dialog, setDialog] = useState<"viewing" | null>(null);
  const [linkRole, setLinkRole] = useState("interested");
  const search = useContactSearch();
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  const p = res.data;
  if (!p) return <LoadingState />;
  const link = async (contactId: string) => {
    try {
      await api.post(`${crm}/properties/${p.id}/contacts`, { contact_id: contactId, role: linkRole });
      ui.toast({ kind: "success", title: "Person added" });
      res.reload();
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't add them", body: describeError(e) });
    }
  };
  return (
    <article className="ws-detail" aria-labelledby="property-title">
      <header className="ws-detail-header">
        <a href={areaHash("properties")} className="icon-btn ws-back" aria-label="Back to properties">
          <ArrowLeft aria-hidden="true" />
        </a>
        <div className="ws-detail-titles">
          <h2 id="property-title">{p.address_line1}</h2>
          <p className="muted small">{[p.address_line2, p.city, p.region, p.postal_code].filter(Boolean).join(", ")}</p>
          <div className="cluster ws-badges">
            <PropertyStatusBadge status={p.status} />
            <span className="badge">{p.listing_type === "rent" ? "For rent" : "For sale"}</span>
            <span className="badge">{PROPERTY_TYPE_LABEL[p.property_type] ?? p.property_type}</span>
            {p.visibility === "private" ? <span className="badge">Private</span> : null}
            <DemoBadge show={p.is_demo} />
          </div>
        </div>
        <div className="ws-detail-actions">
          <button type="button" className="btn btn-sm" onClick={() => setDialog("viewing")}>
            <CalendarPlus aria-hidden="true" /> Schedule viewing
          </button>
          {p.permissions.change ? (
            <a className="btn btn-sm" href={areaHash("properties", p.id, "edit")}>
              <Pencil aria-hidden="true" /> Edit
            </a>
          ) : null}
          {p.permissions.delete ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={async () => {
                if (!window.confirm(`Delete ${p.display_name}? Its links to people and deals go too.`)) return;
                try {
                  await api.delete(`${crm}/properties/${p.id}`);
                  ui.toast({ kind: "success", title: "Property deleted" });
                  onDeleted();
                } catch (e) {
                  ui.toast({ kind: "error", title: "Couldn't delete it", body: describeError(e) });
                }
              }}
            >
              <Trash2 aria-hidden="true" /> Delete
            </button>
          ) : null}
        </div>
      </header>
      <div className="ws-detail-grid">
        <div className="ws-detail-main">
          <section className="ws-section" aria-label="Listing">
            <dl className="vx-kv-inline">
              <div>
                <dt>Price</dt>
                <dd>{money(p.list_price, p.currency)}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{propertyFacts(p) || "—"}</dd>
              </div>
              {p.year_built ? (
                <div>
                  <dt>Built</dt>
                  <dd>{p.year_built}</dd>
                </div>
              ) : null}
              {p.listed_at ? (
                <div>
                  <dt>Listed</dt>
                  <dd>{formatWhen(p.listed_at, { time: false })}</dd>
                </div>
              ) : null}
            </dl>
            {p.headline ? <p className="ws-row-title">{p.headline}</p> : null}
            {p.description ? <p className="ws-tl-text">{p.description}</p> : <p className="muted small">No listing details yet.</p>}
            <SourceNote p={p} />
          </section>
          <section className="ws-section" aria-labelledby={`${uid}-v`}>
            <header className="ws-section-header">
              <h3 id={`${uid}-v`}>
                <CalendarPlus aria-hidden="true" /> Viewings
              </h3>
            </header>
            {p.viewings.length === 0 ? <p className="muted small">No viewings yet.</p> : null}
            <ul className="ws-list">
              {p.viewings.map((e) => (
                <li key={e.id}>
                  <a className="ws-row-link" href={areaHash("calendar", "event", e.id)}>
                    <span className="ws-row-main">
                      <span className="ws-row-title">{formatWhen(e.start_at)}</span>
                      <span className="ws-row-meta">
                        {e.attendee_contacts.map((c) => c.display_name).join(", ") || "No buyer added"}
                        {e.organizer ? ` · ${e.organizer.name}` : ""}
                        {e.status !== "scheduled" ? ` · ${e.status}` : ""}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
          {p.notes ? (
            <section className="ws-section" aria-label="Internal notes">
              <h3 className="ws-section-title">Internal notes</h3>
              <p className="ws-tl-text">{p.notes}</p>
            </section>
          ) : null}
        </div>
        <aside className="ws-detail-side" aria-label="People and deals">
          <dl className="ws-kv">
            <dt>Listing agent</dt>
            <dd>
              <UserLabel user={p.owner} fallback="Nobody yet" />
            </dd>
            <dt>Updated</dt>
            <dd>{formatWhen(p.updated_at)}</dd>
          </dl>
          <div className="ws-side-block">
            <h3>People</h3>
            {p.contacts.length === 0 ? <p className="muted small">Nobody linked yet.</p> : null}
            <ul className="ws-list compact">
              {p.contacts.map((l) => (
                <li key={l.id} className="cluster-between">
                  <a href={areaHash("contacts", l.contact.id)}>{l.contact.display_name}</a>
                  <span className="cluster">
                    <span className="badge">{l.role_label}</span>
                    {l.permissions.delete ? (
                      <DeleteButton
                        label={`Remove ${l.contact.display_name}`}
                        onConfirm={async () => {
                          await api.delete(`${crm}/property-contacts/${l.id}`);
                          res.reload();
                        }}
                      />
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {p.permissions.change ? (
              <div className="stack-sm">
                <label className="visually-hidden" htmlFor={`${uid}-role`}>
                  Role
                </label>
                <select id={`${uid}-role`} className="vx-compact" value={linkRole} onChange={(e) => setLinkRole(e.target.value)}>
                  {CONTACT_ROLES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <SearchPicker id={`${uid}-pc`} label="Link a person" placeholder="Link a person: search contacts" hideLabel search={search} render={(c) => (
                  <>
                    <UserPlus aria-hidden="true" className="inline-icon" /> {c.display_name}
                  </>
                )} onPick={(c) => void link(c.id)} />
              </div>
            ) : null}
          </div>
          <div className="ws-side-block">
            <h3>Deals</h3>
            {p.deals.length === 0 ? <p className="muted small">Not part of a deal yet. Link it from the deal's page.</p> : null}
            <ul className="ws-list compact">
              {p.deals.map((d) => (
                <li key={d.id}>
                  <a className="ws-row-link" href={areaHash("crm", d.opportunity.id)}>
                    <span className="ws-row-main">
                      <span className="ws-row-title">{d.opportunity.name}</span>
                      <span className="ws-row-meta">{d.role_label}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
      {dialog === "viewing" ? (
        <ViewingDialog
          property={p}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            res.reload();
          }}
        />
      ) : null}
    </article>
  );
}

interface PropForm {
  [k: string]: string | number | null | string[];
}

function PropertyForm({ existing }: { existing: Property | null }) {
  const { api, crm, members } = useWorkspace();
  const ui = useUi();
  const uid = useId();
  const init = (k: keyof Property, d: string = "") => (existing && existing[k] !== null && existing[k] !== undefined ? String(existing[k]) : d);
  const [f, setF] = useState<PropForm>({
    address_line1: init("address_line1"), address_line2: init("address_line2"), city: init("city"), region: init("region"), postal_code: init("postal_code"),
    country: init("country", "US"), listing_type: init("listing_type", "sale"), property_type: init("property_type", "house"), status: init("status", "prospect"),
    list_price: init("list_price"), bedrooms: init("bedrooms"), bathrooms: init("bathrooms"), area: init("area"), area_unit: init("area_unit", "sqft"),
    year_built: init("year_built"), headline: init("headline"), description: init("description"), notes: init("notes"), visibility: init("visibility", "team"),
    source: init("source", "manual"), source_detail: init("source_detail"), owner_id: existing?.owner?.id ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const num = (v: unknown) => (v === "" || v === null ? null : Number(v));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const body: Record<string, unknown> = {
      ...f, list_price: f.list_price === "" ? null : f.list_price, bathrooms: f.bathrooms === "" ? null : f.bathrooms, bedrooms: num(f.bedrooms), area: num(f.area),
      year_built: num(f.year_built), owner_id: f.owner_id || null,
    };
    if (existing?.source === "integration") delete body.source;
    try {
      const saved = existing ? await api.patch<Property>(`${crm}/properties/${existing.id}`, body) : await api.post<Property>(`${crm}/properties`, body);
      ui.toast({ kind: "success", title: existing ? "Property saved" : "Property added", body: saved.display_name });
      navigate(areaHash("properties", saved.id));
    } catch (e2) {
      const fe = fieldErrors(e2);
      setErrors(fe);
      if (!Object.keys(fe).length) ui.toast({ kind: "error", title: "Couldn't save the property", body: describeError(e2) });
      else ui.toast({ kind: "error", title: "Check the highlighted fields." });
    } finally {
      setBusy(false);
    }
  };
  const text = (k: string, label: string, opts: { required?: boolean; hint?: string; inputMode?: "decimal" | "numeric" } = {}) => (
    <Field id={`${uid}-${k}`} label={label} error={errors[k]} hint={opts.hint}>
      <input id={`${uid}-${k}`} type="text" inputMode={opts.inputMode} value={String(f[k] ?? "")} onChange={set(k)} required={opts.required} aria-invalid={errors[k] ? "true" : undefined}
        aria-describedby={errors[k] ? `${uid}-${k}-err` : undefined} />
    </Field>
  );
  const select = (k: string, label: string, options: [string, string][]) => (
    <Field id={`${uid}-${k}`} label={label} error={errors[k]}>
      <select id={`${uid}-${k}`} value={String(f[k])} onChange={set(k)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <form className="ws-form" onSubmit={submit} noValidate aria-labelledby={`${uid}-title`}>
      <header className="ws-detail-header">
        <a href={existing ? areaHash("properties", existing.id) : areaHash("properties")} className="icon-btn" aria-label="Back">
          <ArrowLeft aria-hidden="true" />
        </a>
        <div className="ws-detail-titles">
          <h2 id={`${uid}-title`}>{existing ? `Edit ${existing.display_name}` : "New property"}</h2>
          <p className="muted small">Enter what you know. Nexus never fills in listing data from outside sources.</p>
        </div>
      </header>
      <fieldset className="ws-form-grid">
        <legend className="ws-legend">Address</legend>
        {text("address_line1", "Street address", { required: true })}
        {text("address_line2", "Unit, building (optional)")}
        {text("city", "City")}
        {text("region", "State / region")}
        {text("postal_code", "Postal code")}
        {text("country", "Country (2 letters)")}
      </fieldset>
      <fieldset className="ws-form-grid">
        <legend className="ws-legend">Listing</legend>
        {select("status", "Status", STATUSES.map((s) => [s, PROPERTY_STATUS_LABEL[s]]))}
        {select("listing_type", "For", [["sale", "Sale"], ["rent", "Rent"]])}
        {select("property_type", "Type", Object.entries(PROPERTY_TYPE_LABEL))}
        {text("list_price", "Price (USD)", { inputMode: "decimal" })}
        {text("bedrooms", "Bedrooms", { inputMode: "numeric" })}
        {text("bathrooms", "Bathrooms", { inputMode: "decimal" })}
        {text("area", "Area", { inputMode: "numeric" })}
        {select("area_unit", "Unit", [["sqft", "sq ft"], ["sqm", "m²"]])}
        {text("year_built", "Year built", { inputMode: "numeric" })}
        {text("headline", "Headline")}
        <Field id={`${uid}-description`} label="Listing details" className="vx-span" error={errors.description}>
          <textarea id={`${uid}-description`} rows={4} value={String(f.description)} onChange={set("description")} maxLength={5000} />
        </Field>
      </fieldset>
      <fieldset className="ws-form-grid">
        <legend className="ws-legend">Team</legend>
        <Field id={`${uid}-owner`} label="Listing agent" error={errors.owner_id}>
          <select id={`${uid}-owner`} value={String(f.owner_id)} onChange={set("owner_id")}>
            <option value="">Nobody</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        {select("visibility", "Who can see it", [["team", "Shared with the team"], ["private", "Private (owner and managers)"]])}
        {existing?.source === "integration" ? null : select("source", "Where it came from", [["manual", "Entered by hand"], ["import", "Imported (say from where)"]])}
        {f.source === "import" ? text("source_detail", "Import label", { hint: "E.g. “Office spreadsheet, Oct 2026”." }) : null}
        <Field id={`${uid}-notes`} label="Internal notes (never published)" error={errors.notes}>
          <textarea id={`${uid}-notes`} rows={3} value={String(f.notes)} onChange={set("notes")} maxLength={5000} />
        </Field>
      </fieldset>
      <div className="ws-form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner size="sm" /> : null} {existing ? "Save property" : "Add property"}
        </button>
        <a className="btn btn-ghost" href={existing ? areaHash("properties", existing.id) : areaHash("properties")}>
          Cancel
        </a>
      </div>
    </form>
  );
}

function EditProperty({ id }: { id: string }) {
  const { crm } = useWorkspace();
  const res = useApiResource((a, signal) => a.get<Property>(`${crm}/properties/${id}`, undefined, signal), [crm, id]);
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data) return <LoadingState />;
  if (!res.data.permissions.change) return <EmptyState icon={Building2} title="You can't edit this property" />;
  return <PropertyForm existing={res.data} />;
}

function PropertiesPage({ path }: AreaProps) {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [status, setStatus] = useState("");
  const [mine, setMine] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const query = useMemo(() => ({ q: dq, status, owner: mine ? "me" : "", limit: 100 }), [dq, status, mine]);
  const res = useApiResource((api, signal) => api.list<Property>(`${ws.crm}/properties`, query, signal), [ws.crm, query]);
  const selected = path[0] && path[0] !== "new" ? path[0] : null;
  if (path[0] === "new") return ws.can("records.create") ? <div className="ws-area-scroll"><PropertyForm existing={null} /></div> : <EmptyState title="Your role can't add properties" />;
  if (selected && path[1] === "edit") return <div className="ws-area-scroll"><EditProperty id={selected} /></div>;
  return (
    <div className="ws-split wide-list" data-detail={selected ? "open" : "closed"}>
      <section className="ws-list-pane" aria-label="Properties">
        <header className="ws-list-header">
          <div className="cluster-between">
            <h1 className="ws-list-title">
              <Building2 aria-hidden="true" /> Properties
            </h1>
            {ws.can("records.create") ? (
              <a className="btn btn-sm btn-primary" href={areaHash("properties", "new")}>
                <Plus aria-hidden="true" /> New
              </a>
            ) : null}
          </div>
          <div className="ws-search">
            <Search aria-hidden="true" />
            <label className="visually-hidden" htmlFor="prop-q">
              Search properties
            </label>
            <input id="prop-q" type="search" placeholder="Search address, city, postcode" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="ws-filters" role="group" aria-label="Filters">
            <label className="visually-hidden" htmlFor="prop-status">
              Status
            </label>
            <select id="prop-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PROPERTY_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <button type="button" className="chip" aria-pressed={mine} onClick={() => setMine((v) => !v)}>
              Mine
            </button>
          </div>
        </header>
        <div className="ws-list-scroll" onKeyDown={listKeys} data-loading={res.loading ? "true" : undefined}>
          {res.error ? <ErrorState error={res.error} onRetry={res.reload} compact /> : null}
          {res.loading && !res.data ? <LoadingState /> : null}
          {res.data && res.data.data.length === 0 ? (
            <EmptyState icon={Building2} title={dq || status || mine ? "No properties match" : "No properties yet"}>
              {dq || status || mine ? "Try other filters." : "Add the homes you list or show. Nothing is pulled from listing services."}
            </EmptyState>
          ) : null}
          <ul className="ws-records">
            {(res.data?.data ?? []).map((p) => (
              <li key={p.id}>
                <a data-nav-item href={areaHash("properties", p.id)} className={`ws-record${p.id === selected ? " active" : ""}`} aria-current={p.id === selected ? "page" : undefined}>
                  <span className="ws-record-main">
                    <span className="ws-record-top">
                      <span className="ws-row-title">{p.address_line1}</span>
                      <span className="vx-prop-price">{money(p.list_price, p.currency)}</span>
                    </span>
                    <span className="ws-row-meta">
                      {[p.city, propertyFacts(p)].filter(Boolean).join(" · ")}
                    </span>
                    <span className="cluster ws-badges">
                      <PropertyStatusBadge status={p.status} />
                      {p.source !== "manual" ? <span className="badge">{p.source === "import" ? "Imported" : "Synced"}</span> : null}
                      <DemoBadge show={p.is_demo} />
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <section className="ws-detail-pane" aria-label="Property">
        {selected ? (
          <PropertyDetailView key={selected} id={selected} onDeleted={() => { res.reload(); navigate(areaHash("properties")); }} />
        ) : (
          <EmptyState icon={Building2} title="Select a property">
            See its listing, the people involved, deals and viewings.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function PropertiesArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <PropertiesPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "properties",
  label: "Properties",
  icon: Building2,
  order: 72,
  status: "ready",
  feature: "real_estate",
  summary: "Your listings and the homes your buyers look at, with people, deals and viewings.",
  component: PropertiesArea,
});
