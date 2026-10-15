import Foundation
import XCTest
import LumenCore

final class NativeRtcTests: XCTestCase {
    let base = URL(string: "https://matrix.example.com")!
    let room = "!call:example.com"
    let user = "@alice:example.com"
    let device = "DEVICEA"
    let secret = "syt_SECRET_ACCESS_TOKEN"
    let tokenURL = "https://matrix.example.com/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token"
    let transportsURL = "https://matrix.example.com/_matrix/client/unstable/org.matrix.msc4143/rtc/transports"

    func make(_ http: FakeHTTP) -> NativeRtcInterceptor {
        let s = secret
        return NativeRtcInterceptor(widgetId: "w1", roomId: room, userId: user, deviceId: device, homeserverURL: base, http: http, accessToken: { s })
    }

    func json(_ s: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
    }

    func getTokenRequest(room: String? = nil, member: String? = nil) -> String {
        let r = room ?? self.room
        let m = member ?? "\(user):\(device)"
        return #"{"api":"fromWidget","widgetId":"w1","requestId":"t1","action":"org.matrix.msc4533.rtc_livekit_get_token","data":{"room_id":"\#(r)","slot_id":"m.call#ROOM","member_id":"\#(m)"}}"#
    }

    let transportsRequest = #"{"api":"fromWidget","widgetId":"w1","requestId":"r1","action":"org.matrix.msc4515.get_rtc_transports","data":{}}"#
    let capsResponseWithToken = #"{"api":"toWidget","widgetId":"w1","requestId":"c1","action":"capabilities","data":{},"response":{"capabilities":["org.matrix.msc4533.rtc_livekit_get_token","org.matrix.msc4515.rtc_transports"]}}"#
    let capsResponseWithoutToken = #"{"api":"toWidget","widgetId":"w1","requestId":"c1","action":"capabilities","data":{},"response":{"capabilities":["org.matrix.msc4515.rtc_transports"]}}"#
    let notifyWithTransports = #"{"api":"toWidget","widgetId":"w1","requestId":"n1","action":"notify_capabilities","data":{"requested":[],"approved":["org.matrix.msc4515.rtc_transports","org.matrix.msc2762.receive.state_event:m.room.member"]}}"#
    let notifyWithoutTransports = #"{"api":"toWidget","widgetId":"w1","requestId":"n1","action":"notify_capabilities","data":{"requested":[],"approved":["org.matrix.msc2762.receive.state_event:m.room.member"]}}"#

    // MARK: routing

