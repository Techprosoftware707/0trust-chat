import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SyncState, type MatrixClient } from "matrix-js-sdk";
import {
  canAcceptVerificationRequest,
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  type VerificationRequest,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage.js";
import type { AppConfig } from "../config";
import { errorMessage } from "../lib/errors";
import { roomHash } from "../lib/matrix-id";
import type { Session } from "../lib/session-store";
import { MatrixContext, type MatrixContextValue } from "../matrix/context";
import { startDesktopNotifications } from "../matrix/notifications";
import { createDm, findDm, waitForRoom } from "../matrix/rooms";
import { setSecretStorageKeyPrompt } from "../matrix/secret-storage";
import { setUiaPrompt, type UiaPromptRequest } from "../matrix/uia";
import { useSecurityState } from "../hooks/security";
import { navigate, useRoute } from "../hooks/useRoute";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useRoomSummaries, useSyncState } from "../hooks/matrix";
import { UiContext, type DialogSpec, type Toast, type UiContextValue } from "./UiContext";
import { ConnectionBanner } from "./ConnectionBanner";
import { Sidebar } from "./Sidebar";
import { RoomView } from "./RoomView";
import { EmptyRoomPane } from "./EmptyRoomPane";
import { RoomInfoPanel } from "./RoomInfoPanel";
import { SearchPanel } from "./SearchPanel";
import { ToastRegion } from "./ToastRegion";
import { DialogHost } from "./DialogHost";
import { UiaDialog } from "./dialogs/UiaDialog";
import { SecretKeyPromptDialog } from "./dialogs/SecretKeyPromptDialog";
import { CallManager } from "./calls/CallManager";
import { CallHistoryPanel } from "./calls/CallHistoryPanel";
import { setCallPrefsUser } from "../calls/prefs";
import { useDesktopIntegration } from "../platform/desktop";
import { DesktopStorageNotice } from "../platform/DesktopNotice";
import { signOut } from "../matrix/client";
import { resetPrefs } from "../lib/prefs";
import { ErrorBoundary } from "./ErrorBoundary";

interface Props {
  config: AppConfig;
  client: MatrixClient;
  session: Session;
  onSignedOut: (notice: string) => void;
}

const PROMPT_DISMISSED_KEY = "lumen-security-prompt-dismissed";

