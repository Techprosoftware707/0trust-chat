import AVKit
import LumenCore
import SwiftUI
import UIKit
import WebKit

struct CallScreen: View {
    let coordinator: CallCoordinator
    @State private var speaker = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let call = coordinator.active {
                WidgetWebView(host: call.host)
                    .ignoresSafeArea(edges: .bottom)
                    .accessibilityLabel("Call view")
                CallChrome(
                    roomName: call.roomName,
                    sourceLabel: call.source.label,
                    state: coordinator.state,
                    speaker: $speaker,
                    onToggleMute: { coordinator.toggleMute() },
                    onToggleVideo: { coordinator.toggleVideo() },
                    onSwitchCamera: { coordinator.switchCamera() },
                    onSpeakerChanged: { CallKitController.setSpeaker($0) },
                    onEnd: { coordinator.end() }
                )
            } else {
                ProgressView().tint(.white)
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden(false)
    }
}

/// The call screen's header and controls over the widget. Driven by plain
/// values so it can be rendered without a call (DEBUG screenshots).
struct CallChrome: View {
    let roomName: String
    let sourceLabel: String
    let state: CallStateUpdate?
    @Binding var speaker: Bool
    var onToggleMute: () -> Void
    var onToggleVideo: () -> Void
    var onSwitchCamera: () -> Void
    var onSpeakerChanged: (Bool) -> Void
    var onEnd: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Spacer()
            controls
        }
        .environment(\.colorScheme, .dark)
    }

    private var header: some View {
        VStack(spacing: 6) {
            Text(roomName)
                .font(.headline)
                .foregroundStyle(.white)
                .lineLimit(1)
            Text(stateLabel)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.8))
            let e2ee = state?.e2ee ?? .unknown
            Label(e2ee.label, systemImage: e2ee.isEncrypted ? "lock.fill" : "lock.open")
                .font(.caption.weight(.semibold))
                .foregroundStyle(e2ee.isEncrypted ? LumenPalette.green400 : LumenPalette.amber400)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Capsule().fill(.black.opacity(0.35)))
                .accessibilityLabel("Call encryption: \(e2ee.label)")
            Text(sourceLabel)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.6))
                .lineLimit(1)
        }
        .padding(.horizontal, LumenDimens.space5)
        .padding(.vertical, LumenDimens.space3)
        .frame(maxWidth: 520)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: LumenDimens.radiusXl, style: .continuous))
        .padding(.horizontal, LumenDimens.space4)
        .padding(.top, LumenDimens.space2)
        .accessibilityElement(children: .combine)
    }

    private var stateLabel: String {
        switch state?.state {
        case .connecting?, nil: return "Connecting…"
        case .connected?: return "Connected"
        case .reconnecting?: return "Reconnecting…"
        case .ended?: return "Call ended"
        }
    }

    private var controls: some View {
        let muted = state?.muted ?? false
        let video = state?.video ?? false
        return HStack(spacing: 0) {
            controlButton(muted ? "mic.slash.fill" : "mic.fill", label: muted ? "Unmute" : "Mute", active: muted) {
                onToggleMute()
            }
            controlButton(video ? "video.fill" : "video.slash.fill", label: video ? "Turn camera off" : "Turn camera on", active: !video) {
                onToggleVideo()
            }
            if video {
                controlButton("arrow.triangle.2.circlepath.camera", label: "Switch camera", active: false) {
                    onSwitchCamera()
                }
            }
            controlButton(speaker ? "speaker.wave.3.fill" : "speaker.fill", label: speaker ? "Speaker off" : "Speaker on", active: speaker) {
                speaker.toggle()
                onSpeakerChanged(speaker)
            }
            RoutePickerView()
                .frame(width: 52, height: 52)
                .background(Circle().fill(.white.opacity(0.15)))
                .frame(maxWidth: .infinity)
                .accessibilityLabel("Audio output: Bluetooth, AirPlay or this device")
            Button {
                onEnd()
            } label: {
                Image(systemName: "phone.down.fill")
                    .font(.title2)
                    .foregroundStyle(.white)
                    .frame(width: 60, height: 60)
                    .background(Circle().fill(LumenPalette.red600))
            }
            .frame(maxWidth: .infinity)
            .accessibilityLabel("End call")
        }
        .padding(.horizontal, LumenDimens.space2)
        .padding(.vertical, LumenDimens.space3)
        .frame(maxWidth: 520)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.horizontal, LumenDimens.space3)
        .padding(.bottom, LumenDimens.space3)
    }

    private func controlButton(_ symbol: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(active ? .black : .white)
                .frame(width: 52, height: 52)
                .background(Circle().fill(active ? Color.white : Color.white.opacity(0.15)))
                .contentShape(Circle())
        }
        .frame(maxWidth: .infinity)
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
