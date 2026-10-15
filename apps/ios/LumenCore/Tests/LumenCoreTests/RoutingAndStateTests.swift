import Foundation
import XCTest
import LumenCore

final class DeepLinkTests: XCTestCase {
    func testSSOAttemptBuildsNonceRedirect() {
        let a = SSOAttempt(redirectBase: "io.lumen.secure:/sso-callback", nonce: "abc123")
        XCTAssertEqual(a.redirectURL, "io.lumen.secure:/sso-callback?n=abc123")
        let fresh = SSOAttempt(redirectBase: "io.lumen.secure:/sso-callback")
        XCTAssertEqual(fresh.nonce.count, 32)
        XCTAssertNotEqual(fresh.nonce, SSOAttempt(redirectBase: "x:/sso-callback").nonce)
    }

    func testCallbackIsSingleUseOnlyWithPendingAttempt() {
        let r = DeepLinkRouter(appScheme: "io.lumen.secure")
        let url = "io.lumen.secure:/sso-callback?n=abc123&loginToken=tok"
        XCTAssertEqual(r.route(url, pendingSsoNonce: nil), .reject)
        XCTAssertEqual(r.route(url, pendingSsoNonce: ""), .reject)
        XCTAssertEqual(r.route(url, pendingSsoNonce: "abc12"), .reject)
        guard case .ssoCallback(let t, let cb) = r.route(url, pendingSsoNonce: "abc123") else { return XCTFail() }
        XCTAssertEqual(t, "tok")
        XCTAssertEqual(cb.absoluteString, url)
    }

    func testWhiteLabelScheme() {
        let r = DeepLinkRouter(appScheme: "com.example.chat")
        XCTAssertEqual(r.route("io.lumen.secure:/sso-callback?n=a&loginToken=t", pendingSsoNonce: "a"), .reject)
        if case .ssoCallback = r.route("com.example.chat:/sso-callback?n=a&loginToken=t", pendingSsoNonce: "a") {} else { XCTFail() }
    }

    func testMatrixToDetails() {
        let r = DeepLinkRouter(appScheme: "io.lumen.secure")
        XCTAssertEqual(r.route("https://matrix.to/#/!abc:example.com/$ev1?via=example.com&via=other.org", pendingSsoNonce: nil),
                       .room(id: "!abc:example.com", eventId: "$ev1", via: ["example.com", "other.org"]))
        XCTAssertEqual(r.route("https://matrix.to/#/@alice:example.com/extra", pendingSsoNonce: nil), .reject)
        XCTAssertEqual(r.route("https://matrix.to:444/#/@alice:example.com", pendingSsoNonce: nil), .reject)
        XCTAssertEqual(r.route("https://u@matrix.to/#/@alice:example.com", pendingSsoNonce: nil), .reject)
        XCTAssertEqual(r.route("matrix:roomid/abc:example.com/e/ev2?via=example.com", pendingSsoNonce: nil),
                       .room(id: "!abc:example.com", eventId: "$ev2", via: ["example.com"]))
        XCTAssertEqual(r.route("matrix:u/al%20ice:example.com", pendingSsoNonce: nil), .reject)
    }

