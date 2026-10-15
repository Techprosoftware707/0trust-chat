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

struct LaunchView: View {
    @Environment(\.lumen) private var c
    var body: some View {
        VStack(spacing: LumenDimens.space5) {
            BrandMark(size: 72)
            ProgressView()
                .accessibilityLabel("Opening your session")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(c.bg)
    }
}

struct LaunchFailedView: View {
    let message: String
    @Environment(AppModel.self) private var model
    @Environment(\.lumen) private var c
    @State private var confirmReset = false

    var body: some View {
        VStack(spacing: LumenDimens.space4) {
            BrandMark(size: 64)
            Text(message)
                .multilineTextAlignment(.center)
                .foregroundStyle(c.text)
            AsyncButton { await model.retryLaunch() } label: { Text("Try again") }
                .buttonStyle(PrimaryButtonStyle())
            Button("Sign out on this device", role: .destructive) { confirmReset = true }
                .buttonStyle(SecondaryButtonStyle())
        }
        .padding(LumenDimens.space5)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(c.bg)
        .confirmationDialog("Delete this device's local data?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Delete local data", role: .destructive) { model.resetLocalData() }
        } message: {
            Text("Messages you can't recover with your recovery key or another device will no longer be readable here. The device stays listed in your account until you remove it from another device.")
        }
    }
}

/// Covers the content in the app switcher and while inactive.
struct PrivacyCoverView: View {
    @Environment(\.lumen) private var c
    var body: some View {
        ZStack {
            c.bg.ignoresSafeArea()
            BrandMark(size: 72)
        }
        .accessibilityLabel("Content hidden")
    }
}

struct LockView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.lumen) private var c

    var body: some View {
        VStack(spacing: LumenDimens.space5) {
            BrandMark(size: 72)
            Text("\(model.session?.brandShortName ?? "Lumen") is locked")
                .font(.title2.weight(.semibold))
                .foregroundStyle(c.text)
            AsyncButton { await model.unlock() } label: {
                Label("Unlock with \(Biometrics.label)", systemImage: "lock.open")
            }
            .buttonStyle(PrimaryButtonStyle())
            .frame(maxWidth: 360)
        }
        .padding(LumenDimens.space5)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(c.bg.ignoresSafeArea())
        .task { await model.unlock() }
    }
}
