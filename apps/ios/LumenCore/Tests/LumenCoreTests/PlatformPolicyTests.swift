import Foundation
import XCTest
import LumenCore

final class NotificationPolicyTests: XCTestCase {
    func testHiddenByDefaultShowsNothingAboutSenderRoomOrText() {
        XCTAssertEqual(NotificationPreview.default, .hidden)
        let n = NotificationRenderer.render(kind: .message(body: "secret plans"), senderName: "Alice", roomName: "Board", isDirect: false, preview: .hidden, appName: "Lumen")
        XCTAssertEqual(n, RenderedNotification(title: "Lumen", body: "New message"))
        XCTAssertFalse("\(n)".contains("Alice") || "\(n)".contains("Board") || "\(n)".contains("secret"))
    }

    func testSenderOnly() {
        let dm = NotificationRenderer.render(kind: .message(body: "secret"), senderName: "Alice", roomName: "Alice", isDirect: true, preview: .sender, appName: "Lumen")
        XCTAssertEqual(dm, RenderedNotification(title: "Alice", subtitle: "", body: "New message"))
        let group = NotificationRenderer.render(kind: .message(body: "secret"), senderName: "Alice", roomName: "Board", isDirect: false, preview: .sender, appName: "Lumen")
        XCTAssertEqual(group.subtitle, "Board")
        XCTAssertEqual(group.body, "New message")
    }

    func testSenderAndText() {
        let n = NotificationRenderer.render(kind: .message(body: "line1\nline2"), senderName: "Alice", roomName: nil, isDirect: true, preview: .senderAndText, appName: "Lumen")
        XCTAssertEqual(n.body, "line1 line2")
        let long = NotificationRenderer.render(kind: .message(body: String(repeating: "x", count: 500)), senderName: "A", roomName: nil, isDirect: true, preview: .senderAndText, appName: "L")
        XCTAssertEqual(long.body.count, NotificationRenderer.maxBodyLength)
        let utd = NotificationRenderer.render(kind: .encryptedUnreadable, senderName: "A", roomName: nil, isDirect: true, preview: .senderAndText, appName: "L")
        XCTAssertEqual(utd.body, "New message")
        let call = NotificationRenderer.render(kind: .call(video: true), senderName: "A", roomName: nil, isDirect: true, preview: .hidden, appName: "L")
        XCTAssertEqual(call.body, "Incoming video call")
        let noSender = NotificationRenderer.render(kind: .message(body: "x"), senderName: "  ", roomName: nil, isDirect: true, preview: .senderAndText, appName: "L")
        XCTAssertEqual(noSender.title, "L")
    }

    func testPushPayload() {
        XCTAssertEqual(PushPayload.parse(["room_id": "!r:x", "event_id": "$e", "unread_count": 3, "aps": [:]]), PushPayload(roomId: "!r:x", eventId: "$e", unreadCount: 3))
        XCTAssertNil(PushPayload.parse(["room_id": "r:x", "event_id": "$e"]))
        XCTAssertNil(PushPayload.parse(["room_id": "!r:x"]))
        XCTAssertEqual(PushPayload.parse(["room_id": "!r:x", "event_id": "$e", "unread_count": -1])?.unreadCount, nil)
    }