    func testWebAppAndPortalLinksOnlyForConfiguredHosts() {
        let r = DeepLinkRouter(appScheme: "io.lumen.secure", webAppHost: "app.example.com", portalHost: "example.com")
        XCTAssertEqual(r.route("https://app.example.com/#/room/%21abc%3Aexample.com", pendingSsoNonce: nil), .room(id: "!abc:example.com", eventId: nil, via: []))
        XCTAssertEqual(r.route("https://app.example.com/#/settings", pendingSsoNonce: nil), .reject)
        XCTAssertEqual(r.route("https://app.example.com/#/dm/%40bob%3Aexample.com", pendingSsoNonce: nil), .user(id: "@bob:example.com"))
        XCTAssertEqual(r.route("https://app.example.com/#/user/@bob:example.com", pendingSsoNonce: nil), .user(id: "@bob:example.com"))
        XCTAssertEqual(r.route("https://app.example.com/#/user/bob", pendingSsoNonce: nil), .reject)
        XCTAssertEqual(r.route("https://example.com/invite/AbC-123_x/", pendingSsoNonce: nil), .portalInvite(URL(string: "https://example.com/invite/AbC-123_x/")!))
        XCTAssertEqual(r.route("https://example.com/invite/../admin/", pendingSsoNonce: nil), .reject)
        XCTAssertEqual(r.route("https://evil.example/invite/abc/", pendingSsoNonce: nil), .reject)
        XCTAssertEqual(DeepLinkRouter(appScheme: "io.lumen.secure").route("https://app.example.com/#/room/!abc:example.com", pendingSsoNonce: nil), .reject)
    }

    func testMatrixIds() {
        XCTAssertTrue(MatrixID.isValidUserId("@alice:example.com"))
        XCTAssertFalse(MatrixID.isValidUserId("@alice"))
        XCTAssertFalse(MatrixID.isValidUserId("@al ice:example.com"))
        XCTAssertTrue(MatrixID.isValidRoomId("!opaque"))
        XCTAssertTrue(MatrixID.isValidRoomId("!abc:example.com"))
        XCTAssertFalse(MatrixID.isValidRoomId("!"))
        XCTAssertTrue(MatrixID.isValidRoomAlias("#lounge:example.com"))
        XCTAssertEqual(MatrixID.normaliseUserIdInput("bob", defaultServer: "example.com"), "@bob:example.com")
        XCTAssertEqual(MatrixID.normaliseUserIdInput(" @bob:other.org ", defaultServer: "example.com"), "@bob:other.org")
        XCTAssertNil(MatrixID.normaliseUserIdInput("b o b", defaultServer: "example.com"))
    }
}

final class DeliveryStateTests: XCTestCase {
    let me = "@me:example.com"

    func testLocalEchoIsSendingNeverDelivered() {
        XCTAssertEqual(DeliveryStateMapper.map(isOwn: true, isRemote: false, sendState: .notSentYet, receiptUserIds: ["@bob:example.com"], ownUserId: me), .sending)
        XCTAssertEqual(DeliveryStateMapper.map(isOwn: true, isRemote: false, sendState: nil, receiptUserIds: [], ownUserId: me), .sending)
    }

    func testServerAckIsSentAndOthersReceiptIsRead() {
        XCTAssertEqual(DeliveryStateMapper.map(isOwn: true, isRemote: false, sendState: .sent(eventId: "$e"), receiptUserIds: [], ownUserId: me), .sent)
        XCTAssertEqual(DeliveryStateMapper.map(isOwn: true, isRemote: true, sendState: nil, receiptUserIds: [me], ownUserId: me), .sent, "own receipt is not 'read'")
        XCTAssertEqual(DeliveryStateMapper.map(isOwn: true, isRemote: true, sendState: nil, receiptUserIds: [me, "@bob:example.com"], ownUserId: me), .read)
    }

    func testFailuresAndOthersMessages() {
        XCTAssertEqual(DeliveryStateMapper.map(isOwn: true, isRemote: false, sendState: .sendingFailed(isRecoverable: false), receiptUserIds: [], ownUserId: me), .failed(isRecoverable: false))
        XCTAssertNil(DeliveryStateMapper.map(isOwn: false, isRemote: true, sendState: nil, receiptUserIds: [], ownUserId: me))
        XCTAssertEqual(DeliveryState.sending.label, "Sending")
        XCTAssertFalse(DeliveryState.sending.accessibilityLabel.lowercased().contains("delivered"))
    }
}

