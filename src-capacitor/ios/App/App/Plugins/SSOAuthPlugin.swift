import Foundation
import Capacitor
import AuthenticationServices

/**
 * SSOAuthPlugin
 *
 * Wraps ASWebAuthenticationSession so iOS OAuth flows reliably return to the
 * app via the declared callback scheme. @capacitor/browser uses
 * SFSafariViewController which does NOT route custom-scheme redirects
 * (e.g. suissenotes://auth/callback) back to the originating app — Apple's
 * recommended fix is ASWebAuthenticationSession, which auto-dismisses when
 * the OAuth provider redirects to the callback scheme and delivers the URL
 * directly via a completion handler.
 *
 * Usage from JS:
 *   const { url } = await SSOAuth.startAuth({
 *     url: 'https://app.suisse-notes.ch/api/auth/microsoft/login?client=ios',
 *     callbackScheme: 'suissenotes'
 *   });
 *
 * Rejection codes:
 *   - 'USER_CANCELED' — user dismissed the auth sheet
 *   - any other reject — system error message
 */
@objc(SSOAuthPlugin)
public class SSOAuthPlugin: CAPPlugin, ASWebAuthenticationPresentationContextProviding {

    private var session: ASWebAuthenticationSession?

    @objc func startAuth(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let callbackScheme = call.getString("callbackScheme"),
              let url = URL(string: urlString) else {
            call.reject("Missing 'url' or 'callbackScheme'")
            return
        }

        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, error in
                self?.session = nil
                if let error = error {
                    let nsError = error as NSError
                    if nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        call.reject("USER_CANCELED")
                    } else {
                        call.reject(error.localizedDescription)
                    }
                    return
                }
                guard let callbackURL = callbackURL else {
                    call.reject("No callback URL received from auth session")
                    return
                }
                call.resolve(["url": callbackURL.absoluteString])
            }
            // Share cookies with Safari so the user does not have to re-enter
            // credentials for an IdP they already authenticated with in Safari.
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = self
            self.session = session
            session.start()
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
