#if DEBUG
import LumenCore
import MatrixRustSDK
import SwiftUI

/// Every screen the screenshot harness renders, built from PreviewFixtures.
/// Names are stable: the before/after sets in
/// docs/test-results/ui-polish/ios use them.
@MainActor
enum ScreenshotCatalog {
    typealias F = PreviewFixtures

    static var scenes: [ScreenshotScene] { auth + launch + rooms + timeline + details + settings + security + other }

    // MARK: - Helpers

    private static func session(_ ctx: ScreenshotContext, rooms: [RoomSummary]? = nil, loading: Bool = false, loadError: String? = nil,
                                searchText: String = "", recovery: RecoveryState = .enabled, verification: VerificationState = .verified,
                                hasOtherDevices: Bool = true, verificationPhase: VerificationModel.Phase = .idle, verifyingUser: String? = nil,
                                data: SessionPreviewData = SessionPreviewData(), timelines: [TimelineModel] = []) -> SessionModel {
        let s = F.session(rooms: rooms, loading: loading, loadError: loadError, searchText: searchText, recovery: recovery,
                          verification: verification, hasOtherDevices: hasOtherDevices, verificationPhase: verificationPhase,
                          verifyingUser: verifyingUser, data: data, timelines: timelines, media: ctx.media)
        ctx.app.showPreview(session: s)
        return s
    }

    private static func designRoom(rows: [TimelineRow] = F.conversation(), typing: [String] = []) -> TimelineModel {
        F.timeline(F.designRoomId, name: "Design crew", rows: rows, typing: typing)
    }

    private static func priyaRoom(warnings: [IdentityWarning] = []) -> TimelineModel {
        F.timeline(F.priyaRoomId, name: "Priya Raman", rows: F.directChat(), direct: true, warnings: warnings)
    }

    private static func messageRow(_ id: String, in rows: [TimelineRow]) -> MessageRow? {
        for row in rows where row.id == id {
            if case .message(let m) = row.kind { return m }
        }
        return nil
    }

    /// A room as people see it: pushed from the room list on iPhone, in the
    /// split view's detail column on iPad.
    private static func roomScreen(_ ctx: ScreenshotContext, _ s: SessionModel, _ t: TimelineModel, draft: String = "",
                                   replyTo: MessageRow? = nil, editing: MessageRow? = nil, sending: Bool = false) -> AnyView {
        if ctx.isPad {
            ctx.app.selectedRoomId = t.roomId
            return AnyView(HomeView(session: s))
        }
        return AnyView(PushedScreen(backTitle: s.brandShortName) {
            RoomView(session: s, model: t, draft: draft, replyTo: replyTo, editing: editing, sending: sending)
        })
    }

    private static func overHome<Sheet: View>(_ s: SessionModel, _ sheet: Sheet) -> AnyView {
        AnyView(SheetOver(base: HomeView(session: s), sheet: sheet.lumenTheme()))
    }

    // MARK: - Sign-in

    private static var auth: [ScreenshotScene] {
        [
            ScreenshotScene("welcome", dynamicType: true) { ctx in
                ctx.app.auth.showPreview(.idle, serverInput: "")
                return AnyView(ServerPickerView(auth: ctx.app.auth))
            },
            ScreenshotScene("welcome-looking-up", .phone) { ctx in
                ctx.app.auth.showPreview(.discovering, serverInput: F.server)
                return AnyView(ServerPickerView(auth: ctx.app.auth))
            },
            ScreenshotScene("welcome-server-error", .phone, dynamicType: true) { ctx in
                ctx.app.auth.showPreview(.failed(DiscoveryError.unreachable(F.server).userMessage), serverInput: F.server)
                return AnyView(ServerPickerView(auth: ctx.app.auth))
            },
            ScreenshotScene("welcome-no-sliding-sync", .phone) { ctx in
                ctx.app.auth.showPreview(.failed(DiscoveryError.noSlidingSync.userMessage), serverInput: "matrix.example.org")
                return AnyView(ServerPickerView(auth: ctx.app.auth))
            },
            ScreenshotScene("sign-in", dynamicType: true) { ctx in
                ctx.app.auth.showPreview(.ready(F.discovery()), serverInput: F.server)
                return AnyView(ServerPickerView(auth: ctx.app.auth))
            },
            ScreenshotScene("sign-in-waiting-for-browser", .phone) { ctx in
                ctx.app.auth.showPreview(.signingIn(F.discovery()), serverInput: F.server)
                return AnyView(ServerPickerView(auth: ctx.app.auth))
            },
            ScreenshotScene("sign-in-error", .phone) { ctx in
                ctx.app.auth.showPreview(.ready(F.discovery()), serverInput: F.server)
                return AnyView(ServerPickerView(auth: ctx.app.auth, initialError: "Sign-in didn't complete. Please try again."))
            },
            ScreenshotScene("sign-in-password-only", .phone) { ctx in
                ctx.app.auth.showPreview(.ready(F.discovery(sso: false)), serverInput: F.server)
                return AnyView(ServerPickerView(auth: ctx.app.auth))
            },
        ]
    }

