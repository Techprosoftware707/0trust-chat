/**
 * One MatrixRTC call in one room: Matrix membership + media keys (matrix-js-sdk) and media
 * (LiveKit SFU, end-to-end encrypted frames). Framework-free; the UI subscribes to snapshots.
 *
 * Everything the UI shows comes from here and is derived from real state: LiveKit connection
 * and track state, Matrix call memberships, received media keys, LiveKit's encryption error
 * events and RTCPeerConnection getStats(). There is no simulated state.
 */
import {
  ConnectionQuality,
  ConnectionState,
  createLocalAudioTrack,
  createLocalVideoTrack,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  type LocalTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room as LkRoom,
  RoomEvent,
  setLogLevel,
  Track,
  TrackEvent,
  type VideoCodec,
} from "livekit-client";
import E2EEWorker from "livekit-client/e2ee-worker?worker";
import { KnownMembership, RoomEvent as MxRoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { MatrixRTCSessionEvent, MembershipManagerEvent, type CallMembership, type MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/index.js";
import type { CallMembershipIdentityParts } from "matrix-js-sdk/lib/matrixrtc/EncryptionManager.js";
import type { AppConfig } from "../config";
import { errorMessage } from "../lib/errors";
import { MatrixMediaKeyProvider } from "./keys";
import {
  audioCaptureOptions,
  audioPublishOptions,
  chooseVideoCodec,
  describeMediaError,
  publishDefaults,
  resolveVideoProfile,
  SCREEN_SHARE_ENCODING,
  VIDEO_PROFILES,
  videoCaptureOptions,
  type CodecReport,
  type VideoProfile,
} from "./media";
import { getCallPrefs, type CallPrefs } from "./prefs";
import {
  CallSetupError,
  discoverOwnTransport,
  getSfuToken,
  memberIdFor,
  RING_LIFETIME_MS,
  roomSession,
  RTC_DECLINE_EVENT,
  selectFocus,
  type LivekitFocus,
} from "./rtc";
import {
  classifyNetwork,
  overallNetwork,
  reportToArray,
  summariseStream,
  transportInfo,
  type QualityVerdict,
  type StatRecord,
  type StreamSummary,
  type TransportInfo,
} from "./stats";

setLogLevel(import.meta.env.DEV ? "info" : "warn");

export type CallIntent = "audio" | "video";
export type CallPhase = "starting" | "connecting" | "connected" | "reconnecting" | "ended";

/**
 * Per-participant media encryption, as far as this device can tell:
 *  encrypted        — their tracks are published encrypted, we hold their key and nothing failed to decrypt
 *  waiting-for-key  — we haven't received their key over Matrix (yet)
 *  decrypt-error    — LiveKit reported decryption failures, or video arrives but no frame decodes
 *  not-encrypted    — they publish unencrypted media
 *  unknown          — connected to the media server without a Matrix call membership
 */
export type EncryptionStatus = "encrypted" | "waiting-for-key" | "decrypt-error" | "not-encrypted" | "unknown";

export interface CallParticipant {
  identity: string;
  userId: string | null;
  deviceId: string | null;
  name: string;
  isLocal: boolean;
  /** joined the Matrix call but not (yet) connected to the media server */
  pending: boolean;
  micTrack: Track | null;
  micMuted: boolean;
  cameraTrack: Track | null;
  cameraMuted: boolean;
  screenTrack: Track | null;
  screenAudioTrack: Track | null;
  speaking: boolean;
  quality: ConnectionQuality;
  encryption: EncryptionStatus;
  /** latest media key index received for this participant (keys rotate when members leave) */
  keyIndex: number | null;
  /** still no key KEY_WAIT_WARN_MS after they appeared: something is wrong, not just slow */
  keyOverdue: boolean;
}

export interface CallStatsSnapshot {
  at: number;
  local: { audio: StreamSummary | null; video: StreamSummary | null; screen: StreamSummary | null };
  remote: Record<string, { audio: StreamSummary | null; video: StreamSummary | null; screen: StreamSummary | null }>;
  transport: TransportInfo | null;
  network: { rttMs: number | null; lossPct: number | null; jitterMs: number | null };
  verdict: QualityVerdict;
}

export type DeviceState = "on" | "muted" | "off" | "unavailable" | "starting";

export interface CallSnapshot {
  roomId: string;
  intent: CallIntent;
  isDm: boolean;
  phase: CallPhase;
  connectedAt: number | null;
  error: string | null;
  endReason: string | null;
  notice: string | null;
  ringing: boolean;
  focusUrl: string | null;
  localIdentity: string | null;
  participants: CallParticipant[];
  mic: { state: DeviceState; error: string | null; label: string | null };
  camera: { state: DeviceState; error: string | null; label: string | null };
  screen: { active: boolean; error: string | null; hasAudio: boolean };
  speakerDeviceId: string | null;
  audioPlaybackBlocked: boolean;
  e2ee: {
    enabled: boolean;
    ownKey: boolean;
    ownKeyIndex: number | null;
    remoteTotal: number;
    remoteEncrypted: number;
    /** waiting for a key, but not for long (normal right after someone joins) */
    remoteWaiting: number;
    unknownConnections: number;
  };
  events: { ts: number; text: string }[];
  reconnects: number;
  stats: CallStatsSnapshot | null;
  codec: CodecReport | null;
  videoProfile: string | null;
  audioMode: CallPrefs["audioMode"];
}

export interface StartOptions {
  intent: CallIntent;
  /** tracks already captured in the lobby (reused, not captured again) */
  audioTrack?: LocalAudioTrack | null;
  videoTrack?: LocalVideoTrack | null;
  /** ring (DM) / notify (group) the other members if we start the call */
  notify: boolean;
}

const DECRYPT_ERROR_WINDOW_MS = 8_000;
/** Keys normally arrive within a few seconds (membership → to-device message → sync). */
const KEY_WAIT_WARN_MS = 15_000;
const STATS_INTERVAL_MS = 2_000;
const MAX_REJOIN_ATTEMPTS = 6;

export class CallSession {
  readonly roomId: string;
  private readonly rtc: MatrixRTCSession;
  private readonly keys = new MatrixMediaKeyProvider();
  private lk: LkRoom | null = null;
  private snapshot: CallSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: (() => void)[] = [];
  private audioTrack: LocalAudioTrack | null = null;
  private videoTrack: LocalVideoTrack | null = null;
  private focus: LivekitFocus | null = null;
  private memberId: string;
  private identityToMembership = new Map<string, CallMembership>();
  private decryptErrors = new Map<string, number>();
  private noDecodeStreak = new Map<string, number>();
  private firstSeen = new Map<string, number>();
  private keyWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private prevReports = new Map<string, StatRecord[]>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private notificationId: string | null = null;
  private leaving = false;
  private rejoining = false;
  private updateQueued = false;
  private codec: VideoCodec = "vp8";
  private profile: VideoProfile = VIDEO_PROFILES.hd;

  constructor(
    private readonly client: MatrixClient,
    private readonly config: AppConfig,
    private readonly room: Room,
    private readonly opts: StartOptions,
  ) {
    this.roomId = room.roomId;
    this.rtc = roomSession(client, room);
    this.memberId = memberIdFor(client.getUserId()!, client.getDeviceId()!);
    const members = room.getJoinedMembers();
    this.snapshot = {
      roomId: room.roomId,
      intent: opts.intent,
      isDm: members.length === 2,
      phase: "starting",
      connectedAt: null,
      error: null,
      endReason: null,
      notice: null,
      ringing: false,
      focusUrl: null,
      localIdentity: null,
      participants: [],
      mic: { state: "starting", error: null, label: null },
      camera: { state: opts.intent === "video" ? "starting" : "off", error: null, label: null },
      screen: { active: false, error: null, hasAudio: false },
      speakerDeviceId: getCallPrefs().speakerDeviceId,
      audioPlaybackBlocked: false,
      e2ee: { enabled: false, ownKey: false, ownKeyIndex: null, remoteTotal: 0, remoteEncrypted: 0, remoteWaiting: 0, unknownConnections: 0 },
      events: [],
      reconnects: 0,
      stats: null,
      codec: null,
      videoProfile: null,
      audioMode: getCallPrefs().audioMode,
    };
  }

  // ---- subscription ----------------------------------------------------------------------

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): CallSnapshot => this.snapshot;

  private set(patch: Partial<CallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  private log(text: string): void {
    const events = [...this.snapshot.events, { ts: Date.now(), text }].slice(-40);
    this.set({ events });
  }

  /** Coalesces bursts of LiveKit/Matrix events into one participant rebuild. */
  private scheduleUpdate = (): void => {
    if (this.updateQueued) return;
    this.updateQueued = true;
    queueMicrotask(() => {
      this.updateQueued = false;
      this.rebuild();
    });
  };

  get liveKitRoom(): LkRoom | null {
    return this.lk;
  }

  get localAudioTrack(): LocalAudioTrack | null {
    return this.audioTrack;
  }

  get localVideoTrack(): LocalVideoTrack | null {
    return this.videoTrack;
  }

  // ---- start -----------------------------------------------------------------------------

  async start(): Promise<void> {
    try {
      if (this.room.getMyMembership() !== KnownMembership.Join) throw new CallSetupError("not-joined", "You're not a member of this conversation.");
      this.watchMatrix();
      const prefs = getCallPrefs();
      await this.prepareTracks(prefs);
      const codecReport = await chooseVideoCodec().catch(() => null);
      this.codec = codecReport?.chosen ?? "vp8";
      this.set({ codec: codecReport, phase: "connecting" });

      await this.rtc.initialMembershipCalculated.catch(() => undefined);
      const own = await discoverOwnTransport(this.client, this.config);
      const { focus } = selectFocus(this.rtc.memberships, own);
      this.focus = focus;
      this.set({ focusUrl: focus.url });
      this.log(`Media server: ${new URL(focus.url).host}`);

      await this.connectMedia(prefs);
      this.joinMatrix();
      await this.publishInitialTracks(prefs);
      this.startStats();
      this.set({ phase: "connected", connectedAt: Date.now() });
      this.log("Connected");
    } catch (e) {
      const msg = e instanceof CallSetupError ? e.message : errorMessage(e, "The call couldn't be started.");
      await this.teardown(msg, true);
    }
  }

  /** Captures microphone (and camera for video calls) unless the lobby already did. */
  private async prepareTracks(prefs: CallPrefs): Promise<void> {
    if (this.opts.audioTrack && this.opts.audioTrack.mediaStreamTrack.readyState === "live") {
      this.audioTrack = this.opts.audioTrack;
    } else {
      try {
        this.audioTrack = await createLocalAudioTrack(audioCaptureOptions(prefs));
      } catch (e) {
        this.audioTrack = null;
        this.set({ mic: { state: "unavailable", error: describeMediaError(e, "microphone"), label: null } });
      }
    }
    if (this.opts.intent === "video") {
      this.profile = resolveVideoProfile(prefs.videoQuality);
      if (this.opts.videoTrack && this.opts.videoTrack.mediaStreamTrack.readyState === "live") {
        this.videoTrack = this.opts.videoTrack;
      } else {
        try {
          this.videoTrack = await createLocalVideoTrack(videoCaptureOptions(this.profile, prefs.cameraDeviceId));
        } catch (e) {
          this.videoTrack = null;
          this.set({ camera: { state: "unavailable", error: describeMediaError(e, "camera"), label: null } });
        }
      }
      if (this.videoTrack) this.profile = this.profileForTrack(this.videoTrack, prefs);
    }
    for (const t of [this.audioTrack, this.videoTrack]) if (t) this.watchLocalTrack(t);
  }

  /** "Auto"/"Highest" are bounded by what the camera actually delivers. */
  private profileForTrack(track: LocalVideoTrack, prefs: CallPrefs): VideoProfile {
    const h = track.mediaStreamTrack.getSettings().height ?? 0;
    const wanted = resolveVideoProfile(prefs.videoQuality);
    if (wanted.quality === "highest" && h > 0 && h < 1000) return VIDEO_PROFILES.hd;
    if (wanted.quality === "hd" && h > 0 && h < 700) return VIDEO_PROFILES.standard;
    return wanted;
  }

  private async connectMedia(prefs: CallPrefs): Promise<void> {
    const token = await getSfuToken(this.client, this.focus!, this.roomId, this.memberId);
    const lk = new LkRoom({
      adaptiveStream: true,
      dynacast: true,
      encryption: { keyProvider: this.keys, worker: new E2EEWorker() },
      publishDefaults: publishDefaults(prefs, this.profile, this.codec),
      audioCaptureDefaults: audioCaptureOptions(prefs),
      videoCaptureDefaults: videoCaptureOptions(this.profile, prefs.cameraDeviceId),
      audioOutput: prefs.speakerDeviceId ? { deviceId: prefs.speakerDeviceId } : undefined,
      stopLocalTrackOnUnpublish: false,
      disconnectOnPageLeave: true,
      webAudioMix: false,
    });
    this.lk = lk;
    this.wireLiveKit(lk);
    await lk.setE2EEEnabled(true);
    try {
      await lk.connect(this.focus!.url, token.jwt, { autoSubscribe: true });
    } catch (e) {
      throw new CallSetupError("network", `Couldn't connect to the media server (${errorMessage(e)}). Check your network: calls need UDP or TCP/TLS access to ${new URL(this.focus!.url).host}.`);
    }
    this.set({ localIdentity: lk.localParticipant.identity, e2ee: { ...this.snapshot.e2ee, enabled: lk.isE2EEEnabled } });
    if (lk.localParticipant.identity !== token.identity) this.log("Warning: the media server assigned an unexpected identity");
    if (prefs.speakerDeviceId) await lk.switchActiveDevice("audiooutput", prefs.speakerDeviceId).catch(() => undefined);
  }

  private joinMatrix(): void {
    const own: CallMembershipIdentityParts = { userId: this.client.getUserId()!, deviceId: this.client.getDeviceId()!, memberId: this.memberId };
    const notify = this.opts.notify && this.rtc.memberships.length === 0;
    this.rtc.join(own, [{ type: "livekit", url: this.focus!.url }], {
      manageMediaKeys: true,
      callIntent: this.opts.intent,
      notificationType: notify ? (this.snapshot.isDm ? "ring" : "notification") : undefined,
      notificationLifetimeMs: RING_LIFETIME_MS,
      // keep-alive of the delayed leave event: if this tab vanishes, the homeserver ends our
      // membership after 18 s
      delayedLeaveEventDelayMs: 18_000,
      delayedLeaveEventRestartMs: 4_000,
      networkErrorRetryMs: 2_000,
      maximumNetworkErrorRetryCount: 30,
    });
    if (notify && this.snapshot.isDm) {
      this.set({ ringing: true });
      this.ringTimer = setTimeout(() => {
        if (this.snapshot.ringing && !this.hasRemoteMembers()) void this.leave("No answer");
      }, RING_LIFETIME_MS);
    }
  }

  private async publishInitialTracks(prefs: CallPrefs): Promise<void> {
    const lp = this.lk!.localParticipant;
    if (this.audioTrack) {
      const ch = this.audioTrack.mediaStreamTrack.getSettings().channelCount;
      await lp.publishTrack(this.audioTrack, { source: Track.Source.Microphone, ...audioPublishOptions(prefs, ch) });
    }
    if (this.videoTrack) {
      await lp.publishTrack(this.videoTrack, {
        source: Track.Source.Camera,
        simulcast: true,
        videoCodec: this.codec,
        videoEncoding: this.profile.encoding,
        videoSimulcastLayers: this.profile.layers,
      });
    }
    this.set({ videoProfile: this.videoTrack ? this.profile.label : null });
    this.refreshDeviceState();
  }

  // ---- Matrix side -----------------------------------------------------------------------

  private watchMatrix(): void {
    const onKey = (key: Uint8Array<ArrayBuffer>, index: number, _m: CallMembershipIdentityParts, identity: string) => {
      void this.keys.setMatrixKey(key, index, identity).then(this.scheduleUpdate);
    };
    const onMemberships = () => {
      this.identityToMembership = new Map();
      for (const m of this.rtc.memberships) for (const id of m.backendIdentities) this.identityToMembership.set(id, m);
      if (this.snapshot.ringing && this.hasRemoteMembers()) {
        this.set({ ringing: false });
        if (this.ringTimer) clearTimeout(this.ringTimer);
      }
      this.scheduleUpdate();
    };
    const onManagerError = (e: unknown) => {
      this.log(`Call membership error: ${errorMessage(e)}`);
      this.set({ notice: "Your server stopped confirming that you're in this call. Others may not see you until the connection recovers." });
    };
    const onProbablyLeft = (left: boolean) => {
      if (left) this.log("Server connection lost: the call membership may expire");
      else this.log("Call membership confirmed again");
    };
    const onNotify = (n: { event_id: string }) => {
      this.notificationId = n.event_id;
    };
    this.rtc.on(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey);
    this.rtc.on(MatrixRTCSessionEvent.MembershipsChanged, onMemberships);
    this.rtc.on(MatrixRTCSessionEvent.MembershipManagerError, onManagerError);
    this.rtc.on(MatrixRTCSessionEvent.DidSendCallNotification, onNotify);
    this.rtc.on(MembershipManagerEvent.ProbablyLeft, onProbablyLeft);
    onMemberships();

    // Leaving or being removed from the room ends the call.
    const onMyMembership = (room: Room, membership: string) => {
      if (room.roomId !== this.roomId || membership === KnownMembership.Join) return;
      void this.leave(membership === KnownMembership.Ban ? "You were removed from this conversation" : "You're no longer in this conversation");
    };
    // A 1:1 callee declining our ring ends the attempt.
    const onTimeline = (ev: MatrixEvent, room: Room | undefined) => {
      if (room?.roomId !== this.roomId || !this.notificationId) return;
      void this.client.decryptEventIfNeeded(ev).then(() => {
        if (ev.getType() !== RTC_DECLINE_EVENT || ev.getRelation()?.event_id !== this.notificationId) return;
        if (ev.getSender() === this.client.getUserId()) return;
        if (this.snapshot.isDm && !this.hasRemoteMembers()) {
          const who = this.room.getMember(ev.getSender() ?? "")?.name ?? ev.getSender();
          void this.leave(`${who} declined the call`);
        }
      });
    };
    this.client.on(MxRoomEvent.MyMembership, onMyMembership);
    this.client.on(MxRoomEvent.Timeline, onTimeline);

    const onOnline = () => this.log("Network: back online");
    const onOffline = () => this.log("Network: offline");
    const conn = (navigator as Navigator & { connection?: EventTarget & { effectiveType?: string } }).connection;
    const onConnChange = () => this.log(`Network changed${conn?.effectiveType ? ` (${conn.effectiveType})` : ""}`);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    conn?.addEventListener?.("change", onConnChange);
    const onPageHide = () => void this.leave("Page closed");
    window.addEventListener("pagehide", onPageHide);

    this.cleanups.push(() => {
      this.rtc.off(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey);
      this.rtc.off(MatrixRTCSessionEvent.MembershipsChanged, onMemberships);
      this.rtc.off(MatrixRTCSessionEvent.MembershipManagerError, onManagerError);
      this.rtc.off(MatrixRTCSessionEvent.DidSendCallNotification, onNotify);
      this.rtc.off(MembershipManagerEvent.ProbablyLeft, onProbablyLeft);
      this.client.off(MxRoomEvent.MyMembership, onMyMembership);
      this.client.off(MxRoomEvent.Timeline, onTimeline);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      conn?.removeEventListener?.("change", onConnChange);
      window.removeEventListener("pagehide", onPageHide);
    });
    const unKeys = this.keys.onChange(this.scheduleUpdate);
    this.cleanups.push(unKeys);
  }

  private hasRemoteMembers(): boolean {
    const me = this.client.getUserId();
    return this.rtc.memberships.some((m) => m.userId !== me);
  }

  // ---- LiveKit side ----------------------------------------------------------------------

  private wireLiveKit(lk: LkRoom): void {
    const u = this.scheduleUpdate;
    lk.on(RoomEvent.ParticipantConnected, (p) => {
      this.log(`${this.nameFor(p)} connected`);
      u();
    })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        this.log(`${this.nameFor(p)} left`);
        this.decryptErrors.delete(p.identity);
        u();
      })
      .on(RoomEvent.TrackSubscribed, u)
      .on(RoomEvent.TrackUnsubscribed, u)
      .on(RoomEvent.TrackPublished, u)
      .on(RoomEvent.TrackUnpublished, u)
      .on(RoomEvent.TrackMuted, u)
      .on(RoomEvent.TrackUnmuted, u)
      .on(RoomEvent.LocalTrackPublished, u)
      .on(RoomEvent.LocalTrackUnpublished, u)
      .on(RoomEvent.ActiveSpeakersChanged, u)
      .on(RoomEvent.ConnectionQualityChanged, u)
      .on(RoomEvent.ParticipantEncryptionStatusChanged, u)
      .on(RoomEvent.TrackSubscriptionFailed, (_sid, p) => {
        this.log(`Couldn't receive media from ${p ? this.nameFor(p) : "a participant"}`);
        u();
      })
      .on(RoomEvent.EncryptionError, (err, participant) => {
        const id = participant?.identity ?? (err as { participantIdentity?: string }).participantIdentity;
        if (id) this.decryptErrors.set(id, Date.now());
        u();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.set({ audioPlaybackBlocked: !lk.canPlaybackAudio }))
      .on(RoomEvent.Reconnecting, () => {
        this.log("Media connection interrupted — reconnecting");
        this.set({ phase: "reconnecting", reconnects: this.snapshot.reconnects + 1 });
      })
      .on(RoomEvent.SignalReconnecting, () => {
        this.log("Signalling connection interrupted — reconnecting");
        if (this.snapshot.phase === "connected") this.set({ phase: "reconnecting", reconnects: this.snapshot.reconnects + 1 });
      })
      .on(RoomEvent.Reconnected, () => {
        this.log("Reconnected");
        this.set({ phase: "connected" });
      })
      .on(RoomEvent.MediaDevicesChanged, () => void this.onDevicesChanged())
      .on(RoomEvent.MediaDevicesError, (e) => this.set({ notice: describeMediaError(e, "microphone") }))
      .on(RoomEvent.Disconnected, (reason) => void this.onDisconnected(reason));
  }

  private async onDisconnected(reason?: DisconnectReason): Promise<void> {
    if (this.leaving) return;
    const final = new Set([DisconnectReason.CLIENT_INITIATED, DisconnectReason.DUPLICATE_IDENTITY, DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason.ROOM_DELETED]);
    if (reason !== undefined && final.has(reason)) {
      const text =
        reason === DisconnectReason.DUPLICATE_IDENTITY
          ? "You joined this call from another tab or window."
          : reason === DisconnectReason.PARTICIPANT_REMOVED
            ? "You were removed from the call."
            : reason === DisconnectReason.ROOM_DELETED
              ? "The call was closed by the server."
              : "Disconnected.";
      await this.teardown(text, reason !== DisconnectReason.CLIENT_INITIATED);
      return;
    }
    // Anything else (network loss beyond LiveKit's own resume/ICE restart, token expiry,
    // server restart): rejoin with a fresh token.
    await this.rejoin(`Connection lost (${reason !== undefined ? DisconnectReason[reason] : "unknown"})`);
  }

  private async rejoin(why: string): Promise<void> {
    if (this.rejoining || this.leaving) return;
    this.rejoining = true;
    this.log(`${why} — reconnecting`);
    this.set({ phase: "reconnecting", reconnects: this.snapshot.reconnects + 1 });
    const prefs = getCallPrefs();
    for (let attempt = 1; attempt <= MAX_REJOIN_ATTEMPTS && !this.leaving; attempt++) {
      try {
        const old = this.lk;
        this.lk = null;
        old?.removeAllListeners();
        await old?.disconnect(false).catch(() => undefined);
        await this.connectMedia(prefs);
        const lp = this.lk!.localParticipant;
        if (this.audioTrack) await lp.publishTrack(this.audioTrack, { source: Track.Source.Microphone, ...audioPublishOptions(prefs, this.audioTrack.mediaStreamTrack.getSettings().channelCount) });
        if (this.videoTrack && !this.videoTrack.isMuted) {
          await lp.publishTrack(this.videoTrack, { source: Track.Source.Camera, simulcast: true, videoCodec: this.codec, videoEncoding: this.profile.encoding, videoSimulcastLayers: this.profile.layers });
        }
        // the membership manager keeps (or re-sends) our membership; make sure we still have one
        if (!this.rtc.isJoined()) this.joinMatrix();
        this.rtc.reemitEncryptionKeys();
        this.set({ phase: "connected" });
        this.log("Reconnected");
        this.rejoining = false;
        this.refreshDeviceState();
        return;
      } catch (e) {
        this.log(`Reconnect attempt ${attempt} failed: ${errorMessage(e)}`);
        await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** (attempt - 1), 15_000)));
      }
    }
    this.rejoining = false;
    if (!this.leaving) await this.teardown("Lost the connection to the call and couldn't reconnect.", true);
  }

  private nameFor(p: Participant): string {
    const m = this.identityToMembership.get(p.identity);
    if (!m) return "Unknown participant";
    return this.room.getMember(m.userId)?.name ?? m.userId;
  }

  // ---- participant model -----------------------------------------------------------------

  private keyOverdue(identity: string): boolean {
    if (this.keys.hasKeyFor(identity)) return false;
    const t = this.firstSeen.get(identity);
    return t !== undefined && Date.now() - t > KEY_WAIT_WARN_MS;
  }

  private encryptionOf(p: RemoteParticipant): EncryptionStatus {
    if (!this.identityToMembership.has(p.identity)) return "unknown";
    const pubs = [...p.trackPublications.values()];
    if (pubs.some((pub) => !pub.isEncrypted)) return "not-encrypted";
    if (!this.keys.hasKeyFor(p.identity)) return "waiting-for-key";
    const lastErr = this.decryptErrors.get(p.identity);
    if (lastErr && Date.now() - lastErr < DECRYPT_ERROR_WINDOW_MS) return "decrypt-error";
    if ((this.noDecodeStreak.get(p.identity) ?? 0) >= 3) return "decrypt-error";
    return "encrypted";
  }

  private rebuild(): void {
    const lk = this.lk;
    const me = this.client.getUserId();
    const participants: CallParticipant[] = [];
    const seen = new Set<string>();
    const memberName = (userId: string | null) => (userId ? (this.room.getMember(userId)?.name ?? userId) : "Unknown participant");
    if (lk && lk.state !== ConnectionState.Disconnected) {
      const lp = lk.localParticipant;
      seen.add(lp.identity);
      const mic = lp.getTrackPublication(Track.Source.Microphone);
      const cam = lp.getTrackPublication(Track.Source.Camera);
      const scr = lp.getTrackPublication(Track.Source.ScreenShare);
      participants.push({
        identity: lp.identity,
        userId: me,
        deviceId: this.client.getDeviceId(),
        name: memberName(me),
        isLocal: true,
        pending: false,
        micTrack: mic?.track ?? null,
        micMuted: !mic?.track || mic.isMuted,
        cameraTrack: cam?.track && !cam.isMuted ? cam.track : null,
        cameraMuted: !cam?.track || cam.isMuted,
        screenTrack: scr?.track ?? null,
        screenAudioTrack: null,
        speaking: lp.isSpeaking,
        quality: lp.connectionQuality,
        encryption: lk.isE2EEEnabled ? "encrypted" : "not-encrypted",
        keyIndex: this.keys.keyInfo(lp.identity)?.index ?? null,
        keyOverdue: false,
      });
      for (const p of lk.remoteParticipants.values()) {
        seen.add(p.identity);
        if (!this.firstSeen.has(p.identity)) this.firstSeen.set(p.identity, Date.now());
        const m = this.identityToMembership.get(p.identity) ?? null;
        const t = (s: Track.Source) => p.getTrackPublication(s) as RemoteTrackPublication | undefined;
        const mic2 = t(Track.Source.Microphone);
        const cam2 = t(Track.Source.Camera);
        const scr2 = t(Track.Source.ScreenShare);
        const scrA = t(Track.Source.ScreenShareAudio);
        participants.push({
          identity: p.identity,
          userId: m?.userId ?? null,
          deviceId: m?.deviceId ?? null,
          name: memberName(m?.userId ?? null),
          isLocal: false,
          pending: false,
          micTrack: (mic2?.track as RemoteTrack | undefined) ?? null,
          micMuted: !mic2 || mic2.isMuted,
          cameraTrack: cam2?.track && !cam2.isMuted ? (cam2.track as RemoteTrack) : null,
          cameraMuted: !cam2 || cam2.isMuted,
          screenTrack: (scr2?.track as RemoteTrack | undefined) ?? null,
          screenAudioTrack: (scrA?.track as RemoteTrack | undefined) ?? null,
          speaking: p.isSpeaking,
          quality: p.connectionQuality,
          encryption: this.encryptionOf(p),
          keyIndex: this.keys.keyInfo(p.identity)?.index ?? null,
          keyOverdue: this.keyOverdue(p.identity),
        });
      }
    }
    // Matrix members of the call that aren't on the media server (yet).
    for (const m of this.rtc.memberships) {
      if (m.backendIdentities.some((id) => seen.has(id))) continue;
      if (m.userId === me && m.deviceId === this.client.getDeviceId()) continue;
      participants.push({
        identity: m.backendIdentities[0] ?? `${m.userId}:${m.deviceId}`,
        userId: m.userId,
        deviceId: m.deviceId,
        name: m.userId === me ? `${memberName(me)} (other device)` : memberName(m.userId),
        isLocal: false,
        pending: true,
        micTrack: null,
        micMuted: true,
        cameraTrack: null,
        cameraMuted: true,
        screenTrack: null,
        screenAudioTrack: null,
        speaking: false,
        quality: ConnectionQuality.Unknown,
        encryption: this.keys.hasKeyFor(m.backendIdentities[0] ?? "") ? "encrypted" : "waiting-for-key",
        keyIndex: this.keys.keyInfo(m.backendIdentities[0] ?? "")?.index ?? null,
        keyOverdue: false,
      });
    }
    const remote = participants.filter((p) => !p.isLocal && !p.pending && p.encryption !== "unknown");
    const unknown = participants.filter((p) => p.encryption === "unknown").length;
    // re-evaluate when the earliest pending key wait becomes overdue
    if (this.keyWaitTimer) clearTimeout(this.keyWaitTimer);
    const waits = remote.filter((p) => p.encryption === "waiting-for-key" && !p.keyOverdue).map((p) => (this.firstSeen.get(p.identity) ?? Date.now()) + KEY_WAIT_WARN_MS - Date.now());
    if (waits.length) this.keyWaitTimer = setTimeout(this.scheduleUpdate, Math.max(250, Math.min(...waits) + 50));
    this.set({
      participants,
      e2ee: {
        enabled: !!lk?.isE2EEEnabled,
        ownKey: !!lk && this.keys.hasKeyFor(lk.localParticipant.identity),
        ownKeyIndex: lk ? (this.keys.keyInfo(lk.localParticipant.identity)?.index ?? null) : null,
        remoteTotal: remote.length,
        remoteEncrypted: remote.filter((p) => p.encryption === "encrypted").length,
        remoteWaiting: remote.filter((p) => p.encryption === "waiting-for-key" && !p.keyOverdue).length,
        unknownConnections: unknown,
      },
    });
    this.refreshDeviceState();
  }

  private refreshDeviceState(): void {
    const lk = this.lk;
    const a = this.audioTrack;
    const v = this.videoTrack;
    const micPub = lk?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const camPub = lk?.localParticipant.getTrackPublication(Track.Source.Camera);
    const live = (t: LocalTrack | null) => !!t && t.mediaStreamTrack.readyState === "live";
    let micState: DeviceState = this.snapshot.mic.state;
    if (a && live(a) && micPub) micState = micPub.isMuted ? "muted" : "on";
    else if (a && live(a)) micState = this.snapshot.phase === "connected" ? "off" : "starting";
    else if (this.snapshot.mic.state !== "starting" || this.snapshot.phase !== "starting") micState = "unavailable";
    let camState: DeviceState = this.snapshot.camera.state;
    if (v && camPub) camState = camPub.isMuted ? "off" : live(v) ? "on" : "off";
    else if (!v && camState !== "unavailable") camState = "off";
    const scr = lk?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const scrA = lk?.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
    const mic = { ...this.snapshot.mic, state: micState, label: a ? (a.mediaStreamTrack.label || null) : null };
    const camera = { ...this.snapshot.camera, state: camState, label: v ? (v.mediaStreamTrack.label || null) : null };
    const screen = { ...this.snapshot.screen, active: !!scr?.track, hasAudio: !!scrA?.track };
    const s = this.snapshot;
    if (s.mic.state !== mic.state || s.mic.label !== mic.label || s.camera.state !== camera.state || s.camera.label !== camera.label || s.screen.active !== screen.active || s.screen.hasAudio !== screen.hasAudio) {
      this.set({ mic, camera, screen });
    }
  }

  // ---- local track lifecycle (device unplugged etc.) -------------------------------------

  private watchLocalTrack(t: LocalTrack): void {
    const onEnded = () => void this.onTrackEnded(t);
    t.on(TrackEvent.Ended, onEnded);
    this.cleanups.push(() => t.off(TrackEvent.Ended, onEnded));
  }

  private async onTrackEnded(t: LocalTrack): Promise<void> {
    if (this.leaving) return;
    const kind = t.kind === Track.Kind.Audio ? "microphone" : "camera";
    try {
      // The device disappeared (unplugged, disabled, taken over): fall back to the system default.
      if (t instanceof LocalAudioTrack) await t.restartTrack({ ...audioCaptureOptions(getCallPrefs(), null), deviceId: undefined });
      else if (t instanceof LocalVideoTrack) await t.restartTrack({ ...videoCaptureOptions(this.profile, null) });
      this.set({ notice: `Your ${kind} stopped working (disconnected?). Switched to the system default ${kind}.` });
      this.log(`${kind} lost — switched to default device`);
    } catch (e) {
      this.set({ notice: `Your ${kind} stopped working and no other ${kind} is available. ${describeMediaError(e, kind)}` });
      this.log(`${kind} lost — no replacement device`);
      if (t === this.audioTrack) this.set({ mic: { state: "unavailable", error: describeMediaError(e, kind), label: null } });
    }
    this.refreshDeviceState();
  }

  private async onDevicesChanged(): Promise<void> {
    // LiveKit already follows a changed "default" device; just refresh labels/state.
    this.refreshDeviceState();
  }

  // ---- controls --------------------------------------------------------------------------

  async setMicEnabled(on: boolean): Promise<void> {
    const lk = this.lk;
    if (!lk) return;
    const prefs = getCallPrefs();
    if (on && (!this.audioTrack || this.audioTrack.mediaStreamTrack.readyState !== "live")) {
      // Mic was unavailable: try again (this is a user action).
      try {
        const t = await createLocalAudioTrack(audioCaptureOptions(prefs));
        this.audioTrack?.stop();
        this.audioTrack = t;
        this.watchLocalTrack(t);
        await lk.localParticipant.publishTrack(t, { source: Track.Source.Microphone, ...audioPublishOptions(prefs, t.mediaStreamTrack.getSettings().channelCount) });
        this.set({ mic: { state: "on", error: null, label: t.mediaStreamTrack.label || null } });
      } catch (e) {
        this.set({ mic: { state: "unavailable", error: describeMediaError(e, "microphone"), label: null } });
      }
      return;
    }
    const pub = lk.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!pub?.track) return;
    if (on) await pub.unmute();
    else await pub.mute();
    this.refreshDeviceState();
    this.scheduleUpdate();
  }

  async setCameraEnabled(on: boolean): Promise<void> {
    const lk = this.lk;
    if (!lk) return;
    const prefs = getCallPrefs();
    const pub = lk.localParticipant.getTrackPublication(Track.Source.Camera) as LocalTrackPublication | undefined;
    if (on) {
      try {
        if (pub?.track) {
          await pub.unmute();
        } else {
          this.profile = resolveVideoProfile(prefs.videoQuality);
          const t = await createLocalVideoTrack(videoCaptureOptions(this.profile, prefs.cameraDeviceId));
          this.videoTrack = t;
          this.profile = this.profileForTrack(t, prefs);
          this.watchLocalTrack(t);
          await lk.localParticipant.publishTrack(t, { source: Track.Source.Camera, simulcast: true, videoCodec: this.codec, videoEncoding: this.profile.encoding, videoSimulcastLayers: this.profile.layers });
          this.set({ videoProfile: this.profile.label });
        }
        this.set({ camera: { state: "on", error: null, label: this.videoTrack?.mediaStreamTrack.label || null } });
      } catch (e) {
        this.set({ camera: { state: "unavailable", error: describeMediaError(e, "camera"), label: null } });
      }
    } else if (pub?.track) {
      await pub.mute();
    }
    this.refreshDeviceState();
    this.scheduleUpdate();
  }

  async setScreenShare(on: boolean): Promise<void> {
    const lk = this.lk;
    if (!lk) return;
    try {
      await lk.localParticipant.setScreenShareEnabled(
        on,
        {
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: "include",
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          contentHint: "detail",
          resolution: { width: 1920, height: 1080, frameRate: 15 },
        },
        { videoCodec: this.codec, screenShareEncoding: SCREEN_SHARE_ENCODING, simulcast: true },
      );
      this.set({ screen: { ...this.snapshot.screen, error: null } });
      this.log(on ? "Screen sharing started" : "Screen sharing stopped");
    } catch (e) {
      this.set({ screen: { ...this.snapshot.screen, error: describeMediaError(e, "screen") } });
    }
    this.refreshDeviceState();
    this.scheduleUpdate();
  }

  /** Switches microphone or camera; returns the deviceId the track actually uses. */
  async switchDevice(kind: "audioinput" | "videoinput", deviceId: string): Promise<string | null> {
    const t = kind === "audioinput" ? this.audioTrack : this.videoTrack;
    if (!t) return null;
    if (this.lk) await this.lk.switchActiveDevice(kind, deviceId, true);
    else await t.setDeviceId({ exact: deviceId });
    this.refreshDeviceState();
    return (t.mediaStreamTrack.getSettings().deviceId as string | undefined) ?? null;
  }

  async setSpeaker(deviceId: string): Promise<boolean> {
    this.set({ speakerDeviceId: deviceId });
    if (!this.lk) return false;
    return this.lk.switchActiveDevice("audiooutput", deviceId, true);
  }

  /** Re-applies the audio mode/processing preferences to the live microphone track. */
  async applyAudioPrefs(): Promise<void> {
    const prefs = getCallPrefs();
    const a = this.audioTrack;
    this.set({ audioMode: prefs.audioMode });
    if (!a || !this.lk) return;
    // Capture constraints (processing) can change on the fly; the Opus encoder settings
    // (bitrate, DTX, stereo) are fixed at publish time, so republish.
    await a.restartTrack(audioCaptureOptions(prefs, (a.mediaStreamTrack.getSettings().deviceId as string | undefined) ?? null));
    const lp = this.lk.localParticipant;
    const wasMuted = a.isMuted;
    await lp.unpublishTrack(a, false);
    await lp.publishTrack(a, { source: Track.Source.Microphone, ...audioPublishOptions(prefs, a.mediaStreamTrack.getSettings().channelCount) });
    if (wasMuted) await a.mute();
    this.log(`Audio mode: ${prefs.audioMode === "hifi" ? "High-Fidelity" : "HD Voice"}`);
    this.refreshDeviceState();
  }

  async startAudioPlayback(): Promise<void> {
    await this.lk?.startAudio();
    this.set({ audioPlaybackBlocked: !(this.lk?.canPlaybackAudio ?? true) });
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // ---- stats -----------------------------------------------------------------------------

  private startStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => void this.collectStats().catch(() => undefined), STATS_INTERVAL_MS);
  }

  private async collectStats(): Promise<void> {
    const lk = this.lk;
    if (!lk || lk.state !== ConnectionState.Connected) return;
    let transport: TransportInfo | null = null;
    const streams: StreamSummary[] = [];
    const take = async (key: string, track: Track | undefined | null, dir: "send" | "receive") => {
      if (!track) return null;
      const report = await (track as LocalTrack | RemoteTrack).getRTCStatsReport?.().catch(() => undefined);
      const cur = reportToArray(report);
      if (!cur.length) return null;
      const s = summariseStream(cur, this.prevReports.get(key) ?? null, dir);
      this.prevReports.set(key, cur);
      transport ??= transportInfo(cur);
      if (s) streams.push(s);
      return s;
    };
    const lp = lk.localParticipant;
    const local = {
      audio: await take("l-a", lp.getTrackPublication(Track.Source.Microphone)?.track, "send"),
      video: await take("l-v", lp.getTrackPublication(Track.Source.Camera)?.track, "send"),
      screen: await take("l-s", lp.getTrackPublication(Track.Source.ScreenShare)?.track, "send"),
    };
    const remote: CallStatsSnapshot["remote"] = {};
    for (const p of lk.remoteParticipants.values()) {
      const pub = (s: Track.Source) => p.getTrackPublication(s)?.track;
      const r = {
        audio: await take(`r-${p.identity}-a`, pub(Track.Source.Microphone), "receive"),
        video: await take(`r-${p.identity}-v`, pub(Track.Source.Camera), "receive"),
        screen: await take(`r-${p.identity}-s`, pub(Track.Source.ScreenShare), "receive"),
      };
      remote[p.identity] = r;
      // Video bytes arriving but nothing decodes => we can't decrypt (or decode) their media.
      const v = r.video;
      if (v && (v.kbps ?? 0) > 20 && v.framesDecodedDelta === 0) this.noDecodeStreak.set(p.identity, (this.noDecodeStreak.get(p.identity) ?? 0) + 1);
      else if (v && (v.framesDecodedDelta ?? 0) > 0) this.noDecodeStreak.set(p.identity, 0);
    }
    const network = overallNetwork(streams, transport);
    this.set({ stats: { at: Date.now(), local, remote, transport, network, verdict: classifyNetwork(network) } });
    this.scheduleUpdate();
  }

  // ---- leave -----------------------------------------------------------------------------

  async leave(reason = "You left the call"): Promise<void> {
    await this.teardown(reason, false);
  }

  private async teardown(reason: string, isError: boolean): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.ringTimer) clearTimeout(this.ringTimer);
    if (this.keyWaitTimer) clearTimeout(this.keyWaitTimer);
    this.cleanups.splice(0).forEach((c) => c());
    this.set({ phase: "ended", endReason: reason, error: isError ? reason : null, ringing: false });
    const lk = this.lk;
    this.audioTrack?.stop();
    this.videoTrack?.stop();
    if (lk) {
      lk.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.stop();
      lk.removeAllListeners();
      await lk.disconnect(true).catch(() => undefined);
    }
    await this.rtc.leave(5_000).catch(() => false);
  }
}
