import LumenCore
import MatrixRustSDK
import PhotosUI
import QuickLook
import SwiftUI
import UIKit

/// Where a message sits in a run of messages from the same sender: runs
/// share one name label, one avatar and tighter corners.
struct BubbleGrouping: Equatable {
    var withPrevious = false
    var withNext = false
}

struct MessageBubbleView: View {
    let message: MessageRow
    let media: MediaLoading
    /// Group rooms show names and avatars; direct chats don't need them.
    var isDirect = false
    var grouping = BubbleGrouping()
    var onReply: () -> Void
    var onEdit: () -> Void
    var onReact: (String) -> Void
    var onDelete: () -> Void
    var onRetry: () -> Void
    var onCancelSend: () -> Void
    var onReport: () -> Void
    @Environment(\.lumen) private var c
    @State private var confirmDelete = false

    private static let quickReactions = ["👍", "❤️", "😂", "🎉", "😮", "🙏"]
    private static let avatarSize: CGFloat = 30

    /// Inline Markdown (bold, italics, code, links) as the web client renders it;
    /// the text is never used as a localisation key or format string.
    static func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    private var showsPeople: Bool { !message.isOwn && !isDirect }
    private var showSender: Bool { showsPeople && !grouping.withPrevious }
    private var showAvatar: Bool { showsPeople && !grouping.withNext }
    private var showMetadata: Bool {
        if !grouping.withNext || message.isEdited { return true }
        switch message.delivery {
        case .sending?, .failed?: return true
        default: return false
        }
    }

