import LumenCore
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.lumen) private var c

    var body: some View {
        @Bindable var model = model
        @Bindable var calls = model.calls
        ZStack {
            switch model.phase {
            case .launching:
                LaunchView()
            case .signedOut:
                ServerPickerView(auth: model.auth)
            case .signedIn(let session):
                HomeView(session: session)
            case .failed(let message):
                LaunchFailedView(message: message)
            }

            if model.lock.isLocked, model.session != nil {
                LockView()
                    .transition(.opacity)
            } else if PrivacyCover.shouldCover(sceneIsActive: model.sceneActive, isLocked: false), model.session != nil {
                PrivacyCoverView()
            }
        }
        .sensoryFeedback(.success, trigger: model.lock.isLocked) { wasLocked, isLocked in wasLocked && !isLocked }
        .animation(.easeOut(duration: LumenMotion.durMed), value: model.lock.isLocked)
        .fullScreenCover(isPresented: $calls.isPresented) {
            CallScreen(coordinator: model.calls)
                .lumenTheme()
        }
        .sheet(item: Binding(get: { model.pendingLink.map(PendingLink.init) }, set: { model.pendingLink = $0?.route })) { link in
            if let session = model.session {
                ConfirmLinkView(route: link.route, session: session)
                    .lumenTheme()
            }
        }
    }
}

struct PendingLink: Identifiable {
    let route: DeepLinkRoute
    var id: String {
        switch route {
        case .room(let id, _, _): return "room:\(id)"
        case .user(let id): return "user:\(id)"
        default: return "other"
        }
    }
}

/// Continues the launch screen (the 96 pt mark, centred on the page
/// background) while the session opens.
struct LaunchView: View {
    @Environment(\.lumen) private var c

    var body: some View {
        ZStack {
            c.bg.ignoresSafeArea()
            BrandMark(size: 96)
            ProgressView()
                .offset(y: 96)
                .accessibilityLabel("Opening your session")
        }
    }
}

struct LaunchFailedView: View {
    let message: String
    @Environment(AppModel.self) private var model
    @Environment(\.lumen) private var c
    @State private var confirmReset = false

    var body: some View {
        GeometryReader { geo in
        ScrollView {
            VStack(spacing: LumenDimens.space4) {
                BrandMarkHero(size: 64)
                    .padding(.bottom, LumenDimens.space2)
                Text("Lumen couldn't open")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(c.text)
                    .accessibilityAddTraits(.isHeader)
                Text(message)
                    .font(.body)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(c.textMuted)
                VStack(spacing: LumenDimens.space3) {
                    AsyncButton { await model.retryLaunch() } label: { Text("Try again") }
                        .buttonStyle(PrimaryButtonStyle())
                    Button("Sign out on this device", role: .destructive) { confirmReset = true }
                        .buttonStyle(SecondaryButtonStyle())
                }
                .padding(.top, LumenDimens.space2)
            }
            .padding(LumenDimens.space5)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity, minHeight: geo.size.height)
        }
        }
        .background { WelcomeBackground().ignoresSafeArea() }
        .confirmationDialog("Delete this device's local data?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Delete local data", role: .destructive) { model.resetLocalData() }
        } message: {
            Text("Messages you can't recover with your recovery key or another device will no longer be readable here. The device stays listed in your account until you remove it from another device.")
        }
    }
}

/// Covers the content in the app switcher and while inactive.
struct PrivacyCoverView: View {
    var body: some View {
        ZStack {
            WelcomeBackground().ignoresSafeArea()
            BrandMarkHero(size: 76)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Content hidden")
    }
}

struct LockView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.lumen) private var c

    private var kind: Biometrics.Kind { Biometrics.kind }

    private var symbol: String {
        switch kind {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        case .passcodeOnly, .unavailable: return "lock.open.fill"
        }
    }

    var body: some View {
        VStack(spacing: LumenDimens.space4) {
            Spacer(minLength: LumenDimens.space6)
            BrandMarkHero(size: 76)
            VStack(spacing: LumenDimens.space2) {
                Text("Welcome back")
                    .font(.title.weight(.bold))
                    .foregroundStyle(c.text)
                    .accessibilityAddTraits(.isHeader)
                Text("\(model.session?.brandShortName ?? "Lumen") is locked. Unlock to see your conversations.")
                    .font(.body)
                    .foregroundStyle(c.textMuted)
                    .multilineTextAlignment(.center)
            }
            Spacer(minLength: LumenDimens.space6)
            if kind == .unavailable {
                BannerView(style: .warning, systemImage: "lock.trianglebadge.exclamationmark",
                           text: "This device has no passcode right now, so Lumen can't be unlocked. Turn on a passcode in iOS Settings, then come back.")
            } else {
                AsyncButton { await model.unlock() } label: {
                    Label(kind == .passcodeOnly ? "Unlock with passcode" : "Unlock with \(Biometrics.label)", systemImage: symbol)
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(LumenDimens.space5)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { WelcomeBackground().ignoresSafeArea() }
        .task { await model.unlock() }
    }
}
