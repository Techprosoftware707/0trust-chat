import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, HttpApiEvent, type LoginResponse, type MatrixClient } from "matrix-js-sdk";
import { loadConfig, normaliseBaseUrl, type AppConfig } from "./config";
import { errorMessage } from "./lib/errors";
import { acquireTabLock } from "./lib/tab-lock";
import { hasStoredSession, loadSession, saveSession, SessionUnavailableError, type Session } from "./lib/session-store";
import {
  createMatrixClient,
  deleteLocalDatabases,
  reloadSignedOut,
  startSyncing,
  takeSignedOutNotice,
  wipeLocalData,
  type StartupStage,
} from "./matrix/client";
import { deviceDisplayName, extractLoginToken, loginWithToken, takePendingSsoHomeserver } from "./matrix/login";
import { BootScreen } from "./components/BootScreen";
import { LoginScreen } from "./components/LoginScreen";
import { ChatApp } from "./components/ChatApp";

type Phase =
  | { kind: "config" }
  | { kind: "config-error"; message: string }
  | { kind: "signing-in" }
  | { kind: "starting"; stage: StartupStage | "session" }
  | { kind: "login"; notice?: string; noticeKind?: "info" | "error" }
  | { kind: "ready"; client: MatrixClient; session: Session }
  | { kind: "fatal"; message: string; session: Session | null }
  | { kind: "other-tab" };

