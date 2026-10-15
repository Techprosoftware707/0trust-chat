import LumenCore
import MatrixRustSDK
import PhotosUI
import QuickLook
import SwiftUI
import UIKit

struct MessageBubbleView: View {
    let message: MessageRow
    let client: Client
    var onReply: () -> Void
    var onEdit: () -> Void
    var onReact: (String) -> Void
    var onDelete: () -> Void
    var onRetry: () -> Void
    var onCancelSend: () -> Void
    @Environment(\.lumen) private var c
    @State private var confirmDelete = false

    private static let quickReactions = ["👍", "❤️", "😂", "🎉", "😮", "🙏"]

    /// Inline Markdown (bold, italics, code, links) as the web client renders it;
    /// the text is never used as a localisation key or format string.
    static func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    var body: some View {
        HStack(alignment: .bottom) {
            if message.isOwn { Spacer(minLength: 40) }
            VStack(alignment: message.isOwn ? .trailing : .leading, spacing: 4) {
                if !message.isOwn {
                    Text(message.senderName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(c.accent2)
                }
                VStack(alignment: .leading, spacing: 6) {
                    if let reply = message.reply {
                        VStack(alignment: .leading, spacing: 2) {
                            if !reply.senderName.isEmpty {
                                Text(reply.senderName).font(.caption.weight(.semibold))
                            }
                            Text(reply.text).font(.caption).lineLimit(2)
                        }
                        .foregroundStyle(c.textMuted)
                        .padding(6)
                        .overlay(alignment: .leading) { Rectangle().fill(c.accent).frame(width: 3) }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("In reply to \(reply.senderName): \(reply.text)")
                    }
                    content
                }
                .padding(.horizontal, LumenDimens.space3)
                .padding(.vertical, LumenDimens.space2)
                .background(
                    RoundedRectangle(cornerRadius: LumenDimens.radiusLg, style: .continuous)
                        .fill(message.isOwn ? c.bubbleOwn : c.bubbleOther)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: LumenDimens.radiusLg, style: .continuous)
                        .strokeBorder(c.border.opacity(message.isOwn ? 0 : 1))
                )
                if !message.reactions.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(message.reactions) { r in
                            Button { onReact(r.key) } label: {
                                Text("\(r.key) \(r.count)")
                                    .font(.caption)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Capsule().fill(r.includesMe ? c.accentSoft : c.surface2))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(r.key), \(r.count) \(r.count == 1 ? "reaction" : "reactions")\(r.includesMe ? ", including yours" : "")")
                            .accessibilityHint(r.includesMe ? "Removes your reaction" : "Adds your reaction")
                        }
                    }
                }
                metadata
            }
            if !message.isOwn { Spacer(minLength: 40) }
        }
        .contextMenu { menu }
        .accessibilityElement(children: .contain)
        .confirmationDialog("Delete this message?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete for everyone", role: .destructive, action: onDelete)
        } message: {
            Text("The message is removed for everyone in the room. Copies already on other people's devices may remain readable to them.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch message.body {
        case .text(let t), .notice(let t):
            Text(Self.markdown(t))
                .foregroundStyle(c.text)
                .textSelection(.enabled)
        case .emote(let t):
            Text("* \(message.senderName) \(t)").italic().foregroundStyle(c.text)
        case .attachment(let a, let caption):
            AttachmentView(attachment: a, client: client)
            if let caption, !caption.isEmpty { Text(caption).foregroundStyle(c.text) }
        case .redacted:
            Label("Message deleted", systemImage: "trash").font(.subheadline).foregroundStyle(c.textSubtle)
        case .unableToDecrypt(let why):
            Label(why, systemImage: "lock.trianglebadge.exclamationmark").font(.subheadline).foregroundStyle(c.warning)
        case .unsupported(let why):
            Text(why).font(.subheadline).foregroundStyle(c.textSubtle)
        }
    }

    private var metadata: some View {
        HStack(spacing: 4) {
            Text(message.timestamp.formatted(date: .omitted, time: .shortened))
            if message.isEdited { Text("· edited") }
            if let d = message.delivery {
                switch d {
                case .sending:
                    Image(systemName: "clock").accessibilityLabel(d.accessibilityLabel)
                case .sent:
                    Image(systemName: "checkmark").accessibilityLabel(d.accessibilityLabel)
                case .read:
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(c.accent).accessibilityLabel(d.accessibilityLabel)
                case .failed:
                    Button(action: onRetry) {
                        Label("Not sent. Retry", systemImage: "exclamationmark.circle")
                    }
                    .foregroundStyle(c.danger)
                    .accessibilityLabel(d.accessibilityLabel)
                }
            }
        }
        .font(.caption2)
        .foregroundStyle(c.textSubtle)
    }

    @ViewBuilder
    private var menu: some View {
        if message.canReply {
            Button(action: onReply) { Label("Reply", systemImage: "arrowshape.turn.up.left") }
        }
        Menu {
            ForEach(Self.quickReactions, id: \.self) { e in
                Button(e) { onReact(e) }
            }
        } label: { Label("React", systemImage: "face.smiling") }
        if let text = message.plainText {
            Button { UIPasteboard.general.string = text } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
        if message.isOwn && message.isEditable {
            Button(action: onEdit) { Label("Edit", systemImage: "pencil") }
        }
        if case .failed = message.delivery {
            Button(action: onRetry) { Label("Retry sending", systemImage: "arrow.clockwise") }
            Button(role: .destructive, action: onCancelSend) { Label("Discard", systemImage: "xmark") }
        }
        if message.isOwn, message.eventId != nil {
            Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }
        }
        if message.isOwn, !message.readBy.isEmpty {
            Text("Read by \(message.readBy.count)")
        }
    }
}

