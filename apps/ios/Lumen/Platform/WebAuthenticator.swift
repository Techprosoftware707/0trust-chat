import AuthenticationServices
import UIKit

/// The system browser sheet (RFC 8252): the app never sees the password or
/// MFA codes. Ephemeral: no cookies are shared with Safari.
@MainActor
final class WebAuthenticator: NSObject, WebAuthenticating, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
            let completion: ASWebAuthenticationSession.CompletionHandler = { [weak self] callbackURL, error in
                self?.session = nil
                if let callbackURL {
                    cont.resume(returning: callbackURL)
                } else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    cont.resume(throwing: WebAuthenticationError.cancelled)
                } else {
                    cont.resume(throwing: WebAuthenticationError.failed(error?.localizedDescription ?? "Sign-in failed."))
                }
            }
            let s: ASWebAuthenticationSession
            if #available(iOS 17.4, *) {
                s = ASWebAuthenticationSession(url: url, callback: .customScheme(callbackScheme), completionHandler: completion)
            } else {
                s = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme, completionHandler: completion)
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = true
            session = s
            if !s.start() {
                session = nil
                cont.resume(throwing: WebAuthenticationError.failed("The sign-in page couldn't be opened."))
            }
        }
    }

    /// Opens a page that has no app callback (the UIA SSO fallback page) and
    /// returns when the user closes the sheet.
    func openUntilDismissed(url: URL, callbackScheme: String) async {
        _ = try? await authenticate(url: url, callbackScheme: callbackScheme)
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
            return window ?? ASPresentationAnchor()
        }
    }
}
