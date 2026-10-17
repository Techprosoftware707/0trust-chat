import LumenCore
import SafariServices
import SwiftUI

/// Initials avatar (no network fetch: avatars would leak room/user metadata
/// to the media server on every render). Each name gets a stable soft brand
/// tint; `ring` adds the brand-gradient ring.
struct AvatarView: View {
    let name: String
    var size: CGFloat = 40
    var ring = false
    @Environment(\.lumen) private var c

    private static let tints: [Color] = [
        LumenPalette.cyan300, LumenPalette.teal300, LumenPalette.violet300,
        LumenPalette.peach300, LumenPalette.amber400, LumenPalette.green400,
    ]

    /// A stable index for a name (the same person always gets the same tint).
    nonisolated static func tintIndex(for name: String, count: Int) -> Int {
        let hash = name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0x7fff_ffff }
        return hash % max(count, 1)
    }

    nonisolated static func initials(of name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let first = trimmed.first, "@#!".contains(first) {
            return String(trimmed.dropFirst().prefix(1)).uppercased()
        }
        let words = trimmed.split(whereSeparator: { $0.isWhitespace || $0 == "-" }).prefix(2)
        return words.compactMap { word in word.first.map { String($0) } }.joined().uppercased()
    }

    var body: some View {
        let initials = Self.initials(of: name)
        let tint = Self.tints[Self.tintIndex(for: name, count: Self.tints.count)]
        Text(initials.isEmpty ? "?" : initials)
            .font(.system(size: size * (initials.count > 1 ? 0.36 : 0.42), weight: .semibold, design: .rounded))
            .foregroundStyle(LumenPalette.midnight900)
            .frame(width: size, height: size)
            .background(Circle().fill(tint.gradient).opacity(c.isDark ? 0.88 : 1))
            .overlay {
                if ring {
                    Circle().strokeBorder(c.brandGradient, lineWidth: max(1.5, size * 0.04)).padding(-size * 0.09)
                }
            }
            .accessibilityHidden(true)
    }
}

/// A status card (connection, verification, warnings, errors).
struct BannerView: View {
    enum Style { case info, warning, danger, success }
    let style: Style
    let systemImage: String
    let text: String
    var actionTitle: String?
    var action: (() -> Void)?
    @Environment(\.lumen) private var c

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous)
        HStack(alignment: .center, spacing: LumenDimens.space3) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(fg)
                .frame(width: 32, height: 32)
                .background(Circle().fill(bg))
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(c.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(ChipButtonStyle())
            }
        }
        .padding(LumenDimens.space3)
        .background {
            shape.fill(c.surface)
            shape.fill(bg)
        }
        .overlay(shape.strokeBorder(fg.opacity(0.22)))
        .accessibilityElement(children: actionTitle == nil ? .combine : .contain)
    }

    private var fg: Color {
        switch style {
        case .info: return c.info
        case .warning: return c.warning
        case .danger: return c.danger
        case .success: return c.success
        }
    }

    private var bg: Color {
        switch style {
        case .info: return c.infoSoft
        case .warning: return c.warningSoft
        case .danger: return c.dangerSoft
        case .success: return c.successSoft
        }
    }
}

/// The connection banner from the real sync state.
struct ConnectionBannerView: View {
    let banner: ConnectionBanner
    var retry: () -> Void

    var body: some View {
        switch banner {
        case .offline:
            BannerView(style: .warning, systemImage: "wifi.slash", text: banner.message)
        case .reconnecting:
            BannerView(style: .info, systemImage: "arrow.triangle.2.circlepath", text: banner.message, actionTitle: "Retry", action: retry)
        case .error:
            BannerView(style: .danger, systemImage: "icloud.slash", text: banner.message, actionTitle: "Retry", action: retry)
        case .connectedAgain:
            BannerView(style: .success, systemImage: "checkmark.circle", text: banner.message)
        }
    }
}

/// A friendly empty state: a brand glyph, one sentence and at most one action.
struct EmptyStateView<Actions: View>: View {
    let systemImage: String
    let title: String
    let message: String
    @ViewBuilder var actions: () -> Actions
    @Environment(\.lumen) private var c

    var body: some View {
        VStack(spacing: LumenDimens.space4) {
            ZStack {
                Circle().fill(c.accentSoft)
                Circle().strokeBorder(c.brandGradient, lineWidth: 1.5).opacity(0.7)
                Image(systemName: systemImage)
                    .font(.system(size: 36, weight: .medium))
                    .foregroundStyle(c.brandGradient)
            }
            .frame(width: 92, height: 92)
            .accessibilityHidden(true)
            VStack(spacing: LumenDimens.space2) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(c.text)
                    .accessibilityAddTraits(.isHeader)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(c.textMuted)
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            actions()
        }
        .padding(LumenDimens.space6)
        .frame(maxWidth: 420)
    }
}

