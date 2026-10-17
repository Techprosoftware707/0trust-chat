import LumenCore
import MatrixRustSDK
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct RoomView: View {
    let session: SessionModel
    @State private var model: TimelineModel
    @Environment(AppModel.self) private var app
    @Environment(\.lumen) private var c
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var composer = ""
    @State private var replyTo: MessageRow?
    @State private var editing: MessageRow?
    @State private var actionError: String?
    @State private var showInfo = false
    @State private var photoItem: PhotosPickerItem?
    @State private var importingFile = false
    @State private var sending = false
    @State private var reportTarget: MessageRow?
    @State private var reportReason = ""
    @State private var reported = false
    @State private var sentCount = 0
    @State private var reactionCount = 0
    @State private var failureCount = 0

    /// `draft`, `replyTo`, `editing` and `sending` seed the composer (DEBUG screenshots).
    init(session: SessionModel, model: TimelineModel, draft: String = "", replyTo: MessageRow? = nil, editing: MessageRow? = nil, sending: Bool = false) {
        self.session = session
        _model = State(initialValue: model)
        _composer = State(initialValue: draft)
        _replyTo = State(initialValue: replyTo)
        _editing = State(initialValue: editing)
        _sending = State(initialValue: sending)
    }

    var body: some View {
        VStack(spacing: 0) {
            if session.banner != nil || !model.identityWarnings.isEmpty {
                VStack(spacing: LumenDimens.space2) {
                    if let banner = session.banner {
                        ConnectionBannerView(banner: banner) { session.retrySync() }
                    }
                    ForEach(model.identityWarnings) { w in
                        IdentityWarningBanner(warning: w, model: model, error: $actionError)
                    }
                }
                .padding(.horizontal, LumenDimens.space3)
                .padding(.vertical, LumenDimens.space2)
            }
            timeline
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if !model.typingUserIds.isEmpty {
                    TypingIndicatorView(text: typingText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, LumenDimens.space4)
                        .padding(.vertical, LumenDimens.space2)
                        .transition(.opacity)
                }
                ComposerView(
                    text: $composer,
                    replyTo: $replyTo,
                    editing: $editing,
                    photoItem: $photoItem,
                    importingFile: $importingFile,
                    sending: sending,
                    isEncrypted: model.encryptionKnown && model.isEncrypted,
                    onSend: send,
                    onTyping: { typing in Task { await model.setTyping(typing) } }
                )
            }
        }
        .background(c.bg)
        .navigationTitle(model.roomName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button { showInfo = true } label: { titleView }
                    .buttonStyle(.plain)
                    .accessibilityLabel(titleAccessibility)
                    .accessibilityHint("Shows the people, calls and settings of this conversation")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if model.hasActiveCall {
                    Button {
                        app.calls.startCall(roomId: model.roomId, roomName: model.roomName, video: false)
                    } label: {
                        Label("Join", systemImage: "phone.fill")
                            .labelStyle(.titleAndIcon)
                            .font(.subheadline.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(c.success)
                    .accessibilityLabel("Join the call")
                } else {
                    Button {
                        app.calls.startCall(roomId: model.roomId, roomName: model.roomName, video: true)
                    } label: { Image(systemName: "video") }
                    .accessibilityLabel("Start a video call")
                    Button {
                        app.calls.startCall(roomId: model.roomId, roomName: model.roomName, video: false)
                    } label: { Image(systemName: "phone") }
                    .accessibilityLabel("Start a voice call")
                }
            }
        }
        .sheet(isPresented: $showInfo) { RoomInfoView(session: session, model: model).lumenTheme() }
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        .sensoryFeedback(.selection, trigger: reactionCount)
        .sensoryFeedback(.error, trigger: failureCount)
        .animation(reduceMotion ? nil : Animation.lumenEaseOut, value: model.typingUserIds)
        .task {
            let appModel = app
            model.preferences = { [weak appModel] in appModel?.preferences ?? LumenPreferences() }
            session.activeRoomId = model.roomId
            NotificationCoordinator.shared.clearDelivered(roomId: model.roomId)
            await model.start()
            await model.markAsRead()
        }
        .onDisappear {
            if session.activeRoomId == model.roomId { session.activeRoomId = nil }
            model.stop()
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task { await sendPhoto(item) }
        }
        .onChange(of: actionError) { _, error in
            if error != nil { failureCount += 1 }
        }
        .fileImporter(isPresented: $importingFile, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { Task { await sendFile(url) } }
        }
        .alert("That didn't work", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK") {}
        } message: { Text(actionError ?? "") }
        .alert("Report this message?", isPresented: Binding(get: { reportTarget != nil }, set: { if !$0 { reportTarget = nil } })) {
            TextField("Reason (optional)", text: $reportReason)
            Button("Report", role: .destructive) {
                guard let id = reportTarget?.eventId else { return }
                let reason = reportReason.trimmingCharacters(in: .whitespacesAndNewlines)
                reportReason = ""
                run {
                    try await model.report(eventId: id, reason: reason.isEmpty ? nil : reason)
                    reported = true
                }
            }
            Button("Cancel", role: .cancel) { reportReason = "" }
        } message: {
            Text("The report goes to your server's administrators. In an encrypted room they receive the message's ID and your reason, not its text. To stop seeing this person, block them from the room details.")
        }
        .alert("Thanks for reporting", isPresented: $reported) {
            Button("OK") {}
        } message: { Text("Your server's administrators have been notified.") }
    }

    // MARK: - Title

    private var titleView: some View {
        VStack(spacing: 1) {
            Text(model.roomName)
                .font(.headline)
                .foregroundStyle(c.text)
                .lineLimit(1)
            if model.encryptionKnown {
                HStack(spacing: 3) {
                    Image(systemName: model.isEncrypted ? "lock.fill" : "lock.open")
                    Text(model.isEncrypted ? "End-to-end encrypted" : "Not encrypted")
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(model.isEncrypted ? c.textMuted : c.warning)
                .lineLimit(1)
            }
        }
        .frame(maxWidth: 260)
        .contentShape(Rectangle())
    }

    private var titleAccessibility: String {
        guard model.encryptionKnown else { return model.roomName }
        return "\(model.roomName), \(model.isEncrypted ? "end-to-end encrypted" : "not encrypted")"
    }

    private var typingText: String {
        let names = model.typingNames
        switch names.count {
        case 0: return ""
        case 1: return "\(names[0]) is typing…"
        case 2: return "\(names[0]) and \(names[1]) are typing…"
        default: return "Several people are typing…"
        }
    }

    // MARK: - Timeline

    private struct LaidOutRow: Identifiable {
        let row: TimelineRow
        let grouping: BubbleGrouping
        var id: String { row.id }
    }

    /// Consecutive messages from the same person within five minutes form one run.
    private var laidOutRows: [LaidOutRow] {
        let rows = model.rows
        return rows.indices.map { i in
            LaidOutRow(row: rows[i], grouping: BubbleGrouping(
                withPrevious: i > 0 && Self.sameRun(rows[i - 1], rows[i]),
                withNext: i + 1 < rows.count && Self.sameRun(rows[i], rows[i + 1])))
        }
    }

    private static func sameRun(_ a: TimelineRow, _ b: TimelineRow) -> Bool {
        guard case .message(let x) = a.kind, case .message(let y) = b.kind else { return false }
        return x.sender == y.sender && abs(y.timestamp.timeIntervalSince(x.timestamp)) < 300
    }

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if model.reachedStart {
                        if model.loadError == nil && model.encryptionKnown {
                            ConversationStartCard(isEncrypted: model.isEncrypted, isDirect: model.isDirect)
                                .padding(.vertical, LumenDimens.space4)
                        }
                    } else {
                        ProgressView()
                            .padding(LumenDimens.space5)
                            .opacity(model.rows.isEmpty ? 0 : 1)
                            .onAppear { Task { await model.paginateBackwards() } }
                            .accessibilityLabel("Loading earlier messages")
                    }
                    ForEach(laidOutRows) { item in
                        rowView(item)
                            .padding(.top, item.grouping.withPrevious ? 2 : LumenDimens.space3)
                            .id(item.row.id)
                    }
                    Color.clear.frame(height: LumenDimens.space3).id("bottom")
                }
                .padding(.horizontal, LumenDimens.space3)
                .frame(maxWidth: 820)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.rows.last?.id) { _, _ in
                if reduceMotion {
                    proxy.scrollTo("bottom", anchor: .bottom)
                } else {
                    withAnimation(.lumenEaseOut) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                Task { await model.markAsRead() }
            }
            .overlay {
                if let e = model.loadError {
                    EmptyStateView(systemImage: "bubble.left.and.exclamationmark.bubble.right", title: "Messages didn't load", message: e)
                } else if model.rows.isEmpty && !model.reachedStart {
                    VStack(spacing: LumenDimens.space3) {
                        ProgressView()
                        Text("Loading messages…")
                            .font(.subheadline)
                            .foregroundStyle(c.textMuted)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder
    private func rowView(_ item: LaidOutRow) -> some View {
        switch item.row.kind {
        case .dateDivider(let d):
            Text(d.dayDividerLabel)
                .font(.caption.weight(.semibold))
                .foregroundStyle(c.textMuted)
                .padding(.horizontal, LumenDimens.space3)
                .padding(.vertical, 5)
                .background(Capsule().fill(c.surface2))
                .frame(maxWidth: .infinity)
                .padding(.vertical, LumenDimens.space2)
                .accessibilityAddTraits(.isHeader)
        case .readMarker:
            HStack(spacing: LumenDimens.space2) {
                Rectangle().fill(c.accent.opacity(0.5)).frame(height: 1)
                Text("New messages")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(c.accent)
                    .fixedSize()
                Rectangle().fill(c.accent.opacity(0.5)).frame(height: 1)
            }
            .padding(.vertical, LumenDimens.space1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("New messages below")
        case .timelineStart:
            EmptyView()
        case .state(let text):
            Text(text)
                .font(.caption)
                .foregroundStyle(c.textSubtle)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
                .frame(maxWidth: .infinity)
        case .call(let call):
            CallTimelineRow(row: call, ownUserId: session.userId) {
                app.calls.startCall(roomId: model.roomId, roomName: model.roomName, video: call.record.callIntent == "video")
            }
        case .message(let m):
            MessageBubbleView(
                message: m,
                media: session.media,
                isDirect: model.isDirect,
                grouping: item.grouping,
                onReply: { replyTo = m; editing = nil },
                onEdit: { editing = m; replyTo = nil; composer = m.plainText ?? "" },
                onReact: { key in
                    reactionCount += 1
                    run { try await model.toggleReaction(m.itemId, key: key) }
                },
                onDelete: { run { try await model.redact(m.itemId) } },
                onRetry: { run { try await model.retrySend(m.itemId) } },
                onCancelSend: { run { try await model.cancelSend(m.itemId) } },
                onReport: { reportTarget = m }
            )
        }
    }

    // MARK: - Actions

    private func run(_ op: @escaping () async throws -> Void) {
        Task {
            do { try await op() } catch { actionError = "Check your connection and try again." }
        }
    }

    private func send() {
        let text = composer
        let reply = replyTo
        let edit = editing
        composer = ""
        replyTo = nil
        editing = nil
        sentCount += 1
        Task {
            do {
                if let edit {
                    try await model.edit(edit.itemId, newText: text)
                } else {
                    try await model.send(text: text, replyTo: reply?.eventId)
                }
            } catch {
                composer = text
                actionError = "The message couldn't be queued. Your text is back in the composer."
            }
        }
    }

    private func sendPhoto(_ item: PhotosPickerItem) async {
        defer { photoItem = nil }
        sending = true
        defer { sending = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            let type = item.supportedContentTypes.first ?? .jpeg
            let ext = type.preferredFilenameExtension ?? "jpg"
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).\(ext)")
            try data.write(to: url, options: [.completeFileProtection])
            defer { try? FileManager.default.removeItem(at: url) }
            let size = UIImage(data: data)?.size
            try await model.sendFile(at: url, mimeType: type.preferredMIMEType, isImage: type.conforms(to: .image), width: size.map { UInt64($0.width) }, height: size.map { UInt64($0.height) }, caption: nil)
            sentCount += 1
        } catch {
            actionError = "The image couldn't be sent. Check your connection and try again."
        }
    }

    private func sendFile(_ picked: URL) async {
        sending = true
        defer { sending = false }
        let scoped = picked.startAccessingSecurityScopedResource()
        defer { if scoped { picked.stopAccessingSecurityScopedResource() } }
        do {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(picked.lastPathComponent)
            try? FileManager.default.removeItem(at: url)
            try FileManager.default.copyItem(at: picked, to: url)
            defer { try? FileManager.default.removeItem(at: url) }
            let type = UTType(filenameExtension: url.pathExtension)
            try await model.sendFile(at: url, mimeType: type?.preferredMIMEType, isImage: false, width: nil, height: nil, caption: nil)
            sentCount += 1
        } catch {
            actionError = "The file couldn't be sent. Check your connection and try again."
        }
    }
}

/// The top of a conversation: what encryption means here, in one calm card.
struct ConversationStartCard: View {
    let isEncrypted: Bool
    let isDirect: Bool
    @Environment(\.lumen) private var c

    var body: some View {
        VStack(spacing: LumenDimens.space2) {
            Image(systemName: isEncrypted ? "lock.shield.fill" : "lock.open")
                .font(.title2)
                .foregroundStyle(isEncrypted ? AnyShapeStyle(c.brandGradient) : AnyShapeStyle(c.warning))
                .accessibilityHidden(true)
            Text(isEncrypted ? "Messages are end-to-end encrypted" : "This conversation isn't encrypted")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(c.text)
            Text(isEncrypted
                 ? (isDirect ? "Only the two of you can read them. Not even the server can." : "Only people in this conversation can read them. Not even the server can.")
                 : "The server can read messages in this room.")
                .font(.footnote)
                .foregroundStyle(c.textMuted)
        }
        .multilineTextAlignment(.center)
        .padding(LumenDimens.space4)
        .frame(maxWidth: 360)
        .background(c.surface, in: RoundedRectangle(cornerRadius: LumenDimens.radiusLg, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: LumenDimens.radiusLg, style: .continuous).strokeBorder(c.border))
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

struct IdentityWarningBanner: View {
    let warning: IdentityWarning
    let model: TimelineModel
    @Binding var error: String?
    @State private var name: String?

    var body: some View {
        BannerView(style: warning.kind == .verifiedChanged ? .danger : .warning,
                   systemImage: "exclamationmark.shield",
                   text: warning.message(displayName: name ?? warning.userId),
                   actionTitle: warning.actionTitle,
                   action: {
                       Task {
                           do { try await model.resolve(warning) } catch { self.error = "The change couldn't be acknowledged. Try again in a moment." }
                       }
                   })
        .task { name = await model.displayName(of: warning.userId) }
    }
}

struct CallTimelineRow: View {
    let row: CallRow
    let ownUserId: String
    let join: () -> Void
    @Environment(\.lumen) private var c

    var body: some View {
        let entry = CallHistoryBuilder.build([row.record], ownUserId: ownUserId).first
        let outcome = entry?.outcome
        let tint: Color = outcome == .missed ? c.danger : (outcome == .ongoing ? c.success : c.accent)
        let soft: Color = outcome == .missed ? c.dangerSoft : (outcome == .ongoing ? c.successSoft : c.accentSoft)
        HStack(spacing: LumenDimens.space3) {
            Image(systemName: row.record.callIntent == "video" ? "video.fill" : "phone.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 36, height: 36)
                .background(Circle().fill(soft))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(outcome?.title ?? "Call")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(c.text)
                Text("\(row.senderName) · \(row.record.timestamp.formatted(date: .omitted, time: .shortened))")
                    .font(.caption)
                    .foregroundStyle(c.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: LumenDimens.space2)
            if !row.record.activeMembers.isEmpty && !row.record.isJoined {
                Button("Join", action: join)
                    .buttonStyle(ChipButtonStyle(prominent: true))
            }
        }
        .padding(LumenDimens.space3)
        .frame(maxWidth: 420)
        .background(c.surface, in: RoundedRectangle(cornerRadius: LumenDimens.radiusLg, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: LumenDimens.radiusLg, style: .continuous).strokeBorder(c.border))
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}
