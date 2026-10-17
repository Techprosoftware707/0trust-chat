import LumenCore
import MatrixRustSDK
import SwiftUI

/// iPhone: a stack; iPad: sidebar + detail (NavigationSplitView adapts).
struct HomeView: View {
    let session: SessionModel
    @Environment(AppModel.self) private var model
    @Environment(\.lumen) private var c
    @State private var showSettings = false
    @State private var showNewChat = false
    @State private var showNewGroup = false
    @State private var showSecurity = false
    @State private var columnVisibility = NavigationSplitViewVisibility.all

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: $columnVisibility) {
            RoomListView(session: session, selection: $model.selectedRoomId)
                .navigationTitle(session.brandShortName)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showSettings = true } label: {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("Settings")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button { showNewChat = true } label: { Label("New chat", systemImage: "person") }
                            Button { showNewGroup = true } label: { Label("New group", systemImage: "person.3") }
                        } label: {
                            Image(systemName: "square.and.pencil")
                        }
                        .accessibilityLabel("Start a conversation")
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    VStack(spacing: 0) {
                        if let banner = session.banner {
                            ConnectionBannerView(banner: banner) { session.retrySync() }
                        }
                        if session.encryption.needsVerification || session.encryption.needsRecoverySetup {
                            BannerView(style: .warning, systemImage: "key",
                                       text: session.encryption.needsVerification ? "Verify this device to read your earlier messages and to show others it's really you." : "Set up recovery so you don't lose your messages if you lose this device.",
                                       actionTitle: "Set up", action: { showSecurity = true })
                        }
                        if let e = session.authError {
                            BannerView(style: .danger, systemImage: "person.crop.circle.badge.exclamationmark", text: e)
                        }
                    }
                }
        } detail: {
            if let id = model.selectedRoomId, let timeline = session.makeTimelineModel(roomId: id) {
                RoomView(session: session, model: timeline)
                    .id(id)
            } else {
                ContentUnavailableView("No conversation selected", systemImage: "bubble.left.and.bubble.right", description: Text("Choose a conversation, or start a new one."))
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView(session: session).lumenTheme() }
        .sheet(isPresented: $showNewChat) { NewChatView(session: session) { model.selectedRoomId = $0 }.lumenTheme() }
        .sheet(isPresented: $showNewGroup) { NewGroupView(session: session) { model.selectedRoomId = $0 }.lumenTheme() }
        .sheet(isPresented: $showSecurity) { SecurityOnboardingView(session: session).lumenTheme() }
        .sheet(isPresented: Binding(get: { session.verification.isActive }, set: { if !$0 { Task { await session.verification.cancel() } } })) {
            VerificationView(verification: session.verification).lumenTheme()
        }
        .task(id: session.encryption.initialised) {
            // First run after sign-in: offer verification or recovery once.
            if session.encryption.initialised, session.encryption.needsVerification || session.encryption.needsRecoverySetup {
                showSecurity = true
            }
        }
        .alert("Calls", isPresented: Binding(get: { model.calls.error != nil }, set: { if !$0 { model.calls.clearError() } })) {
            Button("OK") {}
        } message: {
            Text(model.calls.error ?? "")
        }
    }
}

struct RoomListView: View {
    let session: SessionModel
    @Binding var selection: String?
    @Environment(\.lumen) private var c
    @State private var actionError: String?