const STAGE_TEXT: Record<StartupStage | "session", string> = {
  session: "Unlocking your session…",
  store: "Opening your local data…",
  crypto: "Unlocking your encryption keys…",
  sync: "Syncing your conversations…",
};

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "config" });
  const booted = useRef(false);
  const clientRef = useRef<MatrixClient | null>(null);
  const configRef = useRef<AppConfig | null>(null);

  const handleLoggedOut = useCallback(async (notice: string) => {
    const client = clientRef.current;
    clientRef.current = null;
    await wipeLocalData(client);
    reloadSignedOut(notice);
  }, []);

  const start = useCallback(
    async (session: Session) => {
      setPhase({ kind: "starting", stage: "store" });
      let client: MatrixClient | null = null;
      try {
        client = await createMatrixClient(session, { voip: !!configRef.current?.voipEnabled }, (stage) =>
          setPhase({ kind: "starting", stage }),
        );
        clientRef.current = client;
        const thisClient = client;
        client.on(HttpApiEvent.SessionLoggedOut, () => {
          if (clientRef.current !== thisClient) return; // already signing out
          void handleLoggedOut("You've been signed out: this session was ended on the server.");
        });
        setPhase({ kind: "starting", stage: "sync" });
        await startSyncing(client);
        setPhase({ kind: "ready", client, session });
      } catch (e) {
        client?.stopClient();
        clientRef.current = null;
        if ((e as { errcode?: string })?.errcode === "M_UNKNOWN_TOKEN") {
          await wipeLocalData(client);
          reloadSignedOut("Your session has ended. Please sign in again.");
          return;
        }
        setPhase({ kind: "fatal", message: errorMessage(e, "The app couldn't start."), session });
      }
    },
    [handleLoggedOut],
  );

  const completeLogin = useCallback(
    async (homeserverUrl: string, res: LoginResponse) => {
      // Keep using the homeserver URL we actually signed in with (already discovered and
      // validated); `well_known` in the login response is deliberately not followed.
      const hs = normaliseBaseUrl(homeserverUrl);
      // A fresh login is a new device: remove anything left from an earlier session first.
      await wipeLocalData(null);
      const session = await saveSession({ userId: res.user_id, deviceId: res.device_id, homeserverUrl: hs }, res.access_token);
      await start(session);
    },
    [start],
  );

  const resume = useCallback(async () => {
    setPhase({ kind: "starting", stage: "session" });
    let session: Session | null;
    try {
      session = await loadSession();
    } catch (e) {
      await wipeLocalData(null);
      const msg = e instanceof SessionUnavailableError ? e.message : "Your saved session couldn't be opened.";
      setPhase({ kind: "login", notice: `${msg} Please sign in again.`, noticeKind: "info" });
      return;
    }
    if (!session) {
      setPhase({ kind: "login" });
      return;
    }
    await start(session);
  }, [start]);

  useEffect(() => {
    if (booted.current) return; // StrictMode / re-mount guard: the login token is single-use
    booted.current = true;
    void (async () => {
      let cfg: AppConfig;
      try {
        cfg = await loadConfig();
      } catch (e) {
        setPhase({ kind: "config-error", message: errorMessage(e) });
        return;
      }
      setConfig(cfg);
      configRef.current = cfg;
      document.title = cfg.brand.name;

      // Only one tab may run the client (shared encrypted crypto store).
      if (!(await acquireTabLock())) {
        setPhase({ kind: "other-tab" });
        return;
      }

      // Returning from SSO: remove the token from the address bar immediately.
      if (new URLSearchParams(window.location.search).has("loginToken")) {
        const { token, cleanedUrl } = extractLoginToken(window.location.href);
        window.history.replaceState(window.history.state, "", cleanedUrl);
        if (!token) {
          setPhase({ kind: "login", notice: "The sign-in response was incomplete. Please try again.", noticeKind: "error" });
          return;
        }
        setPhase({ kind: "signing-in" });
        const hs = takePendingSsoHomeserver() ?? cfg.homeserver.baseUrl;
        try {
          const res = await loginWithToken(hs, token, deviceDisplayName(cfg.brand.shortName));
          await completeLogin(hs, res);
        } catch (e) {
          setPhase({ kind: "login", notice: `Sign-in didn't complete: ${errorMessage(e)}`, noticeKind: "error" });
        }
        return;
      }
      if (hasStoredSession()) {
        await resume();
        return;
      }
      // No session: make sure nothing is left over from an earlier (possibly interrupted) sign-out.
      await deleteLocalDatabases();
      const notice = takeSignedOutNotice();
      setPhase(notice ? { kind: "login", notice, noticeKind: "info" } : { kind: "login" });
    })();
  }, [completeLogin, resume]);

  switch (phase.kind) {
    case "config":
      return <BootScreen config={null} status="Loading…" />;
    case "config-error":
      return (
        <BootScreen config={null} status={null} error={phase.message}>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </BootScreen>
      );
    case "other-tab":
      return (
        <BootScreen config={config} status={null} error={`${config?.brand.name ?? "This app"} is already open in another tab or window. Close it, then try again here.`}>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </BootScreen>
      );
    case "signing-in":
      return <BootScreen config={config} status="Signing you in…" />;
    case "starting":
      return <BootScreen config={config} status={STAGE_TEXT[phase.stage]} />;
    case "login":
      return <LoginScreen config={config!} notice={phase.notice} noticeKind={phase.noticeKind} onLoggedIn={completeLogin} />;
    case "fatal":
      return (
        <BootScreen config={config} status={null} error={phase.message}>
          <div className="cluster center-cluster">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Try again
            </button>
            <button
              type="button"
              className="btn btn-outline-danger"
              onClick={() => {
                const s = phase.session;
                // Best effort: end the session on the server too, so the access token stops working.
                const done = s
                  ? createClient({ baseUrl: s.homeserverUrl, accessToken: s.accessToken }).logout().catch(() => undefined)
                  : Promise.resolve();
                void done.then(() => handleLoggedOut("Local data cleared. Sign in again to continue."));
              }}
            >
              Clear local data and sign in again
            </button>
          </div>
          <p className="small muted">Clearing local data removes this device's encryption keys. Messages are only recoverable afterwards if you have a key backup or another verified device.</p>
        </BootScreen>
      );
    case "ready":
      return (
        <ChatApp
          config={config!}
          client={phase.client}
          session={phase.session}
          onSignedOut={(notice) => {
            clientRef.current = null;
            reloadSignedOut(notice);
          }}
        />
      );
  }
}