    // MARK: - Launch and lock

    private static var launch: [ScreenshotScene] {
        [
            ScreenshotScene("launch", .phone) { _ in AnyView(LaunchView()) },
            ScreenshotScene("launch-failed", .phone, dynamicType: true) { _ in
                AnyView(LaunchFailedView(message: "Your session couldn't be opened. You can try again, or sign out to start over on this device."))
            },
            ScreenshotScene("app-lock") { ctx in
                _ = session(ctx)
                return AnyView(LockView())
            },
            ScreenshotScene("privacy-cover", .phone) { _ in AnyView(PrivacyCoverView()) },
        ]
    }

    // MARK: - Room list

    private static var rooms: [ScreenshotScene] {
        [
            ScreenshotScene("rooms", dynamicType: true, multitasking: true) { ctx in
                AnyView(HomeView(session: session(ctx)))
            },
            ScreenshotScene("rooms-empty") { ctx in
                AnyView(HomeView(session: session(ctx, rooms: [])))
            },
            ScreenshotScene("rooms-loading", .phone) { ctx in
                AnyView(HomeView(session: session(ctx, rooms: [], loading: true)))
            },
            ScreenshotScene("rooms-error", .phone) { ctx in
                AnyView(HomeView(session: session(ctx, rooms: [], loadError: "The room list couldn't be loaded.")))
            },
            ScreenshotScene("rooms-search-no-results", .phone) { ctx in
                AnyView(HomeView(session: session(ctx, rooms: [], searchText: "Budget")))
            },
            ScreenshotScene("rooms-offline", .phone, dynamicType: true) { ctx in
                let data = SessionPreviewData(networkReachable: false, authError: "Your session needs to be signed in again.")
                return AnyView(HomeView(session: session(ctx, data: data)))
            },
            ScreenshotScene("rooms-reconnecting", .phone) { ctx in
                let data = SessionPreviewData(syncStatus: .terminated)
                return AnyView(HomeView(session: session(ctx, data: data)))
            },
        ]
    }

    // MARK: - Timeline and composer

    private static var timeline: [ScreenshotScene] {
        [
            ScreenshotScene("conversation", dynamicType: true, multitasking: true) { ctx in
                let t = designRoom(typing: [F.maya.userId])
                return roomScreen(ctx, session(ctx, timelines: [t]), t)
            },
            ScreenshotScene("conversation-media") { ctx in
                let t = designRoom(rows: F.media())
                return roomScreen(ctx, session(ctx, timelines: [t]), t)
            },
            ScreenshotScene("conversation-special-events", dynamicType: true) { ctx in
                let t = designRoom(rows: F.specialEvents())
                return roomScreen(ctx, session(ctx, timelines: [t]), t)
            },
            ScreenshotScene("conversation-direct-identity-changed", .phone) { ctx in
                let t = priyaRoom(warnings: [IdentityWarning(userId: F.priya.userId, kind: .verifiedChanged)])
                return roomScreen(ctx, session(ctx, timelines: [t]), t)
            },
            ScreenshotScene("conversation-new-room", .phone) { ctx in
                let t = F.timeline(F.newRoomId, name: "Launch prep", rows: F.newRoom())
                return roomScreen(ctx, session(ctx, timelines: [t]), t)
            },
            ScreenshotScene("conversation-loading", .phone) { ctx in
                let t = F.timeline(F.designRoomId, name: "Design crew", rows: [], reachedStart: false)
                return roomScreen(ctx, session(ctx, timelines: [t]), t)
            },
            ScreenshotScene("conversation-error", .phone) { ctx in
                let t = F.timeline(F.designRoomId, name: "Design crew", rows: [], loadError: "This room's messages couldn't be loaded.")
                return roomScreen(ctx, session(ctx, timelines: [t]), t)
            },
            ScreenshotScene("conversation-offline", .phone) { ctx in
                let t = designRoom()
                return roomScreen(ctx, session(ctx, data: SessionPreviewData(networkReachable: false), timelines: [t]), t)
            },
            ScreenshotScene("composer-multiline", .phone, dynamicType: true) { ctx in
                let t = designRoom()
                let draft = "Here's the plan for Thursday:\n1. Walk through the new onboarding\n2. Decide on the recovery-key copy\n3. Review the iPad layout"
                return roomScreen(ctx, session(ctx, timelines: [t]), t, draft: draft)
            },
            ScreenshotScene("composer-reply", .phone) { ctx in
                let t = designRoom()
                return roomScreen(ctx, session(ctx, timelines: [t]), t, draft: "Before, so it reads in order", replyTo: messageRow("m2", in: t.rows))
            },
            ScreenshotScene("composer-editing", .phone) { ctx in
                let t = designRoom()
                let edit = messageRow("m9", in: t.rows)
                return roomScreen(ctx, session(ctx, timelines: [t]), t, draft: edit?.plainText ?? "", editing: edit)
            },
            ScreenshotScene("composer-sending-attachment", .phone) { ctx in
                let t = designRoom(rows: F.media())
                return roomScreen(ctx, session(ctx, timelines: [t]), t, sending: true)
            },
        ]
    }