    func testRouting() {
        let n = make(FakeHTTP([:]))
        XCTAssertEqual(n.onFromWidget(getTokenRequest()), .intercepted(getTokenRequest()))
        XCTAssertEqual(n.onFromWidget(transportsRequest), .intercepted(transportsRequest))
        XCTAssertEqual(n.onFromWidget(#"{"api":"fromWidget","widgetId":"w1","requestId":"x","action":"send_event","data":{}}"#), .forward)
        XCTAssertEqual(n.onFromWidget(#"{"api":"fromWidget","widgetId":"w1","requestId":"x","action":"org.matrix.msc4533.rtc_livekit_get_token","data":{},"response":{}}"#), .forward, "responses go to the driver")
        XCTAssertEqual(n.onFromWidget(#"{"api":"fromWidget","widgetId":"OTHER","requestId":"x","action":"org.matrix.msc4515.get_rtc_transports","data":{}}"#), .forward)
        XCTAssertEqual(n.onFromWidget(#"{"api":"fromWidget","widgetId":"w1","requestId":"x","action":"org.matrix.msc4533.rtc_livekit_delegate_delayed_leave","data":{}}"#), .forward, "not granted; the driver rejects it")
        XCTAssertEqual(n.onFromWidget("not json"), .forward)
    }

    func testSupportedApiVersionsGetsMSC4533Once() {
        let n = make(FakeHTTP([:]))
        let raw = #"{"api":"fromWidget","widgetId":"w1","requestId":"v1","action":"supported_api_versions","data":{},"response":{"supported_versions":["0.0.1","org.matrix.msc4515"]}}"#
        let out = n.onToWidget(raw)
        let versions = (json(out)["response"] as? [String: Any])?["supported_versions"] as? [String]
        XCTAssertEqual(versions, ["0.0.1", "org.matrix.msc4515", "org.matrix.msc4533"])
        XCTAssertEqual(n.onToWidget(out), out, "idempotent")
        let other = #"{"api":"toWidget","widgetId":"w1","requestId":"s1","action":"send_to_device","data":{"type":"io.element.call.encryption_keys","content":{"keys":"x/y"}}}"#
        XCTAssertEqual(n.onToWidget(other), other, "other driver messages are passed byte for byte")
    }

    // MARK: capability gating

    func testTokenCapabilityGrantedOnlyIfRequested() async {
        let http = FakeHTTP([:])
        let n = make(http)
        // Not requested: not added to the approval and refused.
        _ = n.onFromWidget(capsResponseWithoutToken)
        let notified = n.onToWidget(notifyWithTransports)
        XCTAssertFalse(((json(notified)["data"] as? [String: Any])?["approved"] as? [String] ?? []).contains(NativeRtcInterceptor.getTokenAction))
        let answer = json(await n.answer(getTokenRequest()))
        XCTAssertEqual(((answer["response"] as? [String: Any])?["error"] as? [String: Any])?["message"] as? String, "Missing capability")
        XCTAssertTrue(http.requests.isEmpty, "no homeserver call without the capability")

        // Requested: added to the approval the driver sends.
        _ = n.onFromWidget(capsResponseWithToken)
        let approved = (json(n.onToWidget(notifyWithTransports))["data"] as? [String: Any])?["approved"] as? [String] ?? []
        XCTAssertEqual(approved.filter { $0 == NativeRtcInterceptor.getTokenAction }.count, 1)
        XCTAssertTrue(n.tokenGranted)
    }

    func testTransportsNeedTheDriverApproval() async {
        let http = FakeHTTP(["GET \(transportsURL)": (200, #"{"rtc_transports":[{"type":"livekit","url":"wss://rtc.example.com"}]}"#)])
        let n = make(http)
        _ = n.onToWidget(notifyWithoutTransports)
        let refused = json(await n.answer(transportsRequest))
        XCTAssertEqual(((refused["response"] as? [String: Any])?["error"] as? [String: Any])?["message"] as? String, "Missing capability")
        XCTAssertTrue(http.requests.isEmpty)
    }

    // MARK: answers

    func testTransportsAnsweredFromRawEndpoint() async throws {
        let http = FakeHTTP(["GET \(transportsURL)": (200, #"{"rtc_transports":[{"type":"livekit","url":"wss://rtc.example.com"},{"no_type":true},{"type":42}]}"#)])
        let n = make(http)
        _ = n.onToWidget(notifyWithTransports)
        let out = await n.answer(transportsRequest)
        let obj = json(out)
        XCTAssertEqual(obj["requestId"] as? String, "r1")
        let list = (obj["response"] as? [String: Any])?["rtc_transports"] as? [[String: String]]
        XCTAssertEqual(list ?? [], [["type": "livekit", "url": "wss://rtc.example.com"]], "Lumen's {type, url} passes verbatim; untyped entries dropped")
        XCTAssertEqual(http.requests.first?.headers["Authorization"], "Bearer \(secret)")
        XCTAssertFalse(out.contains(secret))

        let empty = make(FakeHTTP(["GET \(transportsURL)": (200, #"{"rtc_transports":[]}"#)]))
        _ = empty.onToWidget(notifyWithTransports)
        let e = json(await empty.answer(transportsRequest))
        XCTAssertNotNil((e["response"] as? [String: Any])?["error"])
    }

    func testTokenOnlyForOwnRoomAndOwnMember() async {
        let http = FakeHTTP(["POST \(tokenURL)": (200, #"{"url":"wss://rtc.example.com","jwt":"eyJ.sfu.jwt"}"#)])
        let n = make(http)
        _ = n.onFromWidget(capsResponseWithToken)
        _ = n.onToWidget(notifyWithTransports)

        for bad in [getTokenRequest(room: "!other:example.com"), getTokenRequest(member: "@alice:example.com:OTHERDEVICE"), getTokenRequest(member: "@mallory:example.com:DEVICEA")] {
            let r = json(await n.answer(bad))
            XCTAssertNotNil((r["response"] as? [String: Any])?["error"], bad)
        }
        let noBody = json(await n.answer(#"{"api":"fromWidget","widgetId":"w1","requestId":"t9","action":"org.matrix.msc4533.rtc_livekit_get_token","data":"x"}"#))
        XCTAssertEqual(((noBody["response"] as? [String: Any])?["error"] as? [String: Any])?["message"] as? String, "Invalid request body")
        XCTAssertTrue(http.requests.isEmpty, "refused requests never reach the homeserver")

        let out = await n.answer(getTokenRequest())
        let response = json(out)["response"] as? [String: String]
        XCTAssertEqual(response, ["url": "wss://rtc.example.com", "jwt": "eyJ.sfu.jwt"], "passed through unchanged")
        XCTAssertFalse(out.contains(secret), "the access token never reaches the widget")
        let req = http.requests.last
        XCTAssertEqual(req?.method, "POST")
        XCTAssertEqual(req?.url.absoluteString, tokenURL)
        XCTAssertEqual(req?.headers["Authorization"], "Bearer \(secret)")
        let sent = (try? JSONSerialization.jsonObject(with: req?.body ?? Data())) as? [String: String]
        XCTAssertEqual(sent, ["room_id": room, "slot_id": "m.call#ROOM", "member_id": "\(user):\(device)"], "request data sent verbatim")
    }

    func testHomeserverErrorsAreReportedWithoutTheToken() async {
        let http = FakeHTTP(["POST \(tokenURL)": (403, #"{"errcode":"M_FORBIDDEN","error":"not a member"}"#)])
        let n = make(http)
        _ = n.onFromWidget(capsResponseWithToken)
        let out = await n.answer(getTokenRequest())
        let err = (json(out)["response"] as? [String: Any])?["error"] as? [String: Any]
        let api = err?["matrix_api_error"] as? [String: Any]
        XCTAssertEqual(api?["http_status"] as? Int, 403)
        XCTAssertEqual((api?["response"] as? [String: String])?["errcode"], "M_FORBIDDEN")
        XCTAssertFalse(out.contains(secret))

        let noJwt = make(FakeHTTP(["POST \(tokenURL)": (200, #"{"url":"wss://rtc.example.com"}"#)]))
        _ = noJwt.onFromWidget(capsResponseWithToken)
        let e = json(await noJwt.answer(getTokenRequest()))
        XCTAssertEqual(((e["response"] as? [String: Any])?["error"] as? [String: Any])?["message"] as? String, "The homeserver returned no token")
    }

    func testDescribeTransports() {
        XCTAssertEqual(NativeRtcInterceptor.describeTransports(Data(#"{"rtc_transports":[{"type":"livekit","url":"wss://rtc.example.com"},{"type":"livekit","livekit_service_url":"https://lk.example"},{"type":"x"}]}"#.utf8)),
                       ["livekit: wss://rtc.example.com", "livekit: https://lk.example", "x"])
    }
}
