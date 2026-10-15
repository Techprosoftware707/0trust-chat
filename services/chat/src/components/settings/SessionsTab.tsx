import { useCallback, useEffect, useState } from "react";
import type { IMyDevice } from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/index.js";
import { BadgeCheck, Check, LogOut, Monitor, Pencil, RefreshCw, ShieldAlert, X } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { withUia, UiaCancelledError } from "../../matrix/uia";
import { formatRelative } from "../../lib/format";
import { errorMessage } from "../../lib/errors";
import { Spinner } from "../primitives/Spinner";
import { useUi } from "../UiContext";

interface DeviceRow extends IMyDevice {
  verified: boolean | null;
  hasKeys: boolean;
}

export function SessionsTab() {
  const { client, userId, deviceId } = useMatrix();
  const ui = useUi();
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const crypto = client.getCrypto();
      const [{ devices: list }, keyMap] = await Promise.all([client.getDevices(), crypto ? crypto.getUserDeviceInfo([userId], true) : null]);
      const withKeys = keyMap?.get(userId);
      const rows = await Promise.all(
        list.map(async (d): Promise<DeviceRow> => {
          const st = crypto ? await crypto.getDeviceVerificationStatus(userId, d.device_id).catch(() => null) : null;
          return { ...d, verified: st ? st.crossSigningVerified : null, hasKeys: !!withKeys?.has(d.device_id) };
        }),
      );
      rows.sort((a, b) => (a.device_id === deviceId ? -1 : b.device_id === deviceId ? 1 : (b.last_seen_ts ?? 0) - (a.last_seen_ts ?? 0)));
      setDevices(rows);
    } catch (e) {
      setError(errorMessage(e, "Couldn't load your sessions."));
    }
  }, [client, userId, deviceId]);

  useEffect(() => {
    void load();
    const onDevices = (users: string[]) => users.includes(userId) && void load();
    client.on(CryptoEvent.DevicesUpdated, onDevices);
    client.on(CryptoEvent.UserTrustStatusChanged, onDevices as never);
    return () => {
      client.off(CryptoEvent.DevicesUpdated, onDevices);
      client.off(CryptoEvent.UserTrustStatusChanged, onDevices as never);
    };
  }, [client, userId, load]);

  const signOutSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    try {
      await withUia(client, `Sign out ${ids.length} session${ids.length === 1 ? "" : "s"}`, (auth) => client.deleteMultipleDevices(ids, auth ?? undefined));
      setSelected(new Set());
      await load();
    } catch (e) {
      if (!(e instanceof UiaCancelledError)) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section stack">
      <div className="cluster-between">
        <h3>Sessions</h3>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()} aria-label="Refresh sessions">
          <RefreshCw aria-hidden="true" /> Refresh
        </button>
      </div>
      <p className="small muted">Every browser or app where you're signed in. Sign out of any you don't recognise, and verify the ones you use.</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {!devices ? (
        <Spinner size="sm" label="Loading sessions…" />
      ) : (
        <ul className="list-plain device-list">
          {devices.map((d) => {
            const current = d.device_id === deviceId;
            return (
              <li key={d.device_id} className={`device${current ? " current" : ""}`}>
                {!current ? (
                  <input
                    type="checkbox"
                    className="device-check"
                    aria-label={`Select ${d.display_name || d.device_id}`}
                    checked={selected.has(d.device_id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(d.device_id);
                      else next.delete(d.device_id);
                      setSelected(next);
                    }}
                  />
                ) : (
                  <span className="device-check" />
                )}
                <Monitor aria-hidden="true" className="device-icon" />
                <div className="device-main">
                  {editing === d.device_id ? (
                    <form
                      className="input-row"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        try {
                          await client.setDeviceDetails(d.device_id, { display_name: newName.trim() });
                          setEditing(null);
                          await load();
                        } catch (err) {
                          setError(errorMessage(err));
                        }
                      }}
                    >
                      <label className="visually-hidden" htmlFor={`rename-${d.device_id}`}>
                        Session name
                      </label>
                      <input id={`rename-${d.device_id}`} type="text" value={newName} maxLength={100} onChange={(e) => setNewName(e.target.value)} autoFocus />
                      <button type="submit" className="icon-btn" aria-label="Save name">
                        <Check aria-hidden="true" />
                      </button>
                      <button type="button" className="icon-btn" aria-label="Cancel rename" onClick={() => setEditing(null)}>
                        <X aria-hidden="true" />
                      </button>
                    </form>
                  ) : (
                    <span className="device-name">
                      {d.display_name || "Unnamed session"}
                      {current ? <span className="badge badge-accent badge-plain">This device</span> : null}
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        aria-label={`Rename ${d.display_name || d.device_id}`}
                        onClick={() => {
                          setEditing(d.device_id);
                          setNewName(d.display_name ?? "");
                        }}
                      >
                        <Pencil aria-hidden="true" />
                      </button>
                    </span>
                  )}
                  <span className="device-meta small muted">
                    <span className="mono">{d.device_id}</span> · Last active {formatRelative(d.last_seen_ts)}
                    {d.last_seen_ip ? ` · ${d.last_seen_ip}` : ""}
                  </span>
                  <span className="device-trust small">
                    {!d.hasKeys ? (
                      <span className="muted">No encryption keys (not an encrypting app)</span>
                    ) : d.verified ? (
                      <span className="ok">
                        <BadgeCheck aria-hidden="true" /> Verified
                      </span>
                    ) : (
                      <span className="warn">
                        <ShieldAlert aria-hidden="true" /> Not verified
                      </span>
                    )}
                  </span>
                </div>
                {!current && d.hasKeys && !d.verified ? (
                  <button type="button" className="btn btn-sm" onClick={() => void ui.verifyOwnDevice(d.device_id)}>
                    Verify
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {devices && devices.length > 1 ? (
        <div className="cluster">
          <button type="button" className="btn btn-sm btn-outline-danger" disabled={busy || selected.size === 0} onClick={signOutSelected}>
            {busy ? <Spinner size="sm" /> : <LogOut aria-hidden="true" />} Sign out {selected.size > 0 ? selected.size : ""} selected
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setSelected(new Set(devices.filter((d) => d.device_id !== deviceId).map((d) => d.device_id)))}
          >
            Select all other sessions
          </button>
        </div>
      ) : null}
    </div>
  );
}
