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
            RoomListView(session: session, selection: $model.selectedRoomId, onNewChat: { showNewChat = true }, onSecure: { showSecurity = true })
                .navigationTitle(session.brandShortName)
                .navigationSplitViewColumnWidth(min: 300, ideal: 350, max: 420)
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
        } detail: {
            if let id = model.selectedRoomId, let timeline = session.makeTimelineModel(roomId: id) {
                RoomView(session: session, model: timeline)
                    .id(id)
            } else {
                EmptyStateView(systemImage: "bubble.left.and.bubble.right", title: "Pick a conversation",
                               message: "Choose one from the list, or start something new.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .lumenScreenBackground()
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView(session: session).lumenTheme() }
        .sheet(isPresented: $showNewChat) { NewChatView(session: session) { model.selectedRoomId = $0 }.lumenTheme() }
        .sheet(isPresented: $showNewGroup) { NewGroupView(session: session) { model.selectedRoomId = $0 }.lumenTheme() }
        .sheet(isPresented: $showSecurity) { SecurityOnboardingView(session: session).lumenTheme() }
        // Shown for the whole verification, including its result; closing it
        // during a verification cancels that verification.
        .sheet(isPresented: Binding(get: { session.verification.phase != .idle }, set: { shown in
            guard !shown else { return }
            let verification = session.verification
            if verification.isActive {
                Task { await verification.cancel() }
            } else {
                verification.reset()
            }
        })) {
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

/// The plain list style on iPhone, the sidebar style beside a detail column.
private struct RoomListStyleModifier: ViewModifier {
    let compact: Bool
    func body(content: Content) -> some View {
        if compact {
            content.listStyle(.plain)
        } else {
            content.listStyle(.sidebar)
        }
    }
}

struct RoomListView: View {
    let session: SessionModel
    @Binding var selection: String?
    var onNewChat: () -> Void = {}
    var onSecure: () -> Void = {}
    @Environment(\.lumen) private var c
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var actionError: String?

    /// iPhone (and narrow iPad windows): plain rows on the page background.
    private var compact: Bool { sizeClass == .compact }

    private var hasBanners: Bool {
        session.banner != nil || session.authError != nil
            || session.encryption.needsVerification || session.encryption.needsRecoverySetup
    }

    var body: some View {
        @Bindable var list = session.roomList
        List(selection: $selection) {
            if hasBanners {
                Section {
                    VStack(spacing: LumenDimens.space2) {
                        if let banner = session.banner {
                            ConnectionBannerView(banner: banner) { session.retrySync() }
                        }
                        if session.encryption.needsVerification {
                            BannerView(style: .info, systemImage: "checkmark.shield",
                                       text: "Confirm it's you to unlock your earlier messages and show your contacts this device is yours.",
                                       actionTitle: "Verify", action: onSecure)
                        } else if session.encryption.needsRecoverySetup {
                            BannerView(style: .info, systemImage: "key",
                                       text: "Set up recovery so your messages stay safe if you lose this device.",
                                       actionTitle: "Set up", action: onSecure)
                        }
                        if let e = session.authError {
                            BannerView(style: .danger, systemImage: "person.crop.circle.badge.exclamationmark", text: e)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: LumenDimens.space2, leading: LumenDimens.space4, bottom: LumenDimens.space2, trailing: LumenDimens.space4))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
            }
            if !list.invites.isEmpty {
                Section {
                    ForEach(list.invites) { invite in
                        InviteRow(summary: invite, session: session, error: $actionError)
                            .listRowSeparator(.hidden)
                            .listRowBackground(compact ? c.bg : nil)
                    }
                } header: {
                    Text("Invitations")
                }
            }
            if list.isLoading {
                Section {
                    ForEach(0..<8, id: \.self) { i in
                        SkeletonRoomRow(index: i)
                            .listRowSeparator(.hidden)
                            .listRowBackground(compact ? c.bg : nil)
                    }
                }
            }
            Section {
                ForEach(list.joined) { room in
                    RoomRow(summary: room)
                        .tag(room.id as String?)
                        .listRowBackground(compact ? c.bg : nil)
                        .onAppear {
                            if room.id == list.joined.last?.id { list.loadMore() }
                        }
                }
            } header: {
                if !list.invites.isEmpty && !list.joined.isEmpty {
                    Text("Conversations")
                }
            }
        }
        .modifier(RoomListStyleModifier(compact: compact))
        .scrollContentBackground(.hidden)
        .background(c.bg)
        .searchable(text: $list.searchText, prompt: "Search conversations")
        .overlay {
            if list.isLoading {
                EmptyView()
            } else if let e = list.loadError {
                EmptyStateView(systemImage: "exclamationmark.bubble", title: "Your conversations didn't load",
                               message: "\(e) Close Lumen and open it again to retry.")
            } else if list.summaries.isEmpty {
                if list.searchText.isEmpty {
                    EmptyStateView(systemImage: "bubble.left.and.text.bubble.right", title: "Your conversations will appear here",
                                   message: "Start a private, end-to-end encrypted chat with anyone on Matrix.") {
                        Button(action: onNewChat) {
                            Label("Start a conversation", systemImage: "square.and.pencil")
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .frame(maxWidth: 300)
                    }
                } else {
                    ContentUnavailableView.search(text: list.searchText)
                }
            }
        }
        .alert("That didn't work", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK") {}
        } message: {
            Text(actionError ?? "")
        }
    }
}

struct RoomRow: View {
    let summary: RoomSummary
    @Environment(\.lumen) private var c
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Increased while the row is selected in the iPad sidebar (accent background).
    @Environment(\.backgroundProminence) private var prominence

    private var selected: Bool { prominence == .increased }

    private var preview: String {
        if let last = summary.lastMessage, !last.isEmpty { return last }
        return summary.isEncrypted ? "End-to-end encrypted" : "No messages yet"
    }

    var body: some View {
        HStack(alignment: .center, spacing: LumenDimens.space3) {
            AvatarView(name: summary.name, size: typeSize.isAccessibilitySize ? 44 : 52)
                .overlay(alignment: .bottomTrailing) {
                    if summary.hasCall {
                        Image(systemName: "phone.fill")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 20, height: 20)
                            .background(Circle().fill(c.success))
                            .overlay(Circle().strokeBorder(c.bg, lineWidth: 2))
                            .offset(x: 3, y: 3)
                    }
                }
            VStack(alignment: .leading, spacing: 3) {
                if typeSize.isAccessibilitySize {
                    name
                    timestamp
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: LumenDimens.space2) {
                        name
                        Spacer(minLength: LumenDimens.space1)
                        timestamp
                    }
                }
                HStack(alignment: .top, spacing: LumenDimens.space2) {
                    Text(preview)
                        .font(.subheadline)
                        .foregroundStyle(selected ? c.accentContrast.opacity(0.85) : c.textMuted)
                        .lineLimit(typeSize.isAccessibilitySize ? 3 : 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    badge
                }
            }
            .alignmentGuide(.listRowSeparatorLeading) { d in d[.leading] }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(.isButton)
    }

    private var name: some View {
        HStack(spacing: 4) {
            Text(summary.name)
                .font(.body.weight(summary.hasUnread ? .semibold : .medium))
                .foregroundStyle(selected ? c.accentContrast : c.text)
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            if !summary.isEncrypted {
                Image(systemName: "lock.open")
                    .font(.caption)
                    .foregroundStyle(selected ? c.accentContrast : c.warning)
            }
        }
    }

    @ViewBuilder
    private var timestamp: some View {
        if let ts = summary.lastTimestamp {
            Text(ts.shortRelative)
                .font(.footnote.weight(summary.hasUnread ? .semibold : .regular))
                .monospacedDigit()
                .foregroundStyle(selected ? c.accentContrast : (summary.hasUnread ? c.accent : c.textSubtle))
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private var badge: some View {
        if summary.unreadMentions > 0 {
            countBadge("@")
        } else if summary.unreadMessages > 0 {
            countBadge(summary.unreadMessages > 99 ? "99+" : "\(summary.unreadMessages)")
        } else if summary.isMarkedUnread {
            Circle().fill(selected ? c.accentContrast : c.accent).frame(width: 12, height: 12).padding(.top, 4)
        }
    }

    private func countBadge(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.bold))
            .monospacedDigit()
            .foregroundStyle(selected ? c.accent : c.accentContrast)
            .padding(.horizontal, 7)
            .frame(minWidth: 22, minHeight: 22)
            .background(Capsule().fill(selected ? c.accentContrast : c.accent))
    }

    private var accessibilityText: String {
        var parts = [summary.name]
        if summary.hasCall { parts.append("call in progress") }
        if summary.unreadMentions > 0 { parts.append("\(summary.unreadMentions) \(summary.unreadMentions == 1 ? "mention" : "mentions")") }
        if summary.unreadMessages > 0 { parts.append("\(summary.unreadMessages) unread") } else if summary.isMarkedUnread { parts.append("marked unread") }
        parts.append(preview)
        if let ts = summary.lastTimestamp { parts.append(ts.shortRelative) }
        if !summary.isEncrypted { parts.append("not encrypted") }
        parts.append(summary.isDirect ? "direct chat" : "group")
        return parts.joined(separator: ", ")
    }
}

struct InviteRow: View {
    let summary: RoomSummary
    let session: SessionModel
    @Binding var error: String?
    @Environment(\.lumen) private var c

    var body: some View {
        VStack(alignment: .leading, spacing: LumenDimens.space3) {
            HStack(spacing: LumenDimens.space3) {
                AvatarView(name: summary.name, size: 44, ring: true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(c.text)
                        .lineLimit(2)
                    Text(summary.inviterId.map { "\($0) invited you" } ?? "You're invited")
                        .font(.footnote)
                        .foregroundStyle(c.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: LumenDimens.space2) {
                    acceptButton
                    declineButton
                    blockButton
                    Spacer(minLength: 0)
                }
                VStack(alignment: .leading, spacing: LumenDimens.space2) {
                    acceptButton
                    declineButton
                    blockButton
                }
            }
        }
        .padding(.vertical, LumenDimens.space2)
        .accessibilityElement(children: .contain)
    }

    private var acceptButton: some View {
        AsyncButton {
            do { try await RoomActions(client: session.client).accept(roomId: summary.id) }
            catch { self.error = "The invitation couldn't be accepted. Check your connection and try again." }
        } label: { Text("Accept") }
        .buttonStyle(ChipButtonStyle(prominent: true))
    }

    private var declineButton: some View {
        AsyncButton {
            do { try await RoomActions(client: session.client).decline(roomId: summary.id) }
            catch { self.error = "The invitation couldn't be declined. Check your connection and try again." }
        } label: { Text("Decline") }
        .buttonStyle(ChipButtonStyle())
    }

    @ViewBuilder
    private var blockButton: some View {
        if let inviter = summary.inviterId {
            AsyncButton(role: .destructive) {
                do {
                    try await RoomActions(client: session.client).decline(roomId: summary.id)
                    try await session.ignore(userId: inviter)
                } catch { self.error = "That didn't go through. Check your connection and try again." }
            } label: { Text("Block") }
            .buttonStyle(ChipButtonStyle())
            .accessibilityHint("Declines and blocks \(inviter)")
        }
    }
}

/// Opening a link always asks first (integration.md §8).
struct ConfirmLinkView: View {
    let route: DeepLinkRoute
    let session: SessionModel
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.lumen) private var c
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: LumenDimens.space4) {
                    switch route {
                    case .room(let id, _, let via):
                        header(systemImage: "number", title: "Open this room?", subtitle: id)
                        Text("If you're not a member yet, you'll join it and its members will see you.")
                            .font(.subheadline)
                            .foregroundStyle(c.textMuted)
                            .multilineTextAlignment(.center)
                        AsyncButton {
                            do {
                                let roomId = id.hasPrefix("!") && session.roomList.room(id: id) != nil ? id : try await RoomActions(client: session.client).join(idOrAlias: id, via: via)
                                model.selectedRoomId = roomId
                                dismiss()
                            } catch { self.error = "The room couldn't be opened. You may need an invitation." }
                        } label: { Text("Open") }
                        .buttonStyle(PrimaryButtonStyle())
                    case .user(let id):
                        header(systemImage: "person.crop.circle.badge.plus", title: "Start a chat?", subtitle: id)
                        Text("Lumen creates an end-to-end encrypted direct chat and invites them.")
                            .font(.subheadline)
                            .foregroundStyle(c.textMuted)
                            .multilineTextAlignment(.center)
                        AsyncButton {
                            do {
                                model.selectedRoomId = try await RoomActions(client: session.client).startDirectMessage(with: id)
                                dismiss()
                            } catch { self.error = "The chat couldn't be started. Check your connection and try again." }
                        } label: { Text("Start chat") }
                        .buttonStyle(PrimaryButtonStyle())
                    default:
                        EmptyView()
                    }
                    if let error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(c.danger)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(LumenDimens.space5)
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
            }
            .background(c.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func header(systemImage: String, title: String, subtitle: String) -> some View {
        VStack(spacing: LumenDimens.space2) {
            Image(systemName: systemImage)
                .font(.title2.weight(.semibold))
                .foregroundStyle(c.accent)
                .frame(width: 56, height: 56)
                .background(Circle().fill(c.accentSoft))
                .accessibilityHidden(true)
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(c.text)
            Text(subtitle)
                .font(.subheadline.monospaced())
                .foregroundStyle(c.textMuted)
                .lineLimit(2)
                .truncationMode(.middle)
                .multilineTextAlignment(.center)
        }
    }
}
