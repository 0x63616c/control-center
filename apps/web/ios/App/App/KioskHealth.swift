import Foundation

// Pure, UIKit-free core of the kiosk recovery watchdog (www-bwoy).
//
// The wall panel is an unattended Capacitor shell pointed at the hosted
// dashboard. When Cloudflare can't reach the origin it serves an error page
// (e.g. "Error 1033: Argo Tunnel error", HTTP 530) which WKWebView renders as
// a normal successful load , so the panel sticks on the error page forever and
// only a manual force-quit recovers it. This type holds the decisions the
// watchdog makes; keeping it free of UIKit/WebKit lets it be unit-tested with
// plain swiftc (see scripts/test-kiosk-health.sh).
enum KioskHealth {
    // Origin-down classification. Only 5xx (which covers every Cloudflare
    // tunnel/origin code , 520-527, 530) and "no response" (status 0) mean the
    // origin is unreachable and a reload is worth attempting. A 4xx is the app
    // itself answering, not the origin being down, so reloading it would just
    // loop; treat it as healthy for recovery purposes.
    static func isHealthy(httpStatus: Int) -> Bool {
        httpStatus >= 200 && httpStatus < 500
    }

    // Cloudflare serves its error page with a 5xx status, but WKWebView renders
    // it as a normal load and fires no navigation failure , so we also sniff the
    // loaded document for CF's stable error markers. These strings appear on CF's
    // error templates and not on the real dashboard.
    private static let cloudflareMarkers = [
        "cf-error-details",
        "cf-error-code",
        "cf-wrapper",
        "argo tunnel error",
        "web server is down",
        "error 1033",
        "error 520",
        "error 521",
        "error 522",
        "error 523",
        "error 524",
        "error 525",
        "error 526",
        "error 530",
    ]

    static func looksLikeCloudflareError(html: String) -> Bool {
        if html.isEmpty { return false }
        let haystack = html.lowercased()
        return cloudflareMarkers.contains { haystack.contains($0) }
    }

    // Cloudflare Access login interstitial markers (www-cuuw). Once `dashboard` is
    // gated behind CF Access and the WKWebView's CF_Authorization cookie expires,
    // the loaded document is the Access LOGIN page , NOT a CF error page (so
    // looksLikeCloudflareError is false) and with no React #root (so the blank
    // sniff would fire). Crucially the watchdog's header-less probe gets a 302 to
    // this page, which isHealthy(302) calls "healthy" , so a header-less reload
    // just re-renders the wall in a tight loop. We must positively recognize this
    // page as a THIRD state ("session expired -> re-navigate WITH headers"),
    // distinct from both healthy and CF-error, so the watchdog reloads WITH the
    // Access headers instead of looping. Markers are stable across CF's Access
    // login template + the team-domain redirect host.
    private static let accessLoginMarkers = [
        "cloudflareaccess.com",
        "cf-access-login",
        "data-access-app",
        "sign in with cloudflare access",
        "cloudflare access",
    ]

    // True when the loaded document looks like the CF Access login interstitial
    // (session expired / unauthenticated), and NOT the real dashboard or a CF
    // error page. The real dashboard mounts a #root and contains none of these
    // markers, so it is never misclassified.
    static func looksLikeAccessLogin(html: String) -> Bool {
        if html.isEmpty { return false }
        if looksLikeCloudflareError(html: html) { return false }
        let haystack = html.lowercased()
        return accessLoginMarkers.contains { haystack.contains($0) }
    }
}

// Cloudflare Access credentials for the kiosk service token (www-cuuw). Pure and
// UIKit-free so it is unit-tested with swiftc. The kiosk authenticates to the
// gated `dashboard` with a service token: the two CF-Access-* headers on a
// request authenticate it directly (browser then carries a CF_Authorization
// cookie for subresources, but the watchdog's own probe/reload can't rely on
// that cookie across session expiry , so EVERY request the kiosk issues to the
// origin must carry these headers). Credentials are baked into the build from
// repo secrets at `cap sync` time (see ios-build.yml); absent in dev/open-origin
// builds, in which case `headers` is empty and nothing is injected (byte-identical
// to today , an empty client-id is NEVER sent, CF can reject/log it oddly).
struct KioskAccess {
    let clientId: String
    let clientSecret: String

    // Build from the two values (env at build time / Info.plist at runtime).
    // Returns nil when EITHER is missing/blank , partial creds are useless and an
    // empty header value must never be sent.
    static func from(clientId: String?, clientSecret: String?) -> KioskAccess? {
        guard let id = clientId, let secret = clientSecret,
              !id.isEmpty, !secret.isEmpty else { return nil }
        return KioskAccess(clientId: id, clientSecret: secret)
    }

    // The CF-Access header map to inject on every origin request. Header NAMES are
    // the CF service-token headers; values are the token's client id/secret.
    var headers: [String: String] {
        [
            "CF-Access-Client-Id": clientId,
            "CF-Access-Client-Secret": clientSecret,
        ]
    }
}

// Bounded exponential backoff so a long outage settles into a steady retry
// cadence instead of hammering the origin the moment it might be recovering.
struct Backoff {
    let base: TimeInterval
    let max: TimeInterval

    func delay(forAttempt attempt: Int) -> TimeInterval {
        guard attempt > 0 else { return base }
        // Cap the exponent so `pow` can't overflow on a very long outage.
        let exponent = Swift.min(attempt, 32)
        let scaled = base * pow(2.0, Double(exponent))
        return Swift.min(max, scaled)
    }
}

// Pure decision core for the native memory-warning recovery path (T-51).
// Recovery itself belongs to KioskViewController; this type only owns the
// bounded policy so it can be proven without UIKit or an iOS simulator.
enum PanelMemoryPressureRecoveryAction {
    case authenticatedOriginReload
    case stagedWebDocumentReset
    case suppressedByLoopProtection
}

struct PanelMemoryPressureRecoveryPolicy {
    let windowMs: Int64

    private var recoveries: [(timestampMs: Int64, action: PanelMemoryPressureRecoveryAction)] = []

    init(windowMs: Int64) {
        self.windowMs = windowMs
    }

    var recoveryCount: Int {
        recoveries.count
    }

    mutating func action(atMs nowMs: Int64) -> PanelMemoryPressureRecoveryAction {
        let windowStart = nowMs - windowMs
        recoveries.removeAll { $0.timestampMs < windowStart }

        if recoveries.contains(where: { $0.action == .stagedWebDocumentReset }) {
            return .suppressedByLoopProtection
        }

        if let latest = recoveries.last, nowMs - latest.timestampMs < windowMs {
            recoveries.append((nowMs, .stagedWebDocumentReset))
            return .stagedWebDocumentReset
        }

        recoveries.append((nowMs, .authenticatedOriginReload))
        return .authenticatedOriginReload
    }
}
