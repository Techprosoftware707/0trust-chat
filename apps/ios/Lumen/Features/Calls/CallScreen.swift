import AVKit
import LumenCore
import SwiftUI
import UIKit
import WebKit

struct CallScreen: View {
    let coordinator: CallCoordinator
    @Environment(\.lumen) private var c
    @State private var speaker = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let call = coordinator.active {
                WidgetWebView(host: call.host)
                    .ignoresSafeArea(edges: .bottom)
                    .accessibilityLabel("Call view")
                VStack(spacing: 0) {
                    header(call)
                    Spacer()
                    controls
                }
            } else {
                ProgressView().tint(.white)
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden(false)
    }

    private func header(_ call: CallCoordinator.ActiveCall) -> some View {
        VStack(spacing: 4) {
            Text(call.roomName)
                .font(.headline)
                .foregroundStyle(.white)
            Text(stateLabel)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.8))
            let e2ee = coordinator.state?.e2ee ?? .unknown
            Label(e2ee.label, systemImage: e2ee.isEncrypted ? "lock.fill" : "lock.open")
                .font(.caption.weight(.semibold))
                .foregroundStyle(e2ee.isEncrypted ? LumenPalette.green400 : LumenPalette.amber400)
                .accessibilityLabel("Call encryption: \(e2ee.label)")
            Text(call.source.label)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.6))
        }
        .padding(LumenDimens.space3)
        .frame(maxWidth: .infinity)
        .background(.black.opacity(0.45))
        .accessibilityElement(children: .combine)
    }

    private var stateLabel: String {
        switch coordinator.state?.state {
        case .connecting?, nil: return "Connecting…"
        case .connected?: return "Connected"
        case .reconnecting?: return "Reconnecting…"
        case .ended?: return "Call ended"
        }
    }

    private var controls: some View {
        let muted = coordinator.state?.muted ?? false
        let video = coordinator.state?.video ?? false
        return HStack(spacing: LumenDimens.space4) {
            controlButton(muted ? "mic.slash.fill" : "mic.fill", label: muted ? "Unmute" : "Mute", active: muted) {
                coordinator.toggleMute()
            }
            controlButton(video ? "video.fill" : "video.slash.fill", label: video ? "Turn camera off" : "Turn camera on", active: !video) {
                coordinator.toggleVideo()
            }
            if video {
                controlButton("arrow.triangle.2.circlepath.camera", label: "Switch camera", active: false) {
                    coordinator.switchCamera()
                }
            }
            controlButton(speaker ? "speaker.wave.3.fill" : "speaker.fill", label: speaker ? "Speaker off" : "Speaker on", active: speaker) {
                speaker.toggle()
                CallKitController.setSpeaker(speaker)
            }
            RoutePickerView()
                .frame(width: 52, height: 52)
                .background(Circle().fill(.white.opacity(0.15)))
                .accessibilityLabel("Audio output: Bluetooth, AirPlay or this device")
            Button {
                coordinator.end()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.title2)
                    .foregroundStyle(.white)
                    .frame(width: 60, height: 60)
                    .background(Circle().fill(LumenPalette.red600))
            }
            .accessibilityLabel("End call")
        }
        .padding(LumenDimens.space4)
        .background(.black.opacity(0.45))
    }

    private func controlButton(_ symbol: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(active ? .black : .white)
                .frame(width: 52, height: 52)
                .background(Circle().fill(active ? Color.white : Color.white.opacity(0.15)))
        }
        .accessibilityLabel(label)
    }
}

/// Hosts the coordinator's WKWebView.
struct WidgetWebView: UIViewRepresentable {
    let host: CallWidgetHost

    func makeUIView(context: Context) -> WKWebView {
        host.isCallScreenVisible = true
        return host.webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

/// Bluetooth / AirPlay / receiver route selection.
struct RoutePickerView: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = .white
        v.activeTintColor = UIColor(LumenPalette.cyan400)
        v.prioritizesVideoDevices = false
        return v
    }

    func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}
