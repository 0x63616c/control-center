// Pure-logic regression tests for the kiosk recovery watchdog (www-bwoy).
//
// These exercise KioskHealth , the UIKit-free core that decides whether the
// hosted dashboard is healthy and how long to wait before the next reload.
// Run via web/ios/scripts/test-kiosk-health.sh, which compiles this
// alongside KioskHealth.swift with swiftc (no Xcode/simulator needed), so it
// works as a real red-before/green-after guard for the recovery behavior.
//
// Why a separate guard and not the vitest suite: the recovery logic is native
// Swift in the Capacitor shell and cannot be exercised by the web (jsdom) tests.

import Foundation

enum Check {
    static var failures: [String] = []

    static func expect(_ cond: Bool, _ msg: String) {
        if cond {
            print("  ok   - \(msg)")
        } else {
            print("  FAIL - \(msg)")
            failures.append(msg)
        }
    }
}

@main
enum KioskHealthTests {
    static func main() {
        print("KioskHealth tests")

        // --- HTTP status classification ---
        // The wall panel only treats origin-level failure (5xx, incl. all the
        // Cloudflare tunnel/origin codes) as "reload-worthy". A served 2xx/3xx
        // page is healthy; 4xx is the app responding, not the origin being down,
        // so it is NOT treated as unhealthy (reloading a 4xx would just loop).
        Check.expect(KioskHealth.isHealthy(httpStatus: 200), "HTTP 200 is healthy")
        Check.expect(KioskHealth.isHealthy(httpStatus: 304), "HTTP 304 is healthy")
        Check.expect(!KioskHealth.isHealthy(httpStatus: 530), "HTTP 530 (CF 1033 tunnel down) is unhealthy")
        Check.expect(!KioskHealth.isHealthy(httpStatus: 521), "HTTP 521 (CF web server is down) is unhealthy")
        Check.expect(!KioskHealth.isHealthy(httpStatus: 502), "HTTP 502 is unhealthy")
        Check.expect(KioskHealth.isHealthy(httpStatus: 404), "HTTP 404 is the app responding, not origin-down")
        Check.expect(!KioskHealth.isHealthy(httpStatus: 0), "HTTP 0 (no response) is unhealthy")

        // --- Cloudflare error-page body detection ---
        // CF serves its error page with a 5xx status, but WKWebView renders it as
        // a normal successful load, so we also sniff the loaded DOM for CF error
        // markers. This is what makes the stuck "Error 1033" page recoverable.
        let cf1033 = """
        <html><head><title>worldwidewebb.co | 1033: Argo Tunnel error</title></head>
        <body><div class="cf-error-details cf-error-1033">
        <h1><span class="cf-error-type">Error</span><span class="cf-error-code">1033</span></h1>
        </div></body></html>
        """
        Check.expect(KioskHealth.looksLikeCloudflareError(html: cf1033), "detects Error 1033 Argo tunnel page")

        let cf521 = "<html><body><h2>Error 521 Ray ID: abc</h2><p>Web server is down</p></body></html>"
        Check.expect(KioskHealth.looksLikeCloudflareError(html: cf521), "detects Error 521 web-server-down page")

        let realDashboard = """
        <html><head><title>Control Center</title></head>
        <body><div id="root"><div class="tile">Weather</div></div></body></html>
        """
        Check.expect(!KioskHealth.looksLikeCloudflareError(html: realDashboard), "real dashboard DOM is not a CF error")
        Check.expect(!KioskHealth.looksLikeCloudflareError(html: ""), "empty body is not flagged as CF error")

        // --- CF Access login interstitial classification (www-cuuw) ---
        // Once `dashboard` is gated and the CF_Authorization cookie expires, the
        // loaded document is the CF Access LOGIN page , NOT a CF error page and
        // with no React #root. The watchdog's header-less probe gets a 302 to it,
        // and isHealthy(302) == true, so a header-less reload would re-render the
        // login wall forever (the brick path from §5). looksLikeAccessLogin is the
        // THIRD state that breaks that loop: recognize the login page so the
        // watchdog reloads WITH the Access headers instead.
        let accessLogin = """
        <html><head><title>Sign in</title></head>
        <body><div id="cf-access-login" data-access-app="dashboard">
        <a href="https://worldwidewebb.cloudflareaccess.com/cdn-cgi/access/login">
        Sign in with Cloudflare Access</a></div></body></html>
        """
        Check.expect(KioskHealth.looksLikeAccessLogin(html: accessLogin), "detects the CF Access login interstitial")
        Check.expect(!KioskHealth.looksLikeAccessLogin(html: realDashboard), "real dashboard is NOT the Access login page")
        Check.expect(!KioskHealth.looksLikeAccessLogin(html: cf1033), "a CF error page is NOT the Access login page")
        Check.expect(!KioskHealth.looksLikeAccessLogin(html: ""), "empty body is not the Access login page")
        // The login page must NOT be misread as a CF error (different recovery).
        Check.expect(!KioskHealth.looksLikeCloudflareError(html: accessLogin), "Access login page is NOT a CF error page")
        // 302 to the login is "healthy" by status , proving the status check alone
        // can't tell the gate apart; the DOM classification above is what does.
        Check.expect(KioskHealth.isHealthy(httpStatus: 302), "HTTP 302 (redirect to Access login) is 'healthy' by status , DOM sniff is required")

        // --- CF Access credentials + header injection (www-cuuw) ---
        // The kiosk's probe AND reload must carry the CF-Access headers. These
        // assert the credential gate (partial/blank creds -> nil -> no headers
        // sent, the LOGIN-LOOP REGRESSION guard) and the exact header map when set.
        Check.expect(KioskAccess.from(clientId: nil, clientSecret: nil) == nil, "no creds -> nil (open origin, no headers)")
        Check.expect(KioskAccess.from(clientId: "id", clientSecret: nil) == nil, "missing secret -> nil (never send a half-credential)")
        Check.expect(KioskAccess.from(clientId: "", clientSecret: "secret") == nil, "blank id -> nil (never send an empty CF-Access-Client-Id)")
        if let access = KioskAccess.from(clientId: "cid", clientSecret: "csec") {
            Check.expect(access.headers["CF-Access-Client-Id"] == "cid", "header map carries the client id")
            Check.expect(access.headers["CF-Access-Client-Secret"] == "csec", "header map carries the client secret")
            Check.expect(access.headers.count == 2, "exactly the two CF-Access headers are produced")
        } else {
            Check.expect(false, "valid creds should produce a KioskAccess")
        }

        // --- Bounded exponential backoff ---
        // Reloads must not hammer the origin. Backoff grows exponentially from a
        // base and is capped, so a long outage settles into a steady retry cadence.
        let backoff = Backoff(base: 2, max: 60)
        Check.expect(backoff.delay(forAttempt: 0) == 2, "attempt 0 waits base (2s)")
        Check.expect(backoff.delay(forAttempt: 1) == 4, "attempt 1 doubles to 4s")
        Check.expect(backoff.delay(forAttempt: 2) == 8, "attempt 2 doubles to 8s")
        Check.expect(backoff.delay(forAttempt: 10) == 60, "large attempt is capped at max (60s)")
        Check.expect(backoff.delay(forAttempt: -1) == 2, "negative attempt clamps to base")

        // --- Memory-pressure recovery policy (T-51) ---
        // A warning is the last signal iOS gives us before the abrupt exits seen
        // on Builds 102/103. Recover the hosted document immediately, but never
        // permit warning storms to turn into an unattended reload loop.
        var pressure = MemoryPressureRecoveryPolicy(
            cooldownMs: 15 * 60 * 1_000,
            windowMs: 60 * 60 * 1_000,
            maxRecoveriesPerWindow: 3
        )
        let firstWarning = Int64(1_000_000)
        Check.expect(pressure.shouldRecover(atMs: firstWarning), "first memory warning triggers recovery")
        Check.expect(
            !pressure.shouldRecover(atMs: firstWarning + 14 * 60 * 1_000),
            "warning inside the 15-minute cooldown is suppressed"
        )
        Check.expect(
            pressure.shouldRecover(atMs: firstWarning + 15 * 60 * 1_000),
            "warning at the cooldown boundary can recover"
        )
        Check.expect(
            pressure.shouldRecover(atMs: firstWarning + 30 * 60 * 1_000),
            "a third spaced warning can recover"
        )
        Check.expect(
            !pressure.shouldRecover(atMs: firstWarning + 45 * 60 * 1_000),
            "rolling-window cap prevents a reload loop"
        )
        Check.expect(
            pressure.shouldRecover(atMs: firstWarning + 61 * 60 * 1_000),
            "recovery resumes after the oldest attempt leaves the window"
        )
        Check.expect(pressure.recoveryCount == 3, "policy retains only rolling-window recovery timestamps")

        if Check.failures.isEmpty {
            print("\nALL PASS")
            exit(0)
        } else {
            print("\n\(Check.failures.count) FAILURE(S)")
            exit(1)
        }
    }
}