    func testPusherConfiguration() throws {
        let c = PusherConfiguration(appId: "io.lumen.secure.ios", deviceToken: Data([0x0a, 0xff, 0x00]), gatewayURL: URL(string: "https://m.example.com/_matrix/push/v1/notify")!)
        XCTAssertEqual(c.pushkey, "0aff00")
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(c.defaultPayloadJSON.utf8)) as? [String: Any])
        let aps = try XCTUnwrap(obj["aps"] as? [String: Any])
        XCTAssertEqual(aps["mutable-content"] as? Int, 1)
        XCTAssertEqual((aps["alert"] as? [String: Any])?["loc-key"] as? String, "NEW_MESSAGE")
    }

    func testPushAvailabilityNeverClaimsPushWithoutGateway() {
        let s = PushAvailability.evaluate(gatewayConfigured: false, permission: .granted, pusherRegistered: true, lastError: nil)
        XCTAssertEqual(s, .noGateway)
        XCTAssertTrue(s.explanation.contains("Calls do not ring"))
        XCTAssertEqual(PushAvailability.evaluate(gatewayConfigured: true, permission: .denied, pusherRegistered: false, lastError: nil), .permissionDenied)
        XCTAssertEqual(PushAvailability.evaluate(gatewayConfigured: true, permission: .granted, pusherRegistered: false, lastError: nil), .registering)
        XCTAssertEqual(PushAvailability.evaluate(gatewayConfigured: true, permission: .granted, pusherRegistered: true, lastError: nil), .active)
        XCTAssertEqual(PushAvailability.evaluate(gatewayConfigured: true, permission: .granted, pusherRegistered: true, lastError: "x"), .failed("x"))
    }

    func testPreferencesDefaultsAndTolerantDecoding() {
        let p = LumenPreferences.decode(nil)
        XCTAssertEqual(p.notificationPreview, .hidden)
        XCTAssertFalse(p.appLockEnabled)
        let partial = LumenPreferences.decode(Data(#"{"sendReadReceipts":false}"#.utf8))
        XCTAssertFalse(partial.sendReadReceipts)
        XCTAssertTrue(partial.sendTypingNotices)
        var q = LumenPreferences()
        q.notificationPreview = .senderAndText
        XCTAssertEqual(LumenPreferences.decode(q.encoded()), q)
    }

    func testStorePassphraseIsRandom32Bytes() {
        let a = StoredAccount.makeStorePassphrase()
        XCTAssertEqual(Data(base64Encoded: a)?.count, 32)
        XCTAssertNotEqual(a, StoredAccount.makeStorePassphrase())
    }
}

final class WidgetBridgeTests: XCTestCase {
    let filter = WidgetMessageFilter(widgetId: "w1")

    func testForwardsWidgetRequestsAndResponsesOnly() {
        let req = #"{"api":"fromWidget","widgetId":"w1","requestId":"r1","action":"send_event","data":{}}"#
        XCTAssertEqual(filter.classify(req), .forwardToDriver(req))
        let resp = #"{"api":"toWidget","widgetId":"w1","requestId":"r2","action":"capabilities","data":{},"response":{"capabilities":[]}}"#
        XCTAssertEqual(filter.classify(resp), .forwardToDriver(resp))
        // the driver's own toWidget request echoed back
        if case .drop = filter.classify(#"{"api":"toWidget","widgetId":"w1","requestId":"r3","action":"capabilities","data":{}}"#) {} else { XCTFail() }
        // fromWidget with a response (our own reply echoed back)
        if case .drop = filter.classify(#"{"api":"fromWidget","widgetId":"w1","requestId":"r1","action":"x","data":{},"response":{}}"#) {} else { XCTFail() }
        if case .drop = filter.classify(#"{"api":"fromWidget","widgetId":"OTHER","requestId":"r1","action":"x","data":{}}"#) {} else { XCTFail() }
        if case .drop = filter.classify("not json") {} else { XCTFail() }
        if case .drop = filter.classify("[1,2]") {} else { XCTFail() }
        if case .drop = filter.classify(#"{"api":"fromWidget","widgetId":"w1","action":"x"}"#) {} else { XCTFail("no requestId") }
        if case .drop = filter.classify(String(repeating: " ", count: WidgetMessageFilter.maxMessageBytes + 1)) {} else { XCTFail() }
    }

    func testCallStateIsConsumedAndAcknowledged() throws {
        let raw = #"{"api":"fromWidget","widgetId":"w1","requestId":"r9","action":"io.lumen.call_state","data":{"state":"connected","video":true,"muted":false,"e2ee":"encrypted"}}"#
        guard case .callState(let u, let reply) = filter.classify(raw) else { return XCTFail() }
        XCTAssertEqual(u, CallStateUpdate(state: .connected, video: true, muted: false, e2ee: .encrypted))
        let r = try XCTUnwrap(reply)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(r.utf8)) as? [String: Any])
        XCTAssertEqual(obj["requestId"] as? String, "r9")
        XCTAssertNotNil(obj["response"])

        let typed = #"{"type":"io.lumen.call_state","data":{"state":"reconnecting","e2ee":"waiting-for-key"}}"#
        guard case .callState(let u2, let reply2) = filter.classify(typed) else { return XCTFail() }
        XCTAssertEqual(u2.state, .reconnecting)
        XCTAssertEqual(u2.e2ee, .waitingForKey)
        XCTAssertNil(reply2)
        if case .drop = filter.classify(#"{"type":"io.lumen.call_state","data":{"state":"bogus"}}"#) {} else { XCTFail() }

        // Flat envelope, as the Android bridge accepts it.
        guard case .callState(let u3, nil) = filter.classify(#"{"type":"io.lumen.call_state","state":"connected","video":false,"muted":true,"e2ee":"decrypt-error"}"#) else { return XCTFail() }
        XCTAssertEqual(u3, CallStateUpdate(state: .connected, video: false, muted: true, e2ee: .decryptError))
        XCTAssertFalse(u3.e2ee.isEncrypted)
    }

    func testEncryptionLabelOnlyFromWidgetState() {
        XCTAssertEqual(CallEncryptionState.encrypted.label, "End-to-end encrypted")
        for s in [CallEncryptionState.waitingForKey, .decryptError, .notEncrypted, .unknown, .other("x")] {
            XCTAssertFalse(s.isEncrypted)
            XCTAssertNotEqual(s.label, "End-to-end encrypted")
        }
    }

    func testActionMessage() throws {
        let m = filter.actionMessage(.switchCamera)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(m.utf8)) as? [String: String])
        XCTAssertEqual(obj, ["type": "io.lumen.call_action", "action": "switch_camera"])
        XCTAssertNil(obj["api"], "not a widget-API message")
        XCTAssertEqual(CallAction.allCases.map(\.rawValue), ["hangup", "mute", "unmute", "video_on", "video_off", "switch_camera"])
    }

    func testPostMessageScriptCannotBreakOut() throws {
        let evil = #"{"a":"</script><script>alert(1)</script>","b":" ","c":"\");alert(1);//"}"#
        let script = try XCTUnwrap(JavaScriptBridge.postMessageScript(json: evil, targetOrigin: "lumen-widget://call"))
        XCTAssertTrue(script.hasPrefix("window.postMessage(JSON.parse(\""))
        XCTAssertTrue(script.hasSuffix(", \"lumen-widget://call\");"))
        XCTAssertFalse(script.contains("</script>"))
        XCTAssertFalse(script.contains("\u{2028}"))
        XCTAssertNil(JavaScriptBridge.postMessageScript(json: "alert(1)", targetOrigin: "x"))
        XCTAssertEqual(JavaScriptBridge.targetOrigin(expected: "lumen-widget://call", reported: "null"), "*")
        XCTAssertEqual(JavaScriptBridge.targetOrigin(expected: "lumen-widget://call", reported: "lumen-widget://call"), "lumen-widget://call")
        XCTAssertEqual(JavaScriptBridge.targetOrigin(expected: "lumen-widget://call", reported: nil), "lumen-widget://call")
        XCTAssertEqual(JavaScriptBridge.targetOrigin(expected: "https://app.example.com", reported: "https://evil.example"), "https://app.example.com")
    }

    func testWidgetURLTemplateUsesSDKPlaceholders() throws {
        let raw = WidgetURLTemplate.rawURL(source: .bundled, intent: .joinExisting, video: false, notify: .none)
        XCTAssertTrue(raw.hasPrefix("lumen-widget://call/index.html?"))
        for p in ["widgetId=$matrix_widget_id", "roomId=$matrix_room_id", "userId=$matrix_user_id",
                  "deviceId=$org.matrix.msc2873.matrix_device_id", "baseUrl=$org.matrix.msc4039.matrix_base_url",
                  "lang=$org.matrix.msc2873.client_language", "theme=$org.matrix.msc2873.client_theme",
                  "intent=join_existing", "video=false", "notify=none", "parentUrl=lumen%2Dwidget%3A%2F%2Fcall"] {
            XCTAssertTrue(raw.contains(p), "missing \(p) in \(raw)")
        }
        let server = WidgetSource.server(URL(string: "https://app.example.com/widget/call/")!)
        XCTAssertEqual(server.pageURL.absoluteString, "https://app.example.com/widget/call/index.html")
        XCTAssertEqual(server.origin, "https://app.example.com")
        XCTAssertEqual(WidgetSource.bundled.origin, "lumen-widget://call")
    }

    func testAssetResolverRefusesTraversal() {
        XCTAssertEqual(WidgetAssetResolver.relativePath(for: URL(string: "lumen-widget://call/index.html?x=1")!), "index.html")
        XCTAssertEqual(WidgetAssetResolver.relativePath(for: URL(string: "lumen-widget://call/")!), "index.html")
        XCTAssertEqual(WidgetAssetResolver.relativePath(for: URL(string: "lumen-widget://call/assets/app-1.js")!), "assets/app-1.js")
        XCTAssertNil(WidgetAssetResolver.relativePath(for: URL(string: "lumen-widget://call/../secret")!))
        XCTAssertNil(WidgetAssetResolver.relativePath(for: URL(string: "lumen-widget://call/%2e%2e/secret")!))
        XCTAssertNil(WidgetAssetResolver.relativePath(for: URL(string: "lumen-widget://call/.hidden")!))
        XCTAssertNil(WidgetAssetResolver.relativePath(for: URL(string: "lumen-widget://other/index.html")!))
        XCTAssertNil(WidgetAssetResolver.relativePath(for: URL(string: "https://call/index.html")!))
        XCTAssertEqual(WidgetAssetResolver.mimeType(for: "a/b.js"), "text/javascript")
        XCTAssertEqual(WidgetAssetResolver.mimeType(for: "x.wasm"), "application/wasm")
    }
}

final class AppLockTests: XCTestCase {
    func testColdStartLockedWhenEnabled() {
        XCTAssertTrue(AppLockState(enabled: true, timeout: .oneMinute).isLocked)
        XCTAssertFalse(AppLockState(enabled: false, timeout: .oneMinute).isLocked)
    }

    func testTimeout() {
        var s = AppLockState(enabled: true, timeout: .oneMinute)
        s.didAuthenticate()
        s.didEnterBackground(at: 100)
        XCTAssertFalse(s.willEnterForeground(at: 159))
        s.didEnterBackground(at: 200)
        XCTAssertTrue(s.willEnterForeground(at: 260))
        XCTAssertTrue(s.isLocked)
        s.didAuthenticate()
        XCTAssertFalse(s.isLocked)
    }

    func testImmediatelyAndClockGoingBackwards() {
        var s = AppLockState(enabled: true, timeout: .immediately)
        s.didAuthenticate()
        s.didEnterBackground(at: 10)
        XCTAssertTrue(s.isLocked)
        var t = AppLockState(enabled: true, timeout: .oneHour)
        t.didAuthenticate()
        t.didEnterBackground(at: 1000)
        XCTAssertTrue(t.willEnterForeground(at: 5), "monotonic clock reset (reboot) locks")
    }

    func testDisabledNeverLocks() {
        var s = AppLockState(enabled: true, timeout: .immediately)
        s.setEnabled(false)
        s.didEnterBackground(at: 0)
        XCTAssertFalse(s.willEnterForeground(at: 99999))
        s.lockNow()
        XCTAssertFalse(s.isLocked)
    }

    func testPrivacyCover() {
        XCTAssertTrue(PrivacyCover.shouldCover(sceneIsActive: false, isLocked: false))
        XCTAssertTrue(PrivacyCover.shouldCover(sceneIsActive: true, isLocked: true))
        XCTAssertFalse(PrivacyCover.shouldCover(sceneIsActive: true, isLocked: false))
    }
}

final class CallHistoryTests: XCTestCase {
    let me = "@me:x"
    func rec(_ sender: String, _ t: TimeInterval, declined: [String] = [], active: [String] = [], intent: String? = "audio") -> RtcNotificationRecord {
        RtcNotificationRecord(eventId: "$\(Int(t))", sender: sender, timestamp: Date(timeIntervalSince1970: t), callIntent: intent, declinedBy: declined, activeMembers: active, callStart: nil, isJoined: false)
    }

    func testOutcomes() {
        let h = CallHistoryBuilder.build([
            rec(me, 1),
            rec("@bob:x", 2, declined: [me]),
            rec("@bob:x", 3),
            rec(me, 4, declined: ["@bob:x"], intent: "video"),
            rec("@bob:x", 5, active: ["@bob:x"]),
        ], ownUserId: me)
        XCTAssertEqual(h.map(\.outcome), [.ongoing, .declinedByOthers, .missed, .declined, .outgoing])
        XCTAssertTrue(h[1].video)
    }

    func testRingPolicy() {
        let now = Date(timeIntervalSince1970: 1000)
        XCTAssertTrue(IncomingRingPolicy.shouldRing(sender: "@bob:x", ownUserId: me, isRing: true, sentAt: now.addingTimeInterval(-5), expiresAt: now.addingTimeInterval(30), now: now))
        XCTAssertFalse(IncomingRingPolicy.shouldRing(sender: me, ownUserId: me, isRing: true, sentAt: now, expiresAt: nil, now: now))
        XCTAssertFalse(IncomingRingPolicy.shouldRing(sender: "@bob:x", ownUserId: me, isRing: false, sentAt: now, expiresAt: nil, now: now))
        XCTAssertFalse(IncomingRingPolicy.shouldRing(sender: "@bob:x", ownUserId: me, isRing: true, sentAt: now.addingTimeInterval(-10), expiresAt: now.addingTimeInterval(-1), now: now))
        XCTAssertFalse(IncomingRingPolicy.shouldRing(sender: "@bob:x", ownUserId: me, isRing: true, sentAt: now.addingTimeInterval(-60), expiresAt: nil, now: now))
    }
}

final class DevicesAPITests: XCTestCase {
    func testListAndUIAFlow() async throws {
        let base = URL(string: "https://m.example.com")!
        let http = FakeHTTP([
            "GET https://m.example.com/_matrix/client/v3/devices": (200, #"{"devices":[{"device_id":"OLD","display_name":"Old","last_seen_ts":1000},{"device_id":"NEW","last_seen_ts":5000}]}"#),
            "DELETE https://m.example.com/_matrix/client/v3/devices/OLD": (401, #"{"session":"S1","flows":[{"stages":["m.login.sso"]}],"params":{}}"#),
        ])
        let api = DevicesAPI(http: http, homeserverURL: base, accessToken: { "tok" })
        let list = try await api.list()
        XCTAssertEqual(list.map(\.deviceId), ["NEW", "OLD"])
        XCTAssertEqual(http.requests.first?.headers["Authorization"], "Bearer tok")
        do {
            try await api.delete(deviceId: "OLD", uiaSession: nil)
            XCTFail("expected UIA")
        } catch let e as DevicesError {
            guard case .authRequired(let s, let url) = e else { return XCTFail("\(e)") }
            XCTAssertEqual(s, "S1")
            XCTAssertEqual(url.absoluteString, "https://m.example.com/_matrix/client/v3/auth/m.login.sso/fallback/web?session=S1")
        }
        let body = try XCTUnwrap(http.requests.last?.body)
        XCTAssertEqual(String(data: body, encoding: .utf8), "{}")
    }

    func testRenameAndPathEncoding() async throws {
        let http = FakeHTTP(["PUT https://m.example.com/_matrix/client/v3/devices/AB%2FC": (200, "{}")])
        let api = DevicesAPI(http: http, homeserverURL: URL(string: "https://m.example.com")!, accessToken: { "tok" })
        try await api.rename(deviceId: "AB/C", displayName: "Lumen on iPhone")
        let body = try XCTUnwrap(http.requests.last?.body)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["display_name": "Lumen on iPhone"])
    }

    func testPasswordOnlyUIAIsUnsupported() throws {
        let e = DevicesAPI.authError(fromBody: Data(#"{"session":"S","flows":[{"stages":["m.login.password"]}]}"#.utf8), homeserverURL: URL(string: "https://m.example.com")!)
        XCTAssertEqual(e, .unsupportedAuth(["m.login.password"]))
    }

    func testDeviceName() {
        XCTAssertEqual(DeviceDisplayName.make(brandShortName: "Lumen", deviceModel: "iPhone"), "Lumen on iPhone")
        XCTAssertEqual(DeviceDisplayName.make(brandShortName: " ", deviceModel: ""), "Lumen on iOS")
    }
}

final class LogRedactorTests: XCTestCase {
    func testRedactsSecretsAndIdentifiers() {
        let s = LogRedactor.redact("GET /x?access_token=syt_abc_123&loginToken=zzz Authorization: Bearer syt_secret user @alice:example.com room !abc:example.com event $abcdefghijkl")
        for leaked in ["syt_abc_123", "zzz", "syt_secret", "@alice", "!abc", "$abcdefghijkl"] {
            XCTAssertFalse(s.contains(leaked), "leaked \(leaked) in \(s)")
        }
        XCTAssertTrue(LogRedactor.redact(#"{"recovery_key":"EsTx abcd"}"#).contains("<redacted>"))
    }
}
