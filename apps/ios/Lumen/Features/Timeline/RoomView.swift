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
            if let banner = session.banner {
                ConnectionBannerView(banner: banner) { session.retrySync() }
            }
            ForEach(model.identityWarnings) { w in
                IdentityWarningBanner(warning: w, model: model, error: $actionError)
            }
            timeline
            if !model.typingUserIds.isEmpty {
                Text(typingText)
                    .font(.caption)
                    .foregroundStyle(c.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, LumenDimens.space4)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            ComposerView(
                text: $composer,
                replyTo: $replyTo,
                editing: $editing,
                photoItem: $photoItem,
                importingFile: $importingFile,
                sending: sending,
                onSend: send,
                onTyping: { typing in Task { await model.setTyping(typing) } }
            )
        }
        .background(c.bg)
        .navigationTitle(model.roomName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    app.calls.startCall(roomId: model.roomId, roomName: model.roomName, video: false)
                } label: { Image(systemName: "phone") }
                .accessibilityLabel(model.hasActiveCall ? "Join the call" : "Start a voice call")
                Button {
                    app.calls.startCall(roomId: model.roomId, roomName: model.roomName, video: true)
                } label: { Image(systemName: "video") }
                .accessibilityLabel(model.hasActiveCall ? "Join the call with video" : "Start a video call")
                Button { showInfo = true } label: { Image(systemName: "info.circle") }
                    .accessibilityLabel("Room details")
            }
        }
        .sheet(isPresented: $showInfo) { RoomInfoView(session: session, model: model).lumenTheme() }
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
        .fileImporter(isPresented: $importingFile, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { Task { await sendFile(url) } }
        }
        .alert("Something went wrong", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
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
        .alert("Reported", isPresented: $reported) {
            Button("OK") {}
        } message: { Text("Thank you. The server's administrators have been notified.") }
    }

    private var typingText: String {
        let n = model.typingUserIds.count
        return n == 1 ? "\(model.typingUserIds[0]) is typing…" : "\(n) people are typing…"
    }

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: LumenDimens.space2) {
                    if model.reachedStart {
                        Text(model.isEncrypted ? "Start of the conversation. Messages are end-to-end encrypted." : "Start of the conversation.")
                            .font(.footnote)
                            .foregroundStyle(c.textSubtle)
                            .padding()
                    } else {
                        ProgressView()
                            .padding()
                            .onAppear { Task { await model.paginateBackwards() } }
                            .accessibilityLabel("Loading earlier messages")
                    }
                    ForEach(model.rows) { row in
                        rowView(row).id(row.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, LumenDimens.space3)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: model.rows.last?.id) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                Task { await model.markAsRead() }
            }
            .overlay {
                if let e = model.loadError {
                    ContentUnavailableView("Couldn't load messages", systemImage: "exclamationmark.triangle", description: Text(e))
                }
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: TimelineRow) -> some View {
        switch row.kind {
        case .dateDivider(let d):
            Text(d.formatted(date: .complete, time: .omitted))
                .font(.caption.weight(.semibold))
                .foregroundStyle(c.textSubtle)
                .padding(.vertical, LumenDimens.space2)
                .accessibilityAddTraits(.isHeader)
        case .readMarker:
            HStack {
                Rectangle().fill(c.accent).frame(height: 1)
                Text("New").font(.caption2.weight(.bold)).foregroundStyle(c.accent)
                Rectangle().fill(c.accent).frame(height: 1)
            }
            .accessibilityLabel("New messages below")
        case .timelineStart:
            EmptyView()
        case .state(let text):
            Text(text)
                .font(.caption)
                .foregroundStyle(c.textSubtle)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        case .call(let call):
            CallTimelineRow(row: call, ownUserId: session.userId) {
                app.calls.startCall(roomId: model.roomId, roomName: model.roomName, video: call.record.callIntent == "video")
            }
        case .message(let m):
            MessageBubbleView(
                message: m,
                media: session.media,
                onReply: { replyTo = m; editing = nil },
                onEdit: { editing = m; replyTo = nil; composer = m.plainText ?? "" },
                onReact: { key in run { try await model.toggleReaction(m.itemId, key: key) } },
                onDelete: { run { try await model.redact(m.itemId) } },
                onRetry: { run { try await model.retrySend(m.itemId) } },
                onCancelSend: { run { try await model.cancelSend(m.itemId) } },
                onReport: { reportTarget = m }
            )
        }
    }

    private func run(_ op: @escaping () async throws -> Void) {
        Task {
            do { try await op() } catch { actionError = "That didn't work. Check your connection and try again." }
        }
    }

    private func send() {
        let text = composer
        let reply = replyTo
        let edit = editing
        composer = ""
        replyTo = nil
        editing = nil
        Task {
            do {
                if let edit {
                    try await model.edit(edit.itemId, newText: text)
                } else {
                    try await model.send(text: text, replyTo: reply?.eventId)
                }
            } catch {
                composer = text
                actionError = "The message couldn't be queued."
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
        } catch {
            actionError = "The image couldn't be sent."
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
        } catch {
            actionError = "The file couldn't be sent."
        }
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
                           do { try await model.resolve(warning) } catch { self.error = "The change couldn't be acknowledged." }
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
        HStack {
            Image(systemName: row.record.callIntent == "video" ? "video.fill" : "phone.fill")
                .foregroundStyle(entry?.outcome == .missed ? c.danger : c.accent)
            VStack(alignment: .leading) {
                Text(entry?.outcome.title ?? "Call").font(.subheadline.weight(.semibold))
                Text("\(row.senderName) · \(row.record.timestamp.shortRelative)").font(.caption).foregroundStyle(c.textMuted)
            }
            Spacer()
            if !row.record.activeMembers.isEmpty && !row.record.isJoined {
                Button("Join", action: join).buttonStyle(.borderedProminent)
            }
        }
        .lumenCard()
        .accessibilityElement(children: .combine)
    }
}