    /// Images without a caption are shown on their own, without a bubble.
    private var isBareImage: Bool {
        if case .attachment(let a, let caption) = message.body, a.kind == .image, (caption ?? "").isEmpty { return true }
        return false
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: LumenDimens.space2) {
            if message.isOwn { Spacer(minLength: 48) }
            if showsPeople {
                Group {
                    if showAvatar {
                        AvatarView(name: message.senderName, size: Self.avatarSize)
                    } else {
                        Color.clear
                    }
                }
                .frame(width: Self.avatarSize, height: Self.avatarSize)
                .padding(.bottom, showMetadata ? 20 : 0)
            }
            VStack(alignment: message.isOwn ? .trailing : .leading, spacing: 4) {
                if showSender {
                    Text(message.senderName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SenderColor.color(for: message.sender, dark: c.isDark))
                        .lineLimit(1)
                        .padding(.horizontal, LumenDimens.space3)
                }
                bubble
                if !message.reactions.isEmpty {
                    reactions
                }
                if showMetadata {
                    metadata
                        .padding(.horizontal, LumenDimens.space2)
                }
            }
            .frame(maxWidth: 560, alignment: message.isOwn ? .trailing : .leading)
            if !message.isOwn { Spacer(minLength: 48) }
        }
        .contextMenu { menu }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
        .accessibilityActions { accessibilityActionList }
        .confirmationDialog("Delete this message?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete for everyone", role: .destructive, action: onDelete)
        } message: {
            Text("It's removed for everyone in the room. Copies already on other people's devices may stay readable to them.")
        }
    }

    private var bubbleShape: UnevenRoundedRectangle {
        let big = LumenDimens.radiusLg
        let small: CGFloat = 6
        if message.isOwn {
            return UnevenRoundedRectangle(topLeadingRadius: big, bottomLeadingRadius: big,
                                          bottomTrailingRadius: grouping.withNext ? small : big,
                                          topTrailingRadius: grouping.withPrevious ? small : big, style: .continuous)
        }
        return UnevenRoundedRectangle(topLeadingRadius: grouping.withPrevious ? small : big,
                                      bottomLeadingRadius: grouping.withNext ? small : big,
                                      bottomTrailingRadius: big, topTrailingRadius: big, style: .continuous)
    }

    @ViewBuilder
    private var bubble: some View {
        if isBareImage {
            content
                .clipShape(bubbleShape)
                .overlay(bubbleShape.stroke(c.border.opacity(0.6), lineWidth: 1))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if let reply = message.reply {
                    replyQuote(reply)
                }
                content
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(bubbleShape.fill(message.isOwn ? c.bubbleOwn : c.bubbleOther))
            .overlay(bubbleShape.stroke(message.isOwn ? Color.clear : c.border, lineWidth: 1))
        }
    }

    private func replyQuote(_ reply: ReplyPreview) -> some View {
        HStack(spacing: LumenDimens.space2) {
            Capsule().fill(c.accent).frame(width: 3)
            VStack(alignment: .leading, spacing: 2) {
                if !reply.senderName.isEmpty {
                    Text(reply.senderName).font(.caption.weight(.semibold)).foregroundStyle(c.accent)
                }
                Text(reply.text).font(.caption).foregroundStyle(c.textMuted).lineLimit(2)
            }
        }
        .padding(.vertical, 6)
        .padding(.leading, 6)
        .padding(.trailing, 10)
        .background(c.text.opacity(0.05), in: RoundedRectangle(cornerRadius: LumenDimens.radiusSm, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(reply.senderName.isEmpty ? "In reply to: \(reply.text)" : "In reply to \(reply.senderName): \(reply.text)")
    }

    @ViewBuilder
    private var content: some View {
        switch message.body {
        case .text(let t):
            Text(Self.markdown(t))
                .foregroundStyle(c.text)
                .textSelection(.enabled)
        case .notice(let t):
            Text(Self.markdown(t))
                .foregroundStyle(c.textMuted)
                .textSelection(.enabled)
        case .emote(let t):
            Text("* \(message.senderName) \(t)").italic().foregroundStyle(c.text)
        case .attachment(let a, let caption):
            AttachmentView(attachment: a, media: media)
            if let caption, !caption.isEmpty { Text(caption).foregroundStyle(c.text) }
        case .redacted:
            Label("Message deleted", systemImage: "trash")
                .font(.subheadline.italic())
                .foregroundStyle(c.textSubtle)
        case .unableToDecrypt(let why):
            Label {
                Text(why).font(.subheadline.italic())
            } icon: {
                Image(systemName: "lock").foregroundStyle(c.textSubtle)
            }
            .foregroundStyle(c.textMuted)
        case .unsupported(let why):
            Text(why).font(.subheadline.italic()).foregroundStyle(c.textMuted)
        }
    }

    private var reactions: some View {
        FlowLayout(spacing: 6) {
            ForEach(message.reactions) { r in
                Button { onReact(r.key) } label: {
                    HStack(spacing: 4) {
                        Text(r.key)
                        Text("\(r.count)").font(.caption.weight(.semibold)).monospacedDigit()
                            .foregroundStyle(r.includesMe ? c.accent : c.textMuted)
                    }
                    .padding(.horizontal, 9)
                    .frame(minHeight: 30)
                    .background(Capsule().fill(r.includesMe ? c.accentSoft : c.surface2))
                    .overlay(Capsule().strokeBorder(r.includesMe ? c.accent.opacity(0.55) : c.border))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(r.key), \(r.count) \(r.count == 1 ? "reaction" : "reactions")\(r.includesMe ? ", including yours" : "")")
                .accessibilityHint(r.includesMe ? "Removes your reaction" : "Adds your reaction")
            }
        }
    }

    private var metadata: some View {
        HStack(spacing: 4) {
            Text(message.timestamp.formatted(date: .omitted, time: .shortened)).monospacedDigit()
            if message.isEdited { Text("· Edited") }
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
                        Label("Not sent · Retry", systemImage: "exclamationmark.circle.fill")
                            .font(.caption.weight(.semibold))
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
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
        if !message.isOwn, message.eventId != nil {
            Button(role: .destructive, action: onReport) { Label("Report", systemImage: "flag") }
        }
        if message.isOwn, !message.readBy.isEmpty {
            Text("Read by \(message.readBy.count)")
        }
    }

    private var accessibilityText: String {
        var parts: [String] = [message.isOwn ? "You" : message.senderName]
        if let r = message.reply { parts.append(r.senderName.isEmpty ? "in reply" : "in reply to \(r.senderName)") }
        switch message.body {
        case .text(let t), .notice(let t): parts.append(t)
        case .emote(let t): parts.append(t)
        case .attachment(let a, let caption):
            parts.append(a.kind == .image ? "Image \(a.filename)" : "File \(a.filename)")
            if let caption, !caption.isEmpty { parts.append(caption) }
        case .redacted: parts.append("Message deleted")
        case .unableToDecrypt(let why): parts.append(why)
        case .unsupported(let why): parts.append(why)
        }
        parts.append(message.timestamp.formatted(date: .omitted, time: .shortened))
        if message.isEdited { parts.append("edited") }
        if let d = message.delivery { parts.append(d.accessibilityLabel) }
        if !message.reactions.isEmpty {
            parts.append(message.reactions.map { "\($0.key) \($0.count)" }.joined(separator: ", "))
        }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private var accessibilityActionList: some View {
        if message.canReply {
            Button("Reply", action: onReply)
        }
        ForEach(message.reactions) { r in
            Button(r.includesMe ? "Remove \(r.key) reaction" : "React with \(r.key)") { onReact(r.key) }
        }
        if let text = message.plainText {
            Button("Copy") { UIPasteboard.general.string = text }
        }
        if message.isOwn && message.isEditable {
            Button("Edit", action: onEdit)
        }
        if case .failed = message.delivery {
            Button("Retry sending", action: onRetry)
        }
        if message.isOwn, message.eventId != nil {
            Button("Delete") { confirmDelete = true }
        }
        if !message.isOwn, message.eventId != nil {
            Button("Report", action: onReport)
        }
    }
}

/// Stable, contrast-checked name colours for group conversations.
enum SenderColor {
    // At least 5.3:1 on the light background, 10:1 on the dark one.
    private static let light: [Color] = [LumenPalette.cyan700, LumenPalette.teal700, LumenPalette.violet700, LumenPalette.midnight600]
    private static let dark: [Color] = [LumenPalette.cyan300, LumenPalette.teal300, LumenPalette.violet300, LumenPalette.amber400]

    static func color(for userId: String, dark isDark: Bool) -> Color {
        let palette = isDark ? dark : light
        return palette[AvatarView.tintIndex(for: userId, count: palette.count)]
    }
}

/// Lays out its children in rows, wrapping when a row is full (reactions).
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > maxWidth {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: widest, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

/// Images are fetched and decrypted by the SDK (`getMediaThumbnail` /
/// `getMediaFile`); files open in Quick Look from the SDK's temporary copy.
struct AttachmentView: View {
    let attachment: Attachment
    let media: MediaLoading
    @Environment(\.lumen) private var c
    @State private var image: UIImage?
    @State private var previewURL: URL?
    @State private var fileHandle: AnyObject?
    @State private var loading = false
    @State private var failed = false

    /// Display size of an image: at most 280 x 340, keeping its aspect ratio.
    private var imageSize: CGSize {
        let w = CGFloat(attachment.width ?? 4)
        let h = CGFloat(attachment.height ?? 3)
        let ratio = max(0.3, min(3, w / max(h, 1)))
        let width: CGFloat = ratio >= 1 ? 280 : max(160, 340 * ratio)
        return CGSize(width: width, height: min(340, width / ratio))
    }

    var body: some View {
        Group {
            if attachment.kind == .image {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: imageSize.width, height: imageSize.height)
                        .clipped()
                        .contentShape(Rectangle())
                        .onTapGesture { Task { await openFile() } }
                        .accessibilityLabel("Image \(attachment.filename)")
                        .accessibilityAddTraits(.isButton)
                } else {
                    Rectangle()
                        .fill(c.surface2)
                        .frame(width: imageSize.width, height: imageSize.height)
                        .overlay {
                            if failed {
                                Label("Image unavailable", systemImage: "photo")
                                    .font(.footnote)
                                    .foregroundStyle(c.textMuted)
                            } else {
                                ProgressView()
                            }
                        }
                        .accessibilityLabel(failed ? "Image couldn't be loaded" : "Loading image")
                }
            } else {
                Button { Task { await openFile() } } label: {
                    HStack(spacing: LumenDimens.space3) {
                        Image(systemName: icon)
                            .font(.title3)
                            .foregroundStyle(c.accent)
                            .frame(width: 44, height: 44)
                            .background(c.accentSoft, in: RoundedRectangle(cornerRadius: LumenDimens.radiusSm, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(attachment.filename)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(c.text)
                                .lineLimit(2)
                                .truncationMode(.middle)
                            Text(detail)
                                .font(.caption)
                                .foregroundStyle(c.textMuted)
                        }
                        Spacer(minLength: 0)
                        if loading {
                            ProgressView()
                        } else {
                            Image(systemName: failed ? "exclamationmark.circle" : "arrow.down.circle")
                                .font(.title3)
                                .foregroundStyle(failed ? c.danger : c.textSubtle)
                        }
                    }
                    .frame(minWidth: 200, maxWidth: 300)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("File \(attachment.filename), \(detail)")
                .accessibilityHint("Opens a preview")
            }
        }
        .task(id: attachment.filename) {
            guard attachment.kind == .image, image == nil else { return }
            let w = UInt64(min(attachment.width ?? 800, 800))
            let h = UInt64(min(attachment.height ?? 800, 800))
            do {
                let data = try await media.imageData(for: attachment, maxWidth: w, maxHeight: h)
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
        case .video: return "play.rectangle.fill"
        case .audio: return "waveform"
        case .image: return "photo"
        case .file: return attachment.mimeType == "application/pdf" ? "doc.richtext" : "doc"
        }
    }

    private var detail: String {
        var parts: [String] = []
        if let size = attachment.size { parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)) }
        let ext = (attachment.filename as NSString).pathExtension.uppercased()
        if !ext.isEmpty && ext.count <= 5 { parts.append(ext) }
        return parts.isEmpty ? "File" : parts.joined(separator: " · ")
    }

    private func openFile() async {
        loading = true
        defer { loading = false }
        do {
            let file = try await media.file(for: attachment)
            fileHandle = file.keepAlive // keeps the temporary file alive while previewed
            previewURL = file.url
            failed = false
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
    var isEncrypted = true
    var onSend: () -> Void
    var onTyping: (Bool) -> Void
    @Environment(\.lumen) private var c
    @FocusState private var focused: Bool

    private var canSend: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            if let r = editing ?? replyTo {
                HStack(spacing: LumenDimens.space2) {
                    Capsule().fill(c.accent).frame(width: 3, height: 32)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(editing != nil ? "Editing message" : "Replying to \(r.senderName)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(c.accent)
                        Text(r.plainText ?? "Attachment")
                            .font(.caption)
                            .foregroundStyle(c.textMuted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Button {
                        replyTo = nil
                        if editing != nil { editing = nil; text = "" }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(c.textSubtle)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(editing != nil ? "Cancel editing" : "Cancel reply")
                }
                .padding(.leading, LumenDimens.space4)
                .padding(.trailing, LumenDimens.space1)
                .padding(.top, LumenDimens.space1)
            }
            HStack(alignment: .bottom, spacing: LumenDimens.space2) {
                Menu {
                    PhotosPicker(selection: $photoItem, matching: .images) { Label("Photo", systemImage: "photo") }
                    Button { importingFile = true } label: { Label("File", systemImage: "doc") }
                } label: {
                    ZStack {
                        Circle().fill(c.surface2)
                        if sending {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "plus")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(c.textMuted)
                        }
                    }
                    .frame(width: 36, height: 36)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                }
                .disabled(sending || editing != nil)
                .accessibilityLabel(sending ? "Sending attachment" : "Attach a photo or file")

                TextField(isEncrypted ? "Encrypted message" : "Message", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(minHeight: 44)
                    .background(c.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(focused ? c.accent.opacity(0.6) : c.border))
                    .onChange(of: text) { old, new in
                        if old.isEmpty != new.isEmpty { onTyping(!new.isEmpty) }
                    }
                    .accessibilityLabel(isEncrypted ? "Message, end-to-end encrypted" : "Message")

                Button(action: onSend) {
                    Image(systemName: editing != nil ? "checkmark" : "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(canSend ? c.accentContrast : c.textSubtle)
                        .frame(width: 36, height: 36)
                        .background {
                            if canSend {
                                Circle().fill(c.actionFill)
                            } else {
                                Circle().fill(c.surface3)
                            }
                        }
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .disabled(!canSend)
                .animation(.easeOut(duration: LumenMotion.durFast), value: canSend)
                .accessibilityLabel(editing != nil ? "Save edit" : "Send")
            }
            .padding(.horizontal, LumenDimens.space2)
            .padding(.vertical, 6)
        }
        .background(.bar)
        .overlay(alignment: .top) {
            Rectangle().fill(c.border).frame(height: 0.5)
        }
    }
}