/// Images are fetched and decrypted by the SDK (`getMediaThumbnail` /
/// `getMediaFile`); files open in Quick Look from the SDK's temporary copy.
struct AttachmentView: View {
    let attachment: Attachment
    let client: Client
    @Environment(\.lumen) private var c
    @State private var image: UIImage?
    @State private var previewURL: URL?
    @State private var fileHandle: MediaFileHandle?
    @State private var loading = false
    @State private var failed = false

    var body: some View {
        Group {
            if attachment.kind == .image {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 260, maxHeight: 320)
                        .clipShape(RoundedRectangle(cornerRadius: LumenDimens.radiusMd))
                        .onTapGesture { Task { await openFile() } }
                        .accessibilityLabel("Image \(attachment.filename)")
                        .accessibilityAddTraits(.isButton)
                } else {
                    RoundedRectangle(cornerRadius: LumenDimens.radiusMd)
                        .fill(c.surface2)
                        .frame(width: 220, height: 160)
                        .overlay { failed ? AnyView(Image(systemName: "photo.badge.exclamationmark")) : AnyView(ProgressView()) }
                        .accessibilityLabel(failed ? "Image couldn't be loaded" : "Loading image")
                }
            } else {
                Button { Task { await openFile() } } label: {
                    HStack {
                        Image(systemName: icon).font(.title2)
                        VStack(alignment: .leading) {
                            Text(attachment.filename).lineLimit(1)
                            if let size = attachment.size {
                                Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption).foregroundStyle(c.textMuted)
                            }
                        }
                        if loading { ProgressView() }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("File \(attachment.filename)")
                .accessibilityHint("Opens a preview")
            }
        }
        .task(id: attachment.filename) {
            guard attachment.kind == .image, image == nil else { return }
            let w = UInt64(min(attachment.width ?? 800, 800))
            let h = UInt64(min(attachment.height ?? 800, 800))
            do {
                let data: Data
                if let thumb = attachment.thumbnailSource {
                    data = try await client.getMediaContent(mediaSource: thumb)
                } else {
                    data = try await client.getMediaThumbnail(mediaSource: attachment.source, width: w, height: h)
                }
                image = UIImage(data: data)
                failed = image == nil
            } catch {
                failed = true
            }
        }
        .quickLookPreview($previewURL)
    }

    private var icon: String {
        switch attachment.kind {
        case .video: return "film"
        case .audio: return "waveform"
        default: return "doc"
        }
    }

    private func openFile() async {
        loading = true
        defer { loading = false }
        do {
            let handle = try await client.getMediaFile(mediaSource: attachment.source, filename: attachment.filename, mimeType: attachment.mimeType ?? "application/octet-stream", useCache: true, tempDir: nil)
            fileHandle = handle // keeps the temporary file alive while previewed
            previewURL = URL(fileURLWithPath: try handle.path())
        } catch {
            failed = true
        }
    }
}

struct ComposerView: View {
    @Binding var text: String
    @Binding var replyTo: MessageRow?
    @Binding var editing: MessageRow?
    @Binding var photoItem: PhotosPickerItem?
    @Binding var importingFile: Bool
    var sending: Bool
    var onSend: () -> Void
    var onTyping: (Bool) -> Void
    @Environment(\.lumen) private var c

    var body: some View {
        VStack(spacing: 0) {
            if let r = replyTo ?? editing {
                HStack {
                    Image(systemName: editing != nil ? "pencil" : "arrowshape.turn.up.left")
                    Text(editing != nil ? "Editing" : "Replying to \(r.senderName)").font(.caption.weight(.semibold))
                    Text(r.plainText ?? "").font(.caption).lineLimit(1)
                    Spacer()
                    Button {
                        replyTo = nil
                        if editing != nil { editing = nil; text = "" }
                    } label: { Image(systemName: "xmark.circle.fill") }
                    .accessibilityLabel(editing != nil ? "Cancel editing" : "Cancel reply")
                }
                .foregroundStyle(c.textMuted)
                .padding(.horizontal, LumenDimens.space3)
                .padding(.top, LumenDimens.space2)
            }
            HStack(alignment: .bottom, spacing: LumenDimens.space2) {
                Menu {
                    PhotosPicker(selection: $photoItem, matching: .images) { Label("Photo", systemImage: "photo") }
                    Button { importingFile = true } label: { Label("File", systemImage: "doc") }
                } label: {
                    Image(systemName: sending ? "hourglass" : "paperclip")
                        .font(.title3)
                        .frame(width: 36, height: 36)
                }
                .disabled(sending || editing != nil)
                .accessibilityLabel("Attach")

                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, LumenDimens.space3)
                    .padding(.vertical, LumenDimens.space2)
                    .background(c.surface, in: RoundedRectangle(cornerRadius: LumenDimens.radiusLg))
                    .overlay(RoundedRectangle(cornerRadius: LumenDimens.radiusLg).strokeBorder(c.border))
                    .onChange(of: text) { old, new in
                        if old.isEmpty != new.isEmpty { onTyping(!new.isEmpty) }
                    }
                    .accessibilityLabel("Message")

                Button(action: onSend) {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(editing != nil ? "Save edit" : "Send")
            }
            .padding(LumenDimens.space3)
        }
        .background(c.bgElevated)
    }
}