    // MARK: - Room details

    private static var details: [ScreenshotScene] {
        [
            ScreenshotScene("room-details", pages: 2, settle: 0.8) { ctx in
                let t = designRoom()
                let s = session(ctx, timelines: [t])
                return AnyView(SheetOver(base: roomScreen(ctx, s, t), sheet: RoomInfoView(session: s, model: t).lumenTheme()))
            },
            ScreenshotScene("room-details-direct", .phone, settle: 0.8) { ctx in
                let t = priyaRoom()
                let s = session(ctx, timelines: [t])
                return AnyView(SheetOver(base: roomScreen(ctx, s, t), sheet: RoomInfoView(session: s, model: t).lumenTheme()))
            },
        ]
    }

    // MARK: - Settings

    private static var settings: [ScreenshotScene] {
        [
            ScreenshotScene("settings", dynamicType: true, pages: 4, settle: 0.8) { ctx in
                let s = session(ctx)
                ctx.app.preferences.appLockEnabled = true
                return overHome(s, SettingsView(session: s))
            },
            ScreenshotScene("settings-needs-attention", .phone, pages: 2, settle: 0.8) { ctx in
                let s = session(ctx, recovery: .disabled, verification: .unverified, hasOtherDevices: false)
                return overHome(s, SettingsView(session: s))
            },
            ScreenshotScene("settings-devices", settle: 0.8) { ctx in
                let s = session(ctx)
                return overHome(s, PushedScreen(backTitle: "Settings") { DevicesView(session: s) })
            },
            ScreenshotScene("settings-blocked", .phone, settle: 0.8) { ctx in
                let s = session(ctx, data: SessionPreviewData(ignoredUsers: ["@spam-bot:example.org", "@noor:lumen.example"]))
                return overHome(s, PushedScreen(backTitle: "Settings") { BlockedUsersView(session: s) })
            },
            ScreenshotScene("settings-blocked-empty", .phone, settle: 0.8) { ctx in
                let s = session(ctx)
                return overHome(s, PushedScreen(backTitle: "Settings") { BlockedUsersView(session: s) })
            },
            ScreenshotScene("settings-data-protection", .phone, pages: 3, settle: 0.8) { ctx in
                let s = session(ctx)
                return overHome(s, PushedScreen(backTitle: "Settings") { SecurityInfoView() })
            },
            ScreenshotScene("settings-about", pages: 3, settle: 0.8) { ctx in
                let s = session(ctx)
                return overHome(s, PushedScreen(backTitle: "Settings") { AboutView(session: s) })
            },
        ]
    }

    // MARK: - Encryption and verification

