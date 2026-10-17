/**
 * Integrations: connect and disconnect Gmail, GoHighLevel and Slack; see the connected account,
 * granted scopes, status, last sync and errors (with retry); the setup steps when the server
 * isn't configured yet; and the "Mock provider (development)" label in mock mode.
 */

import { useEffect, useId, useState, type FormEvent } from "react";
import { Building2, FlaskConical, Hash, KeyRound, Link2, Mail, Plug, RefreshCw, Settings2, Unplug } from "lucide-react";
import "../../styles/integrations.css";
import { useUi } from "../../components/UiContext";
import { CopyButton } from "../../components/primitives/CopyButton";
import { Dialog } from "../../components/primitives/Dialog";
import { Spinner } from "../../components/primitives/Spinner";
import { navigate } from "../../hooks/useRoute";
import { ApiError, describeError } from "../api";
import { useApiResource, useWorkspace } from "../context";
import { areaHash, defineArea, type AreaProps } from "../define";
import { ConnectionGate, EmptyState, ErrorState, LoadingState, PageHeader, formatWhen } from "../ui";
import { MOCK_LABEL, MockBadge, StatusBadge } from "../integrations/ui";
import type { Connection, ProviderId, ProviderInfo } from "../integrations/types";

const ICON: Record<ProviderId, typeof Mail> = { gmail: Mail, gohighlevel: Building2, slack: Hash };

export const RESULT_MESSAGES: Record<string, string> = {
  state_invalid: "The connection link wasn't valid. Start again from here.",
  state_expired: "Connecting took too long. Start again.",
  state_used: "That connection link was already used. Start again.",
  state_missing: "The provider didn't send the connection state back. Start again.",
  session_mismatch: "Connecting was started in another browser or session. Start again here.",
  wrong_user: "You're signed in to the portal as someone else. Sign in as yourself and start again.",
  not_signed_in: "Sign in to the portal, then connect again.",
  access_denied: "You didn't allow access, so nothing was connected.",
  code_rejected: "The provider didn't accept the authorization. Try again.",
  scope_denied: "A required permission wasn't granted, so nothing was connected.",
  no_offline_access: "Google didn't grant offline access. Remove the app's access in your Google account and connect again.",
  account_in_use: "That account is already connected in this workspace.",
  wrong_account: "You signed in to a different account than the one being reconnected.",
  agency_install_unsupported: "Install the HighLevel app on one sub-account (not agency-wide) to connect it here.",
  enterprise_install_unsupported: "Org-wide Slack installs aren't supported yet. Install the app to one Slack workspace.",
  not_allowed: "Your role can't connect this integration in this workspace.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
};

function useBase(): string {
  const ws = useWorkspace();
  return `/workspaces/${ws.workspace!.id}/integrations`;
}

function Facts({ c }: { c: Connection }) {
  return (
    <dl className="ig-facts">
      <dt>Account</dt>
      <dd>{c.account.label || c.account.id}</dd>
      <dt>{c.scope === "personal" ? "Mailbox owner" : "Connected by"}</dt>
      <dd>{c.owner?.name ?? "—"}</dd>
      <dt>Method</dt>
      <dd>{c.auth_method === "private_token" ? "Private integration token" : "OAuth"}</dd>
      <dt>Last sync</dt>
      <dd>{c.syncing ? "Syncing now…" : c.last_sync_at ? formatWhen(c.last_sync_at) : "Not yet"}</dd>
      {c.next_sync_at && c.status !== "needs_reauth" ? (
        <>
          <dt>Next sync</dt>
          <dd>{formatWhen(c.next_sync_at)}</dd>
        </>
      ) : null}
      {c.last_webhook_at ? (
        <>
          <dt>Last event</dt>
          <dd>{formatWhen(c.last_webhook_at)}</dd>
        </>
      ) : null}
    </dl>
  );
}