    var body: some View {
        @Bindable var list = session.roomList
        List(selection: $selection) {
            if !list.invites.isEmpty {
                Section("Invitations") {
                    ForEach(list.invites) { invite in
                        InviteRow(summary: invite, session: session, error: $actionError)
                    }
                }
            }
            Section {
                ForEach(list.joined) { room in
                    RoomRow(summary: room)
                        .tag(room.id as String?)
                        .onAppear {
                            if room.id == list.joined.last?.id { list.loadMore() }
                        }
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $list.searchText, prompt: "Search conversations")
        .overlay {
            if list.isLoading {
                ProgressView("Loading conversations…")
            } else if let e = list.loadError {
                ContentUnavailableView("Couldn't load conversations", systemImage: "exclamationmark.triangle", description: Text(e))
            } else if list.summaries.isEmpty {
                if list.searchText.isEmpty {
                    ContentUnavailableView("No conversations yet", systemImage: "bubble.left.and.bubble.right", description: Text("Start a chat with the pencil button."))
                } else {
                    ContentUnavailableView.search(text: list.searchText)
                }
            }
        }
        .alert("Something went wrong", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK") {}
        } message: {
            Text(actionError ?? "")
        }
    }
}

struct RoomRow: View {
    let summary: RoomSummary
    @Environment(\.lumen) private var c

    var body: some View {
        HStack(spacing: LumenDimens.space3) {
            AvatarView(name: summary.name, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(summary.name)
                        .font(.body.weight(summary.hasUnread ? .semibold : .regular))
                        .foregroundStyle(c.text)
                        .lineLimit(1)
                    if summary.hasCall {
                        Image(systemName: "phone.fill")
                            .font(.caption)
                            .foregroundStyle(c.success)
                            .accessibilityLabel("Call in progress")
                    }
                    Spacer()
                    if let ts = summary.lastTimestamp {
                        Text(ts.shortRelative)
                            .font(.caption)
                            .foregroundStyle(c.textSubtle)
                    }
                }
                HStack {
                    Text(summary.lastMessage ?? (summary.isEncrypted ? "Encrypted conversation" : " "))
                        .font(.subheadline)
                        .foregroundStyle(c.textMuted)
                        .lineLimit(1)
                    Spacer()
                    if summary.unreadMentions > 0 {
                        badge("@", accessibility: "\(summary.unreadMentions) mentions")
                    } else if summary.unreadMessages > 0 {
                        badge(summary.unreadMessages > 99 ? "99+" : "\(summary.unreadMessages)", accessibility: "\(summary.unreadMessages) unread")
                    } else if summary.isMarkedUnread {
                        Circle().fill(c.accent).frame(width: 10, height: 10).accessibilityLabel("Marked unread")
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityHint(summary.isDirect ? "Direct chat" : "Group")
    }

    private func badge(_ text: String, accessibility: String) -> some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .foregroundStyle(c.accentContrast)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(c.accent))
            .accessibilityLabel(accessibility)
    }
}

struct InviteRow: View {
    let summary: RoomSummary
    let session: SessionModel
    @Binding var error: String?
    @Environment(\.lumen) private var c

    var body: some View {
        VStack(alignment: .leading, spacing: LumenDimens.space2) {
            HStack {
                AvatarView(name: summary.name, size: 36)
                VStack(alignment: .leading) {
                    Text(summary.name).font(.body.weight(.semibold)).foregroundStyle(c.text)
                    if let inviter = summary.inviterId {
                        Text("Invited by \(inviter)").font(.caption).foregroundStyle(c.textMuted)
                    }
                }
            }
            HStack {
                AsyncButton {
                    do { try await RoomActions(client: session.client).accept(roomId: summary.id) }
                    catch { self.error = "The invitation couldn't be accepted." }
                } label: { Text("Accept") }
                .buttonStyle(.borderedProminent)
                AsyncButton {
                    do { try await RoomActions(client: session.client).decline(roomId: summary.id) }
                    catch { self.error = "The invitation couldn't be declined." }
                } label: { Text("Decline") }
                .buttonStyle(.bordered)
                if let inviter = summary.inviterId {
                    AsyncButton {
                        do {
                            try await RoomActions(client: session.client).decline(roomId: summary.id)
                            try await session.ignore(userId: inviter)
                        } catch { self.error = "That didn't work. Try again." }
                    } label: { Text("Block") }
                    .buttonStyle(.bordered)
                    .tint(c.danger)
                    .accessibilityHint("Declines and blocks \(inviter)")
                }
            }
        }
        .padding(.vertical, LumenDimens.space1)
    }
}

/// Opening a link always asks first (integration.md §8).
struct ConfirmLinkView: View {
    let route: DeepLinkRoute
    let session: SessionModel
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: LumenDimens.space4) {
                switch route {
                case .room(let id, _, let via):
                    Text("Open or join \(id)?").font(.title3.weight(.semibold))
                    Text("If you're not a member yet, you'll join this room and its members will see you.").foregroundStyle(.secondary)
                    AsyncButton {
                        do {
                            let roomId = id.hasPrefix("!") && session.roomList.room(id: id) != nil ? id : try await RoomActions(client: session.client).join(idOrAlias: id, via: via)
                            model.selectedRoomId = roomId
                            dismiss()
                        } catch { self.error = "The room couldn't be opened. You may need an invitation." }
                    } label: { Text("Open") }
                    .buttonStyle(PrimaryButtonStyle())
                case .user(let id):
                    Text("Start a chat with \(id)?").font(.title3.weight(.semibold))
                    Text("An end-to-end encrypted direct chat is created and \(id) is invited.").foregroundStyle(.secondary)
                    AsyncButton {
                        do {
                            model.selectedRoomId = try await RoomActions(client: session.client).startDirectMessage(with: id)
                            dismiss()
                        } catch { self.error = "The chat couldn't be started." }
                    } label: { Text("Start chat") }
                    .buttonStyle(PrimaryButtonStyle())
                default:
                    EmptyView()
                }
                if let error { Text(error).foregroundStyle(.red) }
                Spacer()
            }
            .padding(LumenDimens.space5)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }
}