    private static var security: [ScreenshotScene] {
        [
            ScreenshotScene("security-confirm-its-you", dynamicType: true, settle: 0.8) { ctx in
                // HomeView offers this sheet itself on the first run.
                AnyView(HomeView(session: session(ctx, recovery: .enabled, verification: .unverified)))
            },
            ScreenshotScene("security-set-up-recovery", .phone, settle: 0.8) { ctx in
                AnyView(HomeView(session: session(ctx, recovery: .disabled, verification: .verified)))
            },
            ScreenshotScene("security-recovery-intro", .phone, settle: 0.8) { ctx in
                let s = session(ctx, recovery: .disabled)
                return overHome(s, SecurityOnboardingView(session: s, startIn: .setup))
            },
            ScreenshotScene("security-recovery-key", dynamicType: true, settle: 0.8) { ctx in
                let s = session(ctx, recovery: .disabled)
                return overHome(s, SecurityOnboardingView(session: s, startIn: .setup, previewKey: F.recoveryKey))
            },
            ScreenshotScene("security-enter-recovery-key", .phone, settle: 0.8) { ctx in
                let s = session(ctx, recovery: .incomplete, verification: .unverified)
                return overHome(s, SecurityOnboardingView(session: s, startIn: .enterKey))
            },
            ScreenshotScene("verification-emoji", dynamicType: true, settle: 0.8) { ctx in
                // HomeView presents the verification sheet while a verification runs.
                AnyView(HomeView(session: session(ctx, verificationPhase: .emojis(F.sasEmoji))))
            },
            ScreenshotScene("verification-incoming", .phone, settle: 0.8) { ctx in
                AnyView(HomeView(session: session(ctx, verificationPhase: .incoming(sender: F.maya.name, deviceName: "Lumen on Mac", deviceId: "MACBOOKQ2"),
                                                  verifyingUser: F.maya.userId)))
            },
            ScreenshotScene("verification-waiting", .phone, settle: 0.8) { ctx in
                AnyView(HomeView(session: session(ctx, verificationPhase: .waitingForOther)))
            },
            ScreenshotScene("verification-verified", .phone, settle: 0.8) { ctx in
                // In the app this state is reached inside the open sheet.
                let s = session(ctx)
                return overHome(s, VerificationView(verification: VerificationModel(preview: .verified)))
            },
            ScreenshotScene("verification-cancelled", .phone, settle: 0.8) { ctx in
                let s = session(ctx)
                let why = "The emoji didn't match, so the verification was stopped. Someone may be intercepting the connection; try again in person."
                return overHome(s, VerificationView(verification: VerificationModel(preview: .cancelled(why))))
            },
        ]
    }

    // MARK: - New chats, links, calls

    private static var other: [ScreenshotScene] {
        [
            ScreenshotScene("new-chat", .phone, settle: 0.8) { ctx in
                let s = session(ctx)
                return overHome(s, NewChatView(session: s) { _ in })
            },
            ScreenshotScene("new-group", .phone, settle: 0.8) { ctx in
                let s = session(ctx)
                return overHome(s, NewGroupView(session: s) { _ in })
            },
            ScreenshotScene("open-link", .phone, settle: 0.8) { ctx in
                let s = session(ctx)
                return overHome(s, ConfirmLinkView(route: .user(id: "@noor:lumen.example"), session: s))
            },
            ScreenshotScene("call") { _ in
                AnyView(PreviewCallScreen(state: CallStateUpdate(state: .connected, video: true, muted: false, e2ee: .encrypted)))
            },
            ScreenshotScene("call-connecting", .phone) { _ in
                AnyView(PreviewCallScreen(state: CallStateUpdate(state: .connecting, video: false, muted: true, e2ee: .unknown)))
            },
        ]
    }
}

/// The call screen's own controls over a stand-in for the call widget (the
/// widget is a web page and isn't rendered here).
struct PreviewCallScreen: View {
    let state: CallStateUpdate
    @State private var speaker = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 12) {
                ForEach(["Maya Chen", "Sam Okafor"], id: \.self) { name in
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(Color(white: 0.14))
                        .overlay { AvatarView(name: name, size: 72) }
                        .overlay(alignment: .bottomLeading) {
                            Text(name).font(.caption.weight(.semibold)).foregroundStyle(.white).padding(10)
                        }
                }
                Text("Call widget (web content, not rendered in screenshots)")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.5))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 120)
            CallChrome(roomName: "Design crew", sourceLabel: WidgetSource.bundled.label, state: state, speaker: $speaker,
                       onToggleMute: {}, onToggleVideo: {}, onSwitchCamera: {}, onSpeakerChanged: { _ in }, onEnd: {})
        }
        .preferredColorScheme(.dark)
    }
}
#endif