export function ChatApp({ config, client, session, onSignedOut }: Props) {
  setCallPrefsUser(session.userId);
  const matrix = useMemo<MatrixContextValue>(
    () => ({ client, config, userId: session.userId, deviceId: session.deviceId }),
    [client, config, session.userId, session.deviceId],
  );
  const security = useSecurityState(client);
  const route = useRoute();
  const isMobile = useMediaQuery("(max-width: 759px)");
  const [dialogs, setDialogs] = useState<{ id: number; spec: DialogSpec }[]>([]);
  const dialogSeq = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [panel, setPanel] = useState<"info" | "search" | "calls" | null>(null);
  const [uiaReq, setUiaReq] = useState<{ req: UiaPromptRequest; resolve: (v: string | true | null) => void } | null>(null);
  const [keyReq, setKeyReq] = useState<{
    keyId: string;
    info: SecretStorageKeyDescription;
    resolve: (k: Uint8Array<ArrayBuffer> | null) => void;
  } | null>(null);
  const toastSeq = useRef(0);

  const openDialog = useCallback((d: DialogSpec) => setDialogs((ds) => [...ds, { id: ++dialogSeq.current, spec: d }]), []);
  const closeDialog = useCallback(() => setDialogs((ds) => ds.slice(0, -1)), []);
  const dismissToast = useCallback((id: string) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, "id"> & { id?: string }) => {
      const id = t.id ?? `t${++toastSeq.current}`;
      setToasts((ts) => [...ts.filter((x) => x.id !== id), { ...t, id }]);
      const timeout = t.timeoutMs === undefined ? (t.kind === "verification" ? null : 6000) : t.timeoutMs;
      if (timeout) setTimeout(() => dismissToast(id), timeout);
      return id;
    },
    [dismissToast],
  );
  const reportError = useCallback(
    (e: unknown, context: string) => toast({ kind: "error", title: context, body: errorMessage(e) }),
    [toast],
  );

  const verifyOwnDevice = useCallback(
    async (deviceId?: string) => {
      const crypto = client.getCrypto();
      if (!crypto) return;
      try {
        const request = deviceId
          ? await crypto.requestDeviceVerification(session.userId, deviceId)
          : await crypto.requestOwnUserVerification();
        openDialog({ type: "verification", request });
      } catch (e) {
        reportError(e, "Couldn't start verification");
      }
    },
    [client, session.userId, openDialog, reportError],
  );

  const verifyUser = useCallback(
    async (userId: string) => {
      if (userId === session.userId) return verifyOwnDevice();
      const crypto = client.getCrypto();
      if (!crypto) return;
      try {
        let roomId = findDm(client, userId)?.roomId;
        if (!roomId) {
          roomId = await createDm(client, userId);
          await waitForRoom(client, roomId);
        }
        const request = await crypto.requestVerificationDM(userId, roomId);
        openDialog({ type: "verification", request });
      } catch (e) {
        reportError(e, "Couldn't start verification");
      }
    },
    [client, session.userId, verifyOwnDevice, openDialog, reportError],
  );

  const ui = useMemo<UiContextValue>(
    () => ({
      openDialog,
      closeDialog,
      toast,
      dismissToast,
      reportError,
      security,
      verifyUser,
      verifyOwnDevice,
      openPanel: setPanel,
    }),
    [openDialog, closeDialog, toast, dismissToast, reportError, security, verifyUser, verifyOwnDevice],
  );

  // --- Bridges used by the SDK flows (UIA and secret-storage key prompts) ---
  useEffect(() => {
    setUiaPrompt((req) => new Promise((resolve) => setUiaReq({ req, resolve })));
    setSecretStorageKeyPrompt((keyId, info) => new Promise((resolve) => setKeyReq({ keyId, info, resolve })));
    return () => {
      setUiaPrompt(null);
      setSecretStorageKeyPrompt(null);
    };
  }, []);

  // --- Incoming verification requests ---
  useEffect(() => {
    const onRequest = (request: VerificationRequest) => {
      if (request.initiatedByMe || !canAcceptVerificationRequest(request)) return;
      const id = `verify-${request.transactionId ?? Math.random()}`;
      const who = request.isSelfVerification
        ? `Your other device${request.otherDeviceId ? ` (${request.otherDeviceId})` : ""}`
        : (client.getUser(request.otherUserId)?.displayName ?? request.otherUserId);
      const onChange = () => {
        if (request.phase === VerificationPhase.Cancelled || request.phase === VerificationPhase.Done) {
          dismissToast(id);
          request.off(VerificationRequestEvent.Change, onChange);
        }
      };
      request.on(VerificationRequestEvent.Change, onChange);
      toast({
        id,
        kind: "verification",
        title: request.isSelfVerification ? "Verify this device?" : "Verification request",
        body: request.isSelfVerification
          ? `${who} wants to verify this device so it can access your encrypted messages.`
          : `${who} wants to verify you by comparing emoji.`,
        timeoutMs: null,
        actions: [
          {
            label: "Verify",
            primary: true,
            onClick: () => {
              dismissToast(id);
              request
                .accept()
                .then(() => openDialog({ type: "verification", request }))
                .catch((e: unknown) => reportError(e, "Couldn't accept the verification request"));
            },
          },
          {
            label: "Decline",
            onClick: () => {
              dismissToast(id);
              void request.cancel().catch(() => undefined);
            },
          },
        ],
      });
    };
    client.on(CryptoEvent.VerificationRequestReceived, onRequest);
    return () => {
      client.off(CryptoEvent.VerificationRequestReceived, onRequest);
    };
  }, [client, toast, dismissToast, openDialog, reportError]);

  // --- Desktop notifications ---
  useEffect(() => startDesktopNotifications(client, config.brand.name), [client, config.brand.name]);

  // --- First-run security prompt (once per tab session, never forced) ---
  // Only decide after a live sync: start-up may show cached (possibly stale) account data.
  const prompted = useRef(false);
  const { state: syncState } = useSyncState(client);
  const [liveSynced, setLiveSynced] = useState(false);
  useEffect(() => {
    if (syncState === SyncState.Syncing && !liveSynced) {
      // give the security state a moment to re-read after the live sync
      const t = setTimeout(() => setLiveSynced(true), 600);
      return () => clearTimeout(t);
    }
  }, [syncState, liveSynced]);
  useEffect(() => {
    if (!liveSynced || security.loading || prompted.current) return;
    if (security.next !== "setup" && security.next !== "verify") return;
    prompted.current = true;
    try {
      if (sessionStorage.getItem(PROMPT_DISMISSED_KEY)) return;
    } catch {
      /* ignore */
    }
    openDialog(security.next === "setup" ? { type: "setup-recovery", mode: "setup" } : { type: "verify-device" });
  }, [liveSynced, security.loading, security.next, openDialog]);

  // --- Deep links (#/dm/@user:server) and invalid links ---
  useEffect(() => {
    if (route.kind === "dm") {
      if (route.userId === session.userId) {
        toast({ kind: "info", title: "That's you", body: "You can't start a conversation with yourself." });
        navigate("#/");
        return;
      }
      const existing = findDm(client, route.userId);
      if (existing) navigate(roomHash(existing.roomId));
      else openDialog({ type: "deeplink-dm", userId: route.userId });
    } else if (route.kind === "invalid") {
      toast({ kind: "error", title: "Couldn't open link", body: route.reason });
      navigate("#/");
    }
  }, [route, client, session.userId, openDialog, toast]);

  // --- Unread count in the tab title ---
  const summaries = useRoomSummaries(client);
  const unreadConversations = summaries.reduce((acc, s) => acc + (s.membership === "invite" ? 1 : s.unread > 0 ? 1 : 0), 0);
  useEffect(() => {
    const n = unreadConversations;
    document.title = n > 0 ? `(${n}) ${config.brand.name}` : config.brand.name;
  }, [unreadConversations, config.brand.name]);

  // --- Desktop app: badge, "Change server…" sign-out, call transports (no-op in a browser) ---
  const signOutForDesktop = useCallback(async () => {
    await signOut(client);
    resetPrefs();
  }, [client]);
  useDesktopIntegration(client, unreadConversations, signOutForDesktop);

  const roomId = route.kind === "room" ? route.roomId : null;
  useEffect(() => {
    setPanel((p) => ((p === "info" || p === "calls") && !roomId ? null : p));
  }, [roomId]);

  const view = roomId ? "room" : "list";

  return (
    <MatrixContext.Provider value={matrix}>
      <UiContext.Provider value={ui}>
        <a className="skip-link" href="#composer">
          Skip to message composer
        </a>
        <div
          className="app"
          data-view={view}
          data-panel={panel ?? "none"}
        >
          <ConnectionBanner />
          <DesktopStorageNotice />
          <div className="shell">
            <Sidebar summaries={summaries} activeRoomId={roomId} onSignOut={() => openDialog({ type: "sign-out" })} />
            <main className="room-pane" id="main">
              <ErrorBoundary compact key={roomId ?? "home"}>
                {roomId ? <RoomView key={roomId} roomId={roomId} isMobile={isMobile} panel={panel} /> : <EmptyRoomPane />}
              </ErrorBoundary>
            </main>
            {panel ? (
              <aside className="right-panel" aria-label={panel === "info" ? "Conversation details" : panel === "calls" ? "Call history" : "Search messages"}>
                {panel === "info" && roomId ? (
                  <RoomInfoPanel roomId={roomId} onClose={() => setPanel(null)} />
                ) : panel === "calls" && roomId ? (
                  <CallHistoryPanel roomId={roomId} onClose={() => setPanel(null)} />
                ) : panel === "search" ? (
                  <SearchPanel onClose={() => setPanel(null)} currentRoomId={roomId} />
                ) : null}
              </aside>
            ) : null}
          </div>
          {config.calls.enabled ? <CallManager /> : null}
          <ToastRegion toasts={toasts} onDismiss={dismissToast} />
        </div>
        <DialogHost
          dialogs={dialogs}
          onClose={closeDialog}
          onSignedOut={onSignedOut}
          onDismissFirstRun={() => {
            try {
              sessionStorage.setItem(PROMPT_DISMISSED_KEY, "1");
            } catch {
              /* ignore */
            }
          }}
        />
        {uiaReq ? (
          <UiaDialog
            request={uiaReq.req}
            onDone={(v) => {
              uiaReq.resolve(v);
              setUiaReq(null);
            }}
          />
        ) : null}
        {keyReq ? (
          <SecretKeyPromptDialog
            keyId={keyReq.keyId}
            info={keyReq.info}
            onDone={(k) => {
              keyReq.resolve(k);
              setKeyReq(null);
            }}
          />
        ) : null}
      </UiContext.Provider>
    </MatrixContext.Provider>
  );
}