function DisconnectDialog({ c, onClose, onDone }: { c: Connection; onClose: () => void; onDone: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const [deleteData, setDeleteData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ revoked_at_provider: boolean; manual_step: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await ws.api.post<{ revoked_at_provider: boolean; manual_step: string }>(`${base}/connections/${c.id}/disconnect`, { delete_data: deleteData });
      setResult(r);
      ui.toast({ kind: "success", title: `${c.provider_label} disconnected` });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Disconnect ${c.provider_label}?`} description={c.account.label} onClose={onClose} dismissible={!busy}>
      {result ? (
        <div className="stack">
          <p>{result.revoked_at_provider ? `${c.provider_label} confirmed the access was revoked. The stored tokens are deleted.` : "The stored tokens are deleted."}</p>
          {result.manual_step ? <p className="ig-error warn">{result.manual_step}</p> : null}
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <div className="stack">
          <p className="small">
            We revoke the access at {c.provider_label} where its API allows it and delete the stored tokens right away. Entries already added to
            contact or deal timelines stay there.
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
            <span>Also delete everything synced from this account now (otherwise it's hidden and deleted after 30 days)</span>
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="cluster">
            <button type="button" className="btn btn-danger" onClick={() => void run()} disabled={busy}>
              {busy ? <Spinner size="sm" /> : <Unplug aria-hidden="true" />} Disconnect
            </button>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Keep connected
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function SlackSettings({ c, onSaved }: { c: Connection; onSaved: (c: Connection) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const uid = useId();
  const channels = useApiResource(
    (api, signal) => (c.permissions.change ? api.get<{ id: string; name: string; is_private: boolean; is_member: boolean; selected: boolean }[]>(`${base}/connections/${c.id}/slack-channels`, undefined, signal) : Promise.resolve([])),
    [base, c.id, c.permissions.change],
  );
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [memberId, setMemberId] = useState(c.settings.my_slack_user_id ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (channels.data && chosen === null) setChosen(channels.data.filter((x) => x.selected).map((x) => x.id));
  }, [channels.data, chosen]);
  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const updated = await ws.api.patch<Connection>(`${base}/connections/${c.id}`, body);
      onSaved(updated);
      ui.toast({ kind: "success", title: done });
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't save", body: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {c.permissions.change ? (
        <fieldset className="ig-form">
          <legend className="small">
            <strong>Channels to bring into the inbox</strong>
          </legend>
          {channels.loading && !channels.data ? <LoadingState label="Loading channels…" /> : null}
          {channels.error ? <ErrorState error={channels.error} onRetry={channels.reload} compact /> : null}
          {channels.data ? (
            channels.data.length ? (
              <ul className="ig-channels">
                {channels.data.map((ch) => (
                  <li key={ch.id}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={!ch.is_member}
                        checked={!!chosen?.includes(ch.id)}
                        onChange={(e) => setChosen((p) => (e.target.checked ? [...(p ?? []), ch.id] : (p ?? []).filter((x) => x !== ch.id)))}
                      />
                      <span>
                        #{ch.name}
                        {ch.is_private ? " (private)" : ""}
                        {!ch.is_member ? <span className="subtle"> · invite the app first: /invite in #{ch.name}</span> : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">The app can't see any channels yet.</p>
            )
          ) : null}
          <p className="xsmall subtle">Only these channels' messages are stored, for a limited time. Removing a channel deletes what was stored from it.</p>
          <div>
            <button type="button" className="btn btn-sm" disabled={busy || chosen === null} onClick={() => void save({ channels: chosen ?? [] }, "Channels saved")}>
              {busy ? <Spinner size="sm" /> : null} Save channels
            </button>
          </div>
        </fieldset>
      ) : null}
      <form
        className="ig-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void save({ my_slack_user_id: memberId.trim() }, "Saved");
        }}
      >
        <label className="small" htmlFor={`${uid}-member`}>
          Your Slack member ID (for “mentions me”)
        </label>
        <div className="ws-inline-fields">
          <input id={`${uid}-member`} type="text" value={memberId} placeholder="U0123ABCD" maxLength={40} onChange={(e) => setMemberId(e.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={busy}>
            Save
          </button>
        </div>
        <p className="xsmall subtle">In Slack: your profile → ⋮ → Copy member ID.</p>
      </form>
    </div>
  );
}

function GhlSettings({ c, onSaved }: { c: Connection; onSaved: (c: Connection) => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const [busy, setBusy] = useState(false);
  if (!ws.can("integrations.own")) return null;
  return (
    <div className="ig-form">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!c.settings.workflow_triggers_enabled}
          disabled={busy}
          onChange={async (e) => {
            setBusy(true);
            try {
              onSaved(await ws.api.patch<Connection>(`${base}/connections/${c.id}`, { workflow_triggers_enabled: e.target.checked }));
            } catch (err) {
              ui.toast({ kind: "error", title: "Couldn't save", body: describeError(err) });
            } finally {
              setBusy(false);
            }
          }}
        />
        <span>Allow starting HighLevel workflows from here (each start still needs a confirmation)</span>
      </label>
      {c.settings.environment_blocks_workflows ? (
        <p className="xsmall subtle">This is a test environment: workflows and campaigns are never started from here, whatever this setting says.</p>
      ) : null}
    </div>
  );
}

function ConnectionCard({ c, onChanged }: { c: Connection; onChanged: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const [busy, setBusy] = useState<string | null>(null);
  const [current, setCurrent] = useState(c);
  const [disconnecting, setDisconnecting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  useEffect(() => setCurrent(c), [c]);
  const retry = async () => {
    setBusy("sync");
    try {
      const r = await ws.api.post<{ result: { ok: boolean; code?: string }; connection: Connection }>(`${base}/connections/${c.id}/sync`, {});
      setCurrent(r.connection);
      ui.toast(r.result.ok ? { kind: "success", title: "Synced" } : { kind: "error", title: "Sync didn't finish", body: r.connection.last_error?.message ?? r.result.code });
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't sync", body: describeError(e) });
    } finally {
      setBusy(null);
    }
  };
  const reconnect = async () => {
    setBusy("reconnect");
    try {
      const r = await ws.api.post<{ authorize_url: string }>(`${base}/connections/oauth-start`, { provider: c.provider, reconnect_id: c.id });
      window.location.assign(r.authorize_url);
    } catch (e) {
      ui.toast({ kind: "error", title: "Couldn't start reconnecting", body: describeError(e) });
      setBusy(null);
    }
  };
  const err = current.last_error;
  return (
    <article className="ig-conn" aria-label={`${current.provider_label} connection ${current.account.label}`}>
      <div className="ig-conn-head">
        <strong>{current.account.label || current.account.id}</strong>
        <span className="cluster">
          <StatusBadge status={current.status} />
          <MockBadge show={current.is_mock} label={current.mock_label} />
        </span>
      </div>
      <Facts c={current} />
      {current.status === "needs_reauth" ? (
        <div className="ig-error warn" role="status">
          <span>{err?.message ?? "This connection needs to be reconnected."}</span>
          {current.actions.reconnect ? (
            <div>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => void reconnect()} disabled={!!busy}>
                {busy === "reconnect" ? <Spinner size="sm" /> : <Link2 aria-hidden="true" />} Reconnect
              </button>
            </div>
          ) : null}
        </div>
      ) : err ? (
        <div className="ig-error" role="status">
          <span>
            {err.message} {err.at ? <span className="subtle">({formatWhen(err.at)})</span> : null}
          </span>
        </div>
      ) : null}
      {current.missing_scopes.length ? (
        <p className="xsmall subtle">Not granted: {current.missing_scopes.join(", ")}. Some actions stay unavailable until you reconnect and allow them.</p>
      ) : null}
      {current.granted_scopes.length ? (
        <details className="ig-setup">
          <summary>Granted permissions ({current.granted_scopes.length})</summary>
          <div className="ig-scopes">
            {current.granted_scopes.map((s) => (
              <code key={s}>{s}</code>
            ))}
          </div>
        </details>
      ) : current.auth_method === "private_token" ? (
        <p className="xsmall subtle">Permissions were chosen in HighLevel when the token was created.</p>
      ) : null}
      {current.provider === "slack" && current.status !== "disconnected" ? (
        <SlackSettings
          c={current}
          onSaved={(u) => {
            setCurrent(u);
            onChanged();
          }}
        />
      ) : null}
      {current.provider === "gohighlevel" && current.status !== "disconnected" ? <GhlSettings c={current} onSaved={setCurrent} /> : null}
      <div className="cluster">
        {current.actions.retry ? (
          <button type="button" className="btn btn-sm" onClick={() => void retry()} disabled={!!busy}>
            {busy === "sync" ? <Spinner size="sm" /> : <RefreshCw aria-hidden="true" />} {err ? "Retry now" : "Sync now"}
          </button>
        ) : null}
        {current.actions.reconnect && current.status !== "needs_reauth" ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void reconnect()} disabled={!!busy}>
            <Link2 aria-hidden="true" /> Reconnect
          </button>
        ) : null}
        {current.auth_method === "private_token" && current.actions.disconnect ? (
          <button type="button" className="btn btn-sm btn-ghost" aria-expanded={replacing} onClick={() => setReplacing((v) => !v)} disabled={!!busy}>
            <KeyRound aria-hidden="true" /> Replace token
          </button>
        ) : null}
        {current.actions.disconnect ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDisconnecting(true)} disabled={!!busy}>
            <Unplug aria-hidden="true" /> Disconnect
          </button>
        ) : null}
      </div>
      {replacing ? (
        <PrivateTokenForm
          locationId={current.account.id}
          onDone={() => {
            setReplacing(false);
            onChanged();
          }}
        />
      ) : null}
      {disconnecting ? <DisconnectDialog c={current} onClose={() => setDisconnecting(false)} onDone={onChanged} /> : null}
    </article>
  );
}

function SetupInstructions({ p, open }: { p: ProviderInfo; open: boolean }) {
  return (
    <details className="ig-setup" open={open}>
      <summary>
        <Settings2 aria-hidden="true" className="inline-icon" />{" "}
        {p.mock ? `Setting up the real ${p.label} (administrators)` : p.configured ? "Server setup" : "How an administrator sets this up"}
      </summary>
      <ol>
        {p.setup.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="small">
        <strong>Settings on the server</strong> (names only; secrets go in secret files, never in chat or email):
      </p>
      <ul className="ig-env">
        {p.setup.env.map((e) => (
          <li key={e.name}>
            <code>{e.name}</code>
            <span className={`badge ${e.set ? "ib-status-ok" : ""}`}>{e.set ? "set" : "missing"}</span>
            {e.secret ? <span className="xsmall subtle">secret file</span> : null}
            {e.note ? <span className="xsmall subtle">{e.note}</span> : null}
          </li>
        ))}
      </ul>
      <p className="small">
        <strong>Redirect URI</strong>
      </p>
      <div className="ws-inline-fields">
        <code className="ig-url">{p.setup.redirect_uri}</code>
        <CopyButton text={p.setup.redirect_uri} className="btn btn-sm btn-ghost" />
      </div>
      {p.setup.webhook_url ? (
        <>
          <p className="small">
            <strong>{p.id === "slack" ? "Event Subscriptions request URL" : "Webhook URL"}</strong>
          </p>
          <div className="ws-inline-fields">
            <code className="ig-url">{p.setup.webhook_url}</code>
            <CopyButton text={p.setup.webhook_url} className="btn btn-sm btn-ghost" />
          </div>
        </>
      ) : null}
      <p className="small">
        <a href={p.setup.docs_url} target="_blank" rel="noopener noreferrer">
          Official documentation
        </a>{" "}
        · full guide: docs/nexus/INTEGRATIONS.md
      </p>
    </details>
  );
}

/** Connects with a private integration token, or replaces the token of the connected location (`locationId`). */
function PrivateTokenForm({ onDone, locationId }: { onDone: () => void; locationId?: string }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const uid = useId();
  const [token, setToken] = useState("");
  const [location, setLocation] = useState(locationId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="ig-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await ws.api.post(`${base}/connections/private-token`, { provider: "gohighlevel", token, location_id: location });
          setToken("");
          ui.toast({ kind: "success", title: locationId ? "Token replaced" : "GoHighLevel connected" });
          onDone();
        } catch (err) {
          setError(err instanceof ApiError ? (err.field("token") ?? err.field("location_id") ?? describeError(err)) : describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="small" htmlFor={`${uid}-loc`}>
        Location ID (sub-account)
      </label>
      <input
        id={`${uid}-loc`}
        type="text"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        readOnly={!!locationId}
        required
        maxLength={120}
        autoComplete="off"
      />
      <label className="small" htmlFor={`${uid}-tok`}>
        Private integration token
      </label>
      <input id={`${uid}-tok`} type="password" value={token} onChange={(e) => setToken(e.target.value)} required maxLength={2000} autoComplete="off" />
      <p className="xsmall subtle">Stored encrypted on the server and never shown again. Rotate it in HighLevel every 90 days.</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <button type="submit" className="btn btn-sm" disabled={busy || !token || !location}>
          {busy ? <Spinner size="sm" /> : <KeyRound aria-hidden="true" />} {locationId ? "Save new token" : "Connect with token"}
        </button>
      </div>
    </form>
  );
}

function ProviderCard({ p, onChanged }: { p: ProviderInfo; onChanged: () => void }) {
  const ws = useWorkspace();
  const ui = useUi();
  const base = useBase();
  const Icon = ICON[p.id];
  const [busy, setBusy] = useState(false);
  const [privateChannels, setPrivateChannels] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const mine = p.connections.filter((c) => p.scope === "workspace" || c.is_mine);
  const others = p.connections.filter((c) => p.scope === "personal" && !c.is_mine);
  const status = mine[0]?.status ?? (p.configured ? "not_connected" : "not_configured");
  const connect = async () => {
    setBusy(true);
    try {
      const r = await ws.api.post<{ authorize_url: string }>(`${base}/connections/oauth-start`, {
        provider: p.id,
        ...(p.id === "slack" && privateChannels ? { options: { private_channels: true } } : {}),
      });
      window.location.assign(r.authorize_url);
    } catch (e) {
      ui.toast({ kind: "error", title: `Couldn't start connecting ${p.label}`, body: describeError(e) });
      setBusy(false);
    }
  };
  const canAddAnother = p.scope === "personal" ? mine.length === 0 : mine.length === 0;
  return (
    <section className="ig-card" aria-labelledby={`ig-${p.id}`}>
      <header className="ig-card-head">
        <span className="ig-logo" aria-hidden="true">
          <Icon />
        </span>
        <div className="ig-card-titles">
          <h2 id={`ig-${p.id}`}>{p.label}</h2>
          <span className="cluster">
            <StatusBadge status={status} />
            <span className="badge">{p.scope === "personal" ? "Personal" : "Workspace-wide"}</span>
            <MockBadge show={p.mock} label={p.mock_label} />
          </span>
        </div>
      </header>
      <p className="small muted">{p.description}</p>
      {mine.map((c) => (
        <ConnectionCard key={c.id} c={c} onChanged={onChanged} />
      ))}
      {others.length ? (
        <details className="ig-setup">
          <summary>Mailboxes connected by others ({others.length})</summary>
          <p className="xsmall subtle">You see their status only, never their mail. You can disconnect them (for example when someone leaves).</p>
          {others.map((c) => (
            <ConnectionCard key={c.id} c={c} onChanged={onChanged} />
          ))}
        </details>
      ) : null}
      {canAddAnother ? (
        p.configured ? (
          p.can_connect ? (
            <div className="stack">
              {p.id === "slack" && p.methods.includes("oauth") ? (
                <label className="checkbox small">
                  <input type="checkbox" checked={privateChannels} onChange={(e) => setPrivateChannels(e.target.checked)} />
                  <span>Also allow private channels the app is invited to (adds groups:read and groups:history)</span>
                </label>
              ) : null}
              <div className="cluster">
                {p.methods.includes("oauth") ? (
                  <button type="button" className="btn btn-primary" onClick={() => void connect()} disabled={busy}>
                    {busy ? <Spinner size="sm" /> : <Plug aria-hidden="true" />} {p.scope === "personal" ? `Connect your ${p.label}` : `Connect ${p.label}`}
                    {p.mock ? " (mock)" : ""}
                  </button>
                ) : null}
                {p.methods.includes("private_token") ? (
                  <button type="button" className="btn btn-ghost" aria-expanded={showToken} onClick={() => setShowToken((v) => !v)}>
                    <KeyRound aria-hidden="true" /> Use a private integration token
                  </button>
                ) : null}
              </div>
              {showToken ? <PrivateTokenForm onDone={onChanged} /> : null}
              <p className="xsmall subtle">
                {p.scope === "personal"
                  ? "Only you will see your synced mail. We never ask for your password."
                  : "Synced items are shared with everyone in this workspace who can see records."}
              </p>
            </div>
          ) : (
            <p className="small muted">
              {p.scope === "workspace" ? "Only workspace owners and admins can connect this." : "Your role can't connect a mailbox."}
            </p>
          )
        ) : (
          <p className="small muted">Not set up on this server yet. An administrator needs to add the credentials below.</p>
        )
      ) : null}
      <details className="ig-setup">
        <summary>What it can do, and why ({p.scopes.length} permissions)</summary>
        <ul className="ib-plain small">
          {p.scopes.map((s) => (
            <li key={s.scope}>
              <code>{s.scope}</code> {s.optional ? <span className="subtle">(optional)</span> : null} — {s.why}
            </li>
          ))}
        </ul>
      </details>
      <SetupInstructions p={p} open={!p.configured} />
    </section>
  );
}

