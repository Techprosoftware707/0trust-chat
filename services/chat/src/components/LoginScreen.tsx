import { securityPageUrl } from "./settings/AboutTab";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { ArrowLeft, ExternalLink, Fingerprint, Info, KeyRound, LockKeyhole, LogIn, Server, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import type { LoginResponse } from "matrix-js-sdk";
import type { AppConfig } from "../config";
import { errorMessage } from "../lib/errors";
import {
  cancelDesktopSso,
  deviceDisplayName,
  discoverHomeserver,
  getLoginOptions,
  loginWithPassword,
  loginWithToken,
  startDesktopSso,
  startSso,
  type LoginOptions,
} from "../matrix/login";
import { BrandLogo } from "./BrandLogo";
import { Spinner } from "./primitives/Spinner";
import { ThemeToggle } from "./ThemeToggle";
import { DesktopStorageNotice } from "../platform/DesktopNotice";

interface Props {
  config: AppConfig;
  notice?: string;
  noticeKind?: "info" | "error";
  onLoggedIn: (homeserverUrl: string, res: LoginResponse) => Promise<void>;
}

function PasswordForm({ baseUrl, config, onLoggedIn }: { baseUrl: string; config: AppConfig; onLoggedIn: Props["onLoggedIn"] }) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await loginWithPassword(baseUrl, user.trim(), password, deviceDisplayName(config.brand.shortName));
      setPassword("");
      await onLoggedIn(baseUrl, res);
    } catch (err) {
      setError((err as { errcode?: string })?.errcode === "M_FORBIDDEN" ? "Incorrect username or password." : errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit} aria-describedby={error ? `${uid}-err` : undefined}>
      <div className="field">
        <label htmlFor={`${uid}-user`}>Username</label>
        <input
          id={`${uid}-user`}
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder="alice or @alice:example.org"
        />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-pw`}>Password</label>
        <input
          id={`${uid}-pw`}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error ? (
        <p id={`${uid}-err`} className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
        {busy ? <Spinner size="sm" /> : <LogIn aria-hidden="true" />} Sign in
      </button>
    </form>
  );
}

type BeginSso = (baseUrl: string, idpId: string | null) => void;

function OptionsView({ options, config, onLoggedIn, onSso }: { options: LoginOptions; config: AppConfig; onLoggedIn: Props["onLoggedIn"]; onSso: BeginSso }) {
  if (!options.password && options.sso.length === 0) {
    return (
      <div className="alert alert-warning" role="alert">
        <TriangleAlert aria-hidden="true" />
        <p>This server doesn't offer a sign-in method this app supports.</p>
      </div>
    );
  }
  return (
    <div className="stack">
      {options.sso.map((p) => (
        <button key={p.id ?? "sso"} type="button" className="btn btn-primary btn-block btn-lg" onClick={() => onSso(options.baseUrl, p.id)}>
          <Fingerprint aria-hidden="true" /> Continue with {p.name}
        </button>
      ))}
      {options.sso.length > 0 && options.password ? <div className="divider-text">or</div> : null}
      {options.password ? <PasswordForm baseUrl={options.baseUrl} config={config} onLoggedIn={onLoggedIn} /> : null}
    </div>
  );
}

export function LoginScreen({ config, notice, noticeKind = "info", onLoggedIn }: Props) {
  const [mode, setMode] = useState<"default" | "custom">("default");
  const [defaultOptions, setDefaultOptions] = useState<LoginOptions | null>(null);
  const [server, setServer] = useState("");
  const [custom, setCustom] = useState<LoginOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverId = useId();
  // Desktop app only: SSO runs in the system browser while this screen waits for the callback.
  const [ssoWaiting, setSsoWaiting] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);

  const beginSso = useCallback<BeginSso>(
    (baseUrl, idpId) => {
      const pending = startDesktopSso(baseUrl, idpId);
      if (!pending) {
        startSso(baseUrl, idpId);
        return;
      }
      setSsoWaiting(true);
      setSsoError(null);
      void (async () => {
        try {
          const token = await pending;
          const res = await loginWithToken(baseUrl, token, deviceDisplayName(config.brand.shortName));
          await onLoggedIn(baseUrl, res);
        } catch (e) {
          setSsoWaiting(false);
          const msg = errorMessage(e, "Sign-in didn't complete.");
          if (!/cancelled|newer sign-in/i.test(msg)) setSsoError(`Sign-in didn't complete: ${msg}`);
        }
      })();
    },
    [config.brand.shortName, onLoggedIn],
  );

  useEffect(() => {
    let alive = true;
    getLoginOptions(config.homeserver.baseUrl)
      .then((o) => alive && setDefaultOptions(o))
      .catch(() => undefined); // keep showing the configured SSO button
    return () => {
      alive = false;
    };
  }, [config.homeserver.baseUrl]);

  // Show the configured SSO button unless the server told us it doesn't offer that provider.
  const ssoAvailable =
    !!config.sso &&
    (defaultOptions === null || defaultOptions.sso.some((p) => p.id === config.sso!.idpId || p.id === null));

  const securityPage = securityPageUrl(config.portalUrl);

  const lookup = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCustom(null);
    try {
      const baseUrl = await discoverHomeserver(server);
      setCustom(await getLoginOptions(baseUrl));
    } catch (err) {
      setError(errorMessage(err, "Couldn't reach that server."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-layout">
      <aside className="auth-aside" aria-hidden="true">
        <div className="brand brand-inverse">
          <BrandLogo size={36} />
          <span>{config.brand.shortName}</span>
        </div>
        <div>
          <h2>Private conversations, protected on every device.</h2>
          <ul className="auth-points">
            <li>
              <LockKeyhole /> End-to-end encrypted by default
            </li>
            <li>
              <ShieldCheck /> Verify the people and devices you talk to
            </li>
            <li>
              <Users /> Built on Matrix, the open standard for secure chat
            </li>
          </ul>
        </div>
        <p className="auth-foot">Your keys never leave your devices unencrypted.</p>
      </aside>
      <main className="auth-main" id="main">
        <div className="auth-topbar">
          <ThemeToggle />
        </div>
        <div className="auth-panel">
          <div className="brand auth-mobile-brand">
            <BrandLogo size={36} />
            <span>{config.brand.shortName}</span>
          </div>
          {mode === "default" ? (
            <>
              <h1>Welcome back</h1>
              <p className="muted">Sign in to {config.brand.name} to continue to your conversations.</p>
              <p className="auth-matrix small">
                <span className="auth-new">New</span>
                <span>
                  Secure messaging built on Matrix, the open standard.
                  {securityPage ? (
                    <>
                      {" "}
                      <a href={securityPage} target="_blank" rel="noopener noreferrer">
                        Learn more
                      </a>
                    </>
                  ) : null}
                </span>
              </p>
              <DesktopStorageNotice />
              {notice ? (
                <div className={`alert ${noticeKind === "error" ? "alert-danger" : "alert-info"}`} role={noticeKind === "error" ? "alert" : "status"}>
                  {noticeKind === "error" ? <TriangleAlert aria-hidden="true" /> : <Info aria-hidden="true" />}
                  <p>{notice}</p>
                </div>
              ) : null}
              {ssoError ? (
                <div className="alert alert-danger" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <p>{ssoError}</p>
                </div>
              ) : null}
              {ssoWaiting ? (
                <div className="stack" role="status">
                  <div className="alert alert-info">
                    <ExternalLink aria-hidden="true" />
                    <p>Continue in your web browser. When you've signed in there, you'll come back here automatically.</p>
                  </div>
                  <button type="button" className="btn btn-ghost btn-block" onClick={() => cancelDesktopSso()}>
                    Cancel
                  </button>
                </div>
              ) : null}
              <div className="stack" hidden={ssoWaiting}>
                {ssoAvailable ? (
                  <button
                    type="button"
                    className="btn btn-gradient btn-block btn-lg"
                    onClick={() => beginSso(config.homeserver.baseUrl, config.sso!.idpId)}
                  >
                    <KeyRound aria-hidden="true" /> {config.sso!.label}
                  </button>
                ) : null}
                {defaultOptions?.password ? (
                  <>
                    {ssoAvailable ? <div className="divider-text">or</div> : null}
                    <PasswordForm baseUrl={config.homeserver.baseUrl} config={config} onLoggedIn={onLoggedIn} />
                  </>
                ) : null}
                {!ssoAvailable && defaultOptions && !defaultOptions.password ? (
                  <p className="muted small">This server doesn't offer a sign-in method this app supports.</p>
                ) : null}
                {config.allowCustomHomeserver ? (
                  <button type="button" className="btn btn-ghost btn-block" onClick={() => setMode("custom")}>
                    <Server aria-hidden="true" /> Sign in to another Matrix server
                  </button>
                ) : null}
              </div>
              {config.portalUrl ? (
                <p className="small muted auth-alt">
                  New here? <a href={config.portalUrl}>Create your {config.brand.shortName} account</a>
                </p>
              ) : null}
            </>
          ) : (
            <>
              <button type="button" className="btn btn-ghost btn-sm back-link" onClick={() => setMode("default")}>
                <ArrowLeft aria-hidden="true" /> Back
              </button>
              <h1>Another server</h1>
              <p className="muted">
                {config.brand.shortName} works with any Matrix homeserver. Enter the server name from your Matrix ID (the part after the
                colon) or the server's address.
              </p>
              <form className="form" onSubmit={lookup}>
                <div className="field">
                  <label htmlFor={serverId}>Server name or URL</label>
                  <input
                    id={serverId}
                    type="text"
                    inputMode="url"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    placeholder="example.org"
                    value={server}
                    onChange={(e) => {
                      setServer(e.target.value);
                      setCustom(null);
                    }}
                  />
                </div>
                {error ? (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                ) : null}
                <button type="submit" className="btn btn-block" disabled={busy}>
                  {busy ? <Spinner size="sm" /> : null} Continue
                </button>
              </form>
              {custom ? (
                <section className="custom-options" aria-label="Sign-in options">
                  <p className="small muted">
                    Signing in to <strong className="break">{custom.baseUrl}</strong>
                  </p>
                  <OptionsView options={custom} config={config} onLoggedIn={onLoggedIn} onSso={beginSso} />
                </section>
              ) : null}
            </>
          )}
          <footer className="auth-links small">
            {config.helpUrl ? <a href={config.helpUrl}>Help</a> : null}
            {config.privacyUrl ? <a href={config.privacyUrl}>Privacy</a> : null}
          </footer>
        </div>
      </main>
    </div>
  );
}
