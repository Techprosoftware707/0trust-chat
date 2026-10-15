import LumenCore
import MatrixRustSDK
import XCTest

/// Tests of the app's SDK-facing shared code. LumenTests is a logic-test
/// bundle without a host app: project.yml compiles Lumen/Shared/
/// {AppEnvironment,ClientFactory,NotificationMapping}.swift into it and links
/// the SDK once. It also runs all LumenCore tests, including
/// apps/shared/test-vectors.
final class AppLevelTests: XCTestCase {
    func testIncomingRingRoundTripsThroughVoIPPayload() {
        let ring = IncomingRing(roomId: "!r:example.com", eventId: "$e1", sender: "@bob:example.com", senderName: "Bob", roomName: "Bob", isVideo: true, sentAt: Date(timeIntervalSince1970: 1000), expiresAt: Date(timeIntervalSince1970: 1030))
        let decoded = IncomingRing(voipPayload: ring.voipPayload as [AnyHashable: Any])
        XCTAssertEqual(decoded, ring)
        XCTAssertNil(IncomingRing(voipPayload: ["room_id": "!r:x", "event_id": "$e", "sender": "@b:x"]), "only Lumen ring payloads are accepted")
        XCTAssertNil(IncomingRing(voipPayload: ["lumen_ring": 1, "room_id": "bad", "event_id": "$e", "sender": "@b:x"]))
    }

    func testVoIPPayloadCarriesNoMessageContent() {
        let ring = IncomingRing(roomId: "!r:x", eventId: "$e", sender: "@b:x", senderName: nil, roomName: nil, isVideo: false, sentAt: Date(), expiresAt: nil)
        XCTAssertEqual(Set(ring.voipPayload.keys), ["lumen_ring", "room_id", "event_id", "sender", "video", "sent_at"])
    }

    func testMessageTextForNotificationsAndPreviews() {
        XCTAssertEqual(MessageText.body(of: .text(content: TextMessageContent(body: "hi", formatted: nil))), "hi")
        XCTAssertEqual(MessageText.body(of: .emote(content: EmoteMessageContent(body: "waves", formatted: nil))), "* waves")
        XCTAssertEqual(MessageText.body(of: .other(msgtype: "x.custom", body: "fallback")), "fallback")
    }

    func testStoredAccountMapsToSDKSession() {
        let account = StoredAccount(userId: "@a:x", deviceId: "D", accessToken: "t", refreshToken: nil, homeserverURL: "https://m.x", oauthData: nil, slidingSyncVersion: "native", storeID: "s", storePassphrase: "p", serverName: "x", lumenAppJSON: nil)
        let s = account.sdkSession
        XCTAssertEqual(s.userId, "@a:x")
        XCTAssertEqual(s.slidingSyncVersion, .native)
        var copy = account
        copy.update(from: Session(accessToken: "t2", refreshToken: "r2", userId: "@a:x", deviceId: "D", homeserverUrl: "https://m.x", oauthData: nil, slidingSyncVersion: .native))
        XCTAssertEqual(copy.accessToken, "t2")
        XCTAssertEqual(copy.refreshToken, "r2")
        XCTAssertEqual(copy.storePassphrase, "p", "the store passphrase never changes on token refresh")
    }

    func testBuildConfigurationFromAppBundle() {
        let b = AppEnvironment.build
        XCTAssertFalse(b.bundleIdentifier.isEmpty)
        XCTAssertEqual(b.ssoRedirectBase, "\(b.urlScheme):/sso-callback")
        XCTAssertTrue(b.isDebug, "tests run against the Debug configuration")
        XCTAssertEqual(b.urlPolicy, .debug)
    }

    func testWidgetTemplateIsAcceptedBySDK() throws {
        // makeWidgetDriver parses the raw URL with the Rust url crate.
        let raw = WidgetURLTemplate.rawURL(source: .bundled, intent: .startCall, video: true, notify: .ring)
        XCTAssertNoThrow(try makeWidgetDriver(settings: WidgetSettings(widgetId: "w", initAfterContentLoad: true, rawUrl: raw)))
    }

    func testElementCallCapabilitiesCoverLumenCallEvents() {
        let caps = getElementCallRequiredPermissions(ownUserId: "@a:x", ownDeviceId: "D")
        XCTAssertTrue(caps.send.contains(.toDevice(eventType: "io.element.call.encryption_keys")))
        XCTAssertTrue(caps.send.contains(.messageLikeWithType(eventType: "org.matrix.msc4075.rtc.notification")))
        XCTAssertTrue(caps.read.contains(.stateWithType(eventType: "org.matrix.msc3401.call.member")))
        XCTAssertTrue(caps.sendDelayedEvent)
        XCTAssertTrue(caps.rtcTransports)
    }
}
