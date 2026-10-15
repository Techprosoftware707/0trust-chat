import LumenCore
import SafariServices
import SwiftUI

/// Initials avatar (no network fetch: avatars would leak room/user metadata
/// to the media server on every render; the SDK's media cache is used where
/// images are shown).
struct AvatarView: View {
    let name: String
    var size: CGFloat = 40
    @Environment(\.lumen) private var c

    private var initials: String {
        let trimmed = name.trimmingCharacters(in: CharacterSet(charactersIn: "@#!"))
        return String(trimmed.prefix(1)).uppercased()
    }

    var body: some View {
        Text(initials.isEmpty ? "?" : initials)
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(c.accentContrast)
            .frame(width: size, height: size)
            .background(Circle().fill(LinearGradient(colors: [c.accent, c.accent3], startPoint: .topLeading, endPoint: .bottomTrailing)))
            .accessibilityHidden(true)
    }
}

/// A full-width status banner.
struct BannerView: View {
    enum Style { case info, warning, danger, success }
    let style: Style
    let systemImage: String
    let text: String
    var actionTitle: String?
    var action: (() -> Void)?
    @Environment(\.lumen) private var c

    var body: some View {
        HStack(alignment: .top, spacing: LumenDimens.space3) {
            Image(systemName: systemImage)
                .foregroundStyle(fg)
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(c.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.subheadline.weight(.semibold))
            }
        }
        .padding(LumenDimens.space3)
        .background(bg)
        .accessibilityElement(children: .combine)
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
            BannerView(style: .info, systemImage: "arrow.triangle.2.circlepath", text: banner.message, actionTitle: "Retry now", action: retry)
        case .error:
            BannerView(style: .danger, systemImage: "exclamationmark.icloud", text: banner.message, actionTitle: "Retry", action: retry)
        case .connectedAgain:
            BannerView(style: .success, systemImage: "checkmark.circle", text: banner.message)
        }
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
    let action: () async -> Void
    @ViewBuilder let label: () -> Label
    @State private var running = false

    var body: some View {
        Button {
            guard !running else { return }
            running = true
            Task {
                await action()
                running = false
            }
        } label: {
            if running {
                ProgressView().accessibilityLabel("Working")
            } else {
                label()
            }
        }
        .disabled(running)
    }
}

extension Date {
    var shortRelative: String {
        if Calendar.current.isDateInToday(self) { return formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(self) { return "Yesterday" }
        return formatted(.dateTime.day().month(.abbreviated))
    }
}
