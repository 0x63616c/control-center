import AuthenticationServices
import Capacitor
import Foundation
import OSLog

@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]

    private let logger = Logger(subsystem: "co.worldwidewebb.textyourex", category: "AppleSignIn")
    private var activeCall: CAPPluginCall?
    private var activeController: ASAuthorizationController?

    @objc func authorize(_ call: CAPPluginCall) {
        guard activeCall == nil else {
            reject(call, code: "apple_sign_in_in_progress", message: "Apple sign-in is already in progress")
            return
        }

        let attemptId = call.getString("attemptId") ?? "attempt_unknown"

        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedOperation = .operationLogin
        request.requestedScopes = [.fullName, .email]

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self

        activeCall = call
        activeController = controller

        logger.info("Starting Apple sign-in attemptId=\(attemptId, privacy: .public)")
        controller.performRequests()
    }

    private func finish() {
        activeCall = nil
        activeController = nil
    }

    private func reject(_ call: CAPPluginCall, code: String, message: String, error: Error? = nil, data: [String: Any] = [:]) {
        call.reject(message, code, error, data)
    }
}

extension AppleSignInPlugin: ASAuthorizationControllerDelegate {
    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = activeCall else { return }

        let attemptId = call.getString("attemptId") ?? "attempt_unknown"
        let state = call.getString("state") ?? "state_unknown"
        let nonce = call.getString("nonce") ?? "nonce_unknown"

        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            logger.error("Apple sign-in returned an unexpected credential attemptId=\(attemptId, privacy: .public)")
            reject(call, code: "apple_sign_in_bad_credential", message: "Apple sign-in returned an unexpected credential")
            finish()
            return
        }

        guard let identityTokenData = credential.identityToken else {
            logger.error("Apple sign-in returned no identity token attemptId=\(attemptId, privacy: .public)")
            reject(call, code: "apple_sign_in_missing_identity_token", message: "Apple sign-in returned no identity token")
            finish()
            return
        }

        guard let identityToken = String(data: identityTokenData, encoding: .utf8) else {
            logger.error("Apple sign-in identity token was not UTF-8 attemptId=\(attemptId, privacy: .public)")
            reject(call, code: "apple_sign_in_bad_identity_token", message: "Apple sign-in identity token was not valid text")
            finish()
            return
        }

        let fullName = credential.fullName.flatMap { PersonNameComponentsFormatter().string(from: $0).trimmingCharacters(in: .whitespacesAndNewlines) }
        logger.info("Apple sign-in returned identity token attemptId=\(attemptId, privacy: .public) hasAuthorizationCode=\(credential.authorizationCode != nil, privacy: .public) hasFullName=\(fullName?.isEmpty == false, privacy: .public)")

        var response: [String: Any] = [
            "identityToken": identityToken,
            "hasAuthorizationCode": credential.authorizationCode != nil,
            "user": credential.user,
            "attemptId": attemptId,
            "state": credential.state ?? state,
            "nonce": nonce
        ]
        if let fullName, !fullName.isEmpty {
            response["fullName"] = fullName
        }
        call.resolve(response)
        finish()
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = activeCall else { return }

        let attemptId = call.getString("attemptId") ?? "attempt_unknown"
        let nsError = error as NSError
        let code = nsError.domain == ASAuthorizationError.errorDomain && nsError.code == ASAuthorizationError.canceled.rawValue
            ? "apple_sign_in_cancelled"
            : "apple_sign_in_native_failed"

        logger.error("Apple sign-in failed attemptId=\(attemptId, privacy: .public) domain=\(nsError.domain, privacy: .public) code=\(nsError.code, privacy: .public)")
        reject(call, code: code, message: nsError.localizedDescription, error: error, data: [
            "domain": nsError.domain,
            "nativeCode": nsError.code,
            "attemptId": attemptId
        ])
        finish()
    }
}

extension AppleSignInPlugin: ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