function ResultBanner({ path }: { path: string[] }) {
  const ui = useUi();
  useEffect(() => {
    if (path[0] === "connected" && path[1]) {
      ui.toast({ kind: "success", title: "Connected", body: `Your ${path[1] === "gohighlevel" ? "GoHighLevel" : path[1] === "slack" ? "Slack" : "Gmail"} connection is ready. The first sync starts now.` });
      navigate(areaHash("integrations"));
    } else if (path[0] === "error" && path[1]) {
      ui.toast({ kind: "error", title: "Nothing was connected", body: RESULT_MESSAGES[path[1]] ?? "Something went wrong while connecting. Try again.", timeoutMs: 12_000 });
      navigate(areaHash("integrations"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path[0], path[1]]);
  return null;
}

function IntegrationsPage({ path }: AreaProps) {
  const ws = useWorkspace();
  const base = useBase();
  const providers = useApiResource((api, signal) => api.get<ProviderInfo[]>(`${base}/providers`, undefined, signal), [base]);
  const mock = providers.data?.some((p) => p.mock);
  const refused = providers.data?.some((p) => p.mock_refused);
  return (
    <div className="ws-area-scroll">
      <ResultBanner path={path} />
      <PageHeader title="Integrations" icon={Plug} subtitle="Bring email, Slack and HighLevel into one inbox. Everything synced is shown as external." />
      {mock ? (
        <p className="ib-mock-banner" role="note">
          <FlaskConical aria-hidden="true" />
          <strong>{MOCK_LABEL}</strong> Connections here use local fake providers with synthetic data. Nothing reaches Google, Slack or HighLevel.
        </p>
      ) : null}
      {refused ? (
        <p className="ib-mock-banner" role="note">
          Mock providers are switched on in the server settings but refused because this is a production environment.
        </p>
      ) : null}
      {providers.error ? <ErrorState error={providers.error} onRetry={providers.reload} /> : null}
      {providers.loading && !providers.data ? <LoadingState /> : null}
      {providers.data ? (
        providers.data.length ? (
          <div className="ig-grid">
            {providers.data.map((p) => (
              <ProviderCard key={p.id} p={p} onChanged={providers.reload} />
            ))}
          </div>
        ) : (
          <EmptyState icon={Plug} title="No integrations available" />
        )
      ) : null}
      {ws.workspace ? <p className="xsmall subtle ib-list-note">Connections belong to {ws.workspace.name}. Disconnecting deletes the stored tokens immediately.</p> : null}
    </div>
  );
}

function IntegrationsArea(props: AreaProps) {
  return (
    <ConnectionGate>
      <IntegrationsPage {...props} />
    </ConnectionGate>
  );
}

export const area = defineArea({
  id: "integrations",
  label: "Integrations",
  icon: Plug,
  order: 120,
  status: "ready",
  feature: "integrations",
  summary: "Connect Gmail, GoHighLevel and Slack to your workspace.",
  component: IntegrationsArea,
});