final class ListDiffTests: XCTestCase {
    func testAllOperations() throws {
        var l = [1, 2, 3]
        try ListDiffApplier.apply([.append([4, 5]), .pushFront(0), .pushBack(6), .popFront, .popBack, .insert(1, 9), .set(0, 7), .remove(2), .truncate(3)], to: &l)
        XCTAssertEqual(l, [7, 9, 3])
        try ListDiffApplier.apply([.reset([1]), .clear, .append([2])], to: &l)
        XCTAssertEqual(l, [2])
    }

    func testOutOfRangeThrows() {
        var l = [1]
        XCTAssertThrowsError(try ListDiffApplier.apply([.remove(3)], to: &l))
        XCTAssertThrowsError(try ListDiffApplier.apply([.set(1, 0)], to: &l))
        XCTAssertThrowsError(try ListDiffApplier.apply([.insert(5, 0)], to: &l))
        var empty: [Int] = []
        XCTAssertThrowsError(try ListDiffApplier.apply([.popFront], to: &empty))
    }
}

final class ConnectionBannerTests: XCTestCase {
    func testBanners() {
        XCTAssertEqual(ConnectionBanner.from(sync: .running, networkReachable: false, syncIndicatorVisible: false, wasDisconnected: false), .offline)
        XCTAssertEqual(ConnectionBanner.from(sync: .offline, networkReachable: true, syncIndicatorVisible: false, wasDisconnected: false), .offline)
        XCTAssertEqual(ConnectionBanner.from(sync: .error, networkReachable: true, syncIndicatorVisible: false, wasDisconnected: false), .error)
        XCTAssertEqual(ConnectionBanner.from(sync: .running, networkReachable: true, syncIndicatorVisible: true, wasDisconnected: false), .reconnecting)
        XCTAssertNil(ConnectionBanner.from(sync: .running, networkReachable: true, syncIndicatorVisible: false, wasDisconnected: false))
        XCTAssertEqual(ConnectionBanner.from(sync: .running, networkReachable: true, syncIndicatorVisible: false, wasDisconnected: true), .connectedAgain)
        XCTAssertNil(ConnectionBanner.from(sync: .idle, networkReachable: true, syncIndicatorVisible: false, wasDisconnected: false))
    }
}

final class IdentityWarningTests: XCTestCase {
    func testWarningsFromStatusChanges() {
        var t = IdentityWarningTracker()
        t.apply([("@bob:x", .pinViolation), ("@carol:x", .verificationViolation), ("@me:x", .pinViolation), ("@dave:x", .verified)])
        let w = t.warnings(ownUserId: "@me:x")
        XCTAssertEqual(w.map(\.userId), ["@carol:x", "@bob:x"])
        XCTAssertEqual(w.first?.kind, .verifiedChanged)
        XCTAssertEqual(w.first?.actionTitle, "Withdraw verification")
        t.apply([("@bob:x", .pinned), ("@carol:x", .verified)])
        XCTAssertTrue(t.warnings(ownUserId: "@me:x").isEmpty)
        XCTAssertTrue(IdentityWarning(userId: "@bob:x", kind: .changed).message(displayName: "Bob").contains("Bob"))
    }
}

final class RecoveryKeyTests: XCTestCase {
    func testConfirmationIsWhitespaceInsensitive() {
        let shown = "EsTc 1234 abcd"
        XCTAssertTrue(RecoveryKeyFormat.matches(typed: "estc1234abcd".replacingOccurrences(of: "estc", with: "EsTc"), shown: shown))
        XCTAssertTrue(RecoveryKeyFormat.matches(typed: " EsTc\n1234  abcd ", shown: shown))
        XCTAssertFalse(RecoveryKeyFormat.matches(typed: "EsTc 1234 abce", shown: shown))
        XCTAssertFalse(RecoveryKeyFormat.matches(typed: "   ", shown: "   "))
        XCTAssertEqual(RecoveryKeyFormat.grouped("EsTc1234abcdXY"), "EsTc 1234 abcd XY")
    }
}