extension EmptyStateView where Actions == EmptyView {
    init(systemImage: String, title: String, message: String) {
        self.init(systemImage: systemImage, title: title, message: message, actions: { EmptyView() })
    }
}

/// Placeholder rows while the room list loads.
struct RoomListSkeleton: View {
    @Environment(\.lumen) private var c
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dimmed = false
    private let widths: [CGFloat] = [150, 190, 120, 170, 140, 200, 110, 160]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<widths.count, id: \.self) { i in
                HStack(spacing: LumenDimens.space3) {
                    Circle().fill(c.surface3).frame(width: 52, height: 52)
                    VStack(alignment: .leading, spacing: LumenDimens.space2) {
                        Capsule().fill(c.surface3).frame(width: widths[i], height: 12)
                        Capsule().fill(c.surface2).frame(maxWidth: .infinity).frame(height: 10)
                    }
                }
                .padding(.horizontal, LumenDimens.space5)
                .padding(.vertical, LumenDimens.space3)
            }
            Spacer(minLength: 0)
        }
        .opacity(dimmed ? 0.5 : 1)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dimmed = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading your conversations")
    }
}

/// "Maya is typing" with three soft dots.
struct TypingIndicatorView: View {
    let text: String
    @Environment(\.lumen) private var c
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var animating = false

    var body: some View {
        HStack(spacing: LumenDimens.space2) {
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(c.textSubtle)
                        .frame(width: 6, height: 6)
                        .opacity(reduceMotion ? 0.7 : (animating ? 1 : 0.3))
                        .animation(reduceMotion ? nil : Animation.easeInOut(duration: 0.6).repeatForever().delay(Double(i) * 0.2), value: animating)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 26)
            .background(Capsule().fill(c.bubbleOther))
            .overlay(Capsule().strokeBorder(c.border))
            Text(text)
                .font(.caption)
                .foregroundStyle(c.textMuted)
                .lineLimit(1)
        }
        .onAppear { animating = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// A small capsule label ("New", "This device", "Not encrypted").
struct CapsuleLabel: View {
    let text: String
    var systemImage: String?
    var tint: Color
    var background: Color

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(tint)
        .padding(.horizontal, LumenDimens.space2)
        .padding(.vertical, 3)
        .background(Capsule().fill(background))
    }
}

/// SFSafariViewController for portal pages (sign-up, account, help, privacy).
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.entersReaderIfAvailable = false
        let vc = SFSafariViewController(url: url, configuration: config)
        vc.dismissButtonStyle = .close
        return vc
    }

    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}

/// Identifiable URL for `.sheet(item:)`.
struct IdentifiedURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

/// A button that runs an async action and shows progress while it runs.
struct AsyncButton<Label: View>: View {
    var role: ButtonRole?
    let action: () async -> Void
    @ViewBuilder let label: () -> Label
    @State private var running = false

    init(role: ButtonRole? = nil, action: @escaping () async -> Void, @ViewBuilder label: @escaping () -> Label) {
        self.role = role
        self.action = action
        self.label = label
    }

    var body: some View {
        Button(role: role) {
            guard !running else { return }
            running = true
            Task {
                await action()
                running = false
            }
        } label: {
            ZStack {
                label().opacity(running ? 0 : 1)
                if running {
                    ProgressView().accessibilityLabel("Working")
                }
            }
        }
        .disabled(running)
    }
}

extension Date {
    /// Room list: the time today, "Yesterday", the weekday this week, else the date.
    var shortRelative: String {
        let cal = Calendar.current
        if cal.isDateInToday(self) { return formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(self) { return "Yesterday" }
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: self), to: cal.startOfDay(for: Date())).day ?? 99
        if days >= 0 && days < 7 { return formatted(.dateTime.weekday(.wide)) }
        if cal.isDate(self, equalTo: Date(), toGranularity: .year) { return formatted(.dateTime.day().month(.abbreviated)) }
        return formatted(.dateTime.day().month(.abbreviated).year())
    }

    /// Timeline day dividers: "Today", "Yesterday", "Tuesday", "Saturday 3 October", "3 October 2025".
    var dayDividerLabel: String {
        let cal = Calendar.current
        if cal.isDateInToday(self) { return "Today" }
        if cal.isDateInYesterday(self) { return "Yesterday" }
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: self), to: cal.startOfDay(for: Date())).day ?? 99
        if days >= 0 && days < 7 { return formatted(.dateTime.weekday(.wide)) }
        if cal.isDate(self, equalTo: Date(), toGranularity: .year) { return formatted(.dateTime.weekday(.wide).day().month(.wide)) }
        return formatted(.dateTime.day().month(.wide).year())
    }
}
