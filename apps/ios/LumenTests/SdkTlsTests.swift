import Foundation
import MatrixRustSDK
import XCTest

/// The Matrix Rust SDK makes its own HTTPS requests (its own HTTP client and TLS stack with
/// the platform's certificate verification), not through URLSession. On Android that stack
/// once failed every request; these tests make sure it works on iOS. They build a client
/// exactly as sign-in does (`ClientFactory.newClient`, native sliding-sync discovery, which
/// requests the server's /versions) against public servers: a trusted certificate must
/// work, an untrusted one must be refused. URLSession is the control: when it can't reach a
/// server either, the test is skipped, never passed. (The first run found that sign-in's
/// client could not be built at all: no session delegate with the multi-process lock.)
final class SdkTlsTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("lumen-tls-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
    }

    private func newClient(_ homeserver: String) async throws -> Client {
        let factory = ClientFactory(paths: StorePaths(root: root, isShared: false))
        return try await factory.newClient(homeserverURL: URL(string: homeserver)!, storeID: UUID().uuidString, passphrase: UUID().uuidString, store: NoAccountYet())
    }

    /// nil when URLSession got an HTTP response; otherwise its error.
    private func urlSessionError(_ url: String) async -> URLError? {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        do {
            _ = try await URLSession(configuration: config).data(from: URL(string: url)!)
            return nil
        } catch let error as URLError {
            return error
        } catch {
            return URLError(.unknown)
        }
    }

    /// Sign-in's state: the account is saved only after the login succeeds.
    private struct NoAccountYet: AccountStoring {
        func load() -> StoredAccount? { nil }
        func save(_ account: StoredAccount) throws {}
        func delete() throws {}
    }

    func testSdkConnectsToAServerWithAPubliclyTrustedCertificate() async throws {
        let server = "https://matrix-client.matrix.org"
        if let error = await urlSessionError(server + "/_matrix/client/versions") {
            throw XCTSkip("no network path to \(server) (URLSession: \(error.code.rawValue))")
        }
        do {
            let client = try await newClient(server)
            XCTAssertTrue(client.homeserver().hasPrefix(server), client.homeserver())
        } catch {
            XCTFail("the Rust SDK could not reach \(server), which URLSession can: \(error)")
        }
    }

    func testSdkRefusesAnUntrustedCertificate() async throws {
        let server = "https://self-signed.badssl.com"
        let control = await urlSessionError(server + "/")
        let certificateCodes: Set<URLError.Code> = [.serverCertificateUntrusted, .serverCertificateHasUnknownRoot, .serverCertificateHasBadDate, .serverCertificateNotYetValid, .secureConnectionFailed]
        guard let control, certificateCodes.contains(control.code) else {
            throw XCTSkip("\(server) did not present an untrusted certificate to URLSession (\(String(describing: control?.code.rawValue)))")
        }
        do {
            _ = try await newClient(server)
            XCTFail("the Rust SDK accepted a self-signed certificate")
        } catch {
            // The host answers URLSession, so a request that got no HTTP response at all failed
            // in the TLS handshake. ("error sending request" is the HTTP client's message for
            // that; a server that answered without being a Matrix server is a different error.)
            XCTAssertTrue(String(describing: error).contains("error sending request"), "expected a TLS refusal, got: \(error)")
        }
    }
}
