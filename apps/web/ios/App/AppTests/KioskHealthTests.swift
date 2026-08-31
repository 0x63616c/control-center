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
        var pressure = PanelMemoryPressureRecoveryPolicy(
            windowMs: 60 * 60 * 1_000
        )
        let firstWarning = Int64(1_000_000)
        let repeatedWarning = firstWarning + 192 * 1_000
        Check.expect(
            pressure.action(atMs: firstWarning) == .authenticatedOriginReload,
            "first memory warning triggers an authenticated origin reload"
        )
        Check.expect(
            pressure.action(atMs: repeatedWarning) == .suppressedByLoopProtection,
            "a repeated warning is suppressed instead of replacing the native bridge"
        )
        Check.expect(
            pressure.action(atMs: firstWarning + 4 * 60 * 1_000) == .suppressedByLoopProtection,
            "further warnings remain suppressed"
        )
        Check.expect(
            pressure.action(atMs: repeatedWarning + 15 * 60 * 1_000) == .suppressedByLoopProtection,
            "later warnings remain suppressed for the rolling hour after the refresh"
        )
        Check.expect(
            pressure.action(atMs: repeatedWarning + 30 * 60 * 1_000) == .suppressedByLoopProtection,
            "rolling-window suppression remains bounded"
        )
        Check.expect(
            pressure.action(atMs: repeatedWarning + 61 * 60 * 1_000) == .authenticatedOriginReload,
            "recovery resumes after the prior reload leaves the rolling window"
        )
        Check.expect(pressure.recoveryCount == 1, "policy retains only rolling-window recovery timestamps")

        var observedPressure = PanelMemoryPressureRecoveryPolicy(
            windowMs: 60 * 60 * 1_000
        )
        let observedFirstWarning = Int64(1_000_000)
        Check.expect(
            observedPressure.action(atMs: observedFirstWarning) == .authenticatedOriginReload,
            "observed first warning triggers an authenticated origin reload"
        )
        Check.expect(
            observedPressure.action(atMs: observedFirstWarning + 56 * 60 * 1_000 + 55 * 1_000)
                == .suppressedByLoopProtection,
            "a second warning 56m55s later remains inside the rolling-hour guard"
        )

        // --- Nightly 03:00 WebKit maintenance (T-58) ---
        // Calendar scheduling is intentionally local-time based: the Panel gets
        // one fresh document every night before its observed 28-31h danger
        // window, including across daylight-saving clock changes.
        var losAngeles = Calendar(identifier: .gregorian)
        losAngeles.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let nightly = PanelNightlyMaintenanceSchedule(hour: 3, minute: 0, calendar: losAngeles)
        let beforeThree = losAngeles.date(
            from: DateComponents(year: 2026, month: 8, day: 31, hour: 2, minute: 30)
        )!
        let sameDayThree = losAngeles.date(
            from: DateComponents(year: 2026, month: 8, day: 31, hour: 3)
        )!
        Check.expect(
            nightly.nextDate(after: beforeThree) == sameDayThree,
            "before 03:00, nightly maintenance targets the same day's 03:00"
        )

        let afterThree = losAngeles.date(
            from: DateComponents(year: 2026, month: 8, day: 31, hour: 3, minute: 1)
        )!
        let nextDayThree = losAngeles.date(
            from: DateComponents(year: 2026, month: 9, day: 1, hour: 3)
        )!
        Check.expect(
            nightly.nextDate(after: afterThree) == nextDayThree,
            "after 03:00, nightly maintenance rolls to the next day's 03:00"
        )

        let beforeDSTEnd = losAngeles.date(
            from: DateComponents(year: 2026, month: 10, day: 31, hour: 3, minute: 1)
        )!
        let afterDSTEnd = losAngeles.date(
            from: DateComponents(year: 2026, month: 11, day: 1, hour: 3)
        )!
        Check.expect(
            nightly.nextDate(after: beforeDSTEnd) == afterDSTEnd,
            "nightly maintenance remains local 03:00 across daylight-saving changes"
        )

        let customSchedule = PanelNightlyMaintenanceSchedule(hour: 4, minute: 30, calendar: losAngeles)
        let beforeCustomTime = losAngeles.date(
            from: DateComponents(year: 2026, month: 8, day: 31, hour: 4, minute: 29)
        )!
        let sameDayCustomTime = losAngeles.date(
            from: DateComponents(year: 2026, month: 8, day: 31, hour: 4, minute: 30)
        )!
        Check.expect(
            customSchedule.nextDate(after: beforeCustomTime) == sameDayCustomTime,
            "a configured maintenance minute is honored"
        )

        let preferencesSuite = "PanelMaintenanceTests-\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: preferencesSuite)!
        defer { preferences.removePersistentDomain(forName: preferencesSuite) }
        let configurationStore = PanelMaintenanceConfigurationStore(defaults: preferences)
        Check.expect(
            configurationStore.configuration == PanelMaintenanceConfiguration(enabled: true, hour: 3, minute: 0),
            "maintenance defaults to enabled at 03:00"
        )
        let customConfiguration = PanelMaintenanceConfiguration(enabled: true, hour: 4, minute: 30)
        Check.expect(
            configurationStore.save(customConfiguration),
            "a valid custom maintenance time is persisted"
        )
        Check.expect(
            configurationStore.configuration == customConfiguration,
            "the custom maintenance time survives a store reopen"
        )
        Check.expect(
            !configurationStore.save(PanelMaintenanceConfiguration(enabled: true, hour: 24, minute: 0)),
            "an invalid hour is rejected"
        )
        Check.expect(
            !configurationStore.save(PanelMaintenanceConfiguration(enabled: true, hour: 3, minute: 60)),
            "an invalid minute is rejected"
        )

        let scheduler = PanelMaintenanceScheduler(calendar: losAngeles)
        Check.expect(
            scheduler.nextDate(
                for: PanelMaintenanceConfiguration(enabled: false, hour: 4, minute: 30),
                after: beforeCustomTime
            ) == nil,
            "disabling maintenance cancels the next scheduled run"
        )
        Check.expect(
            scheduler.nextDate(for: configurationStore.configuration, after: beforeCustomTime)
                == sameDayCustomTime,
            "the scheduler reads the persisted custom time"
        )
        let rescheduledConfiguration = PanelMaintenanceConfiguration(
            enabled: true,
            hour: 5,
            minute: 15
        )
        Check.expect(
            configurationStore.save(rescheduledConfiguration),
            "a changed maintenance time is persisted for rescheduling"
        )
        let sameDayRescheduledTime = losAngeles.date(
            from: DateComponents(year: 2026, month: 8, day: 31, hour: 5, minute: 15)
        )!
        Check.expect(
            scheduler.nextDate(for: configurationStore.configuration, after: beforeCustomTime)
                == sameDayRescheduledTime,
            "a configuration change moves the next scheduled run"
        )

        var scheduledPressure = PanelMemoryPressureRecoveryPolicy(
            windowMs: 60 * 60 * 1_000
        )
        let firstNightlyReset = Int64(24 * 60 * 60 * 1_000)
        Check.expect(
            scheduledPressure.scheduledMaintenanceAction(atMs: firstNightlyReset) == .authenticatedOriginReload,
            "nightly maintenance performs a supported authenticated-origin refresh"
        )
        Check.expect(
            scheduledPressure.action(atMs: firstNightlyReset + 5 * 60 * 1_000) == .suppressedByLoopProtection,
            "a warning shortly after nightly maintenance is suppressed by the shared loop guard"
        )
        Check.expect(
            scheduledPressure.scheduledMaintenanceAction(atMs: firstNightlyReset + 24 * 60 * 60 * 1_000)
                == .authenticatedOriginReload,
            "the next night's maintenance runs after the prior refresh leaves the rolling hour"
        )

        var manualPressure = PanelMemoryPressureRecoveryPolicy(
            windowMs: 60 * 60 * 1_000
        )
        let manualReset = Int64(500_000)
        Check.expect(
            manualPressure.manualMaintenanceAction(atMs: manualReset) == .authenticatedOriginReload,
            "manual maintenance performs a supported authenticated-origin refresh"
        )
        Check.expect(
            manualPressure.action(atMs: manualReset + 1_000) == .suppressedByLoopProtection,
            "manual maintenance joins the shared recovery circuit breaker"
        )

        Check.expect(
            PanelMaintenanceTransition.action(for: .coverSafetyTimedOut)
                == .loadAuthenticatedOriginKeepingCover,
            "the cover safety fallback retries Control Center without revealing an unfinished WebView"
        )
        Check.expect(
            PanelMaintenanceTransition.action(for: .authenticatedOriginFinished) == .dismissCover,
            "only authenticated-origin completion dismisses the maintenance cover"
        )

        // --- Durable diagnostics compatibility + bounds (T-51) ---
        // Build 104 must decode the smaller Build 103 record already persisted
        // on the wall iPad; otherwise the first launch after updating destroys
        // the previous-process evidence we are trying to collect.
        let build103JSON = """
        {"runId":"legacy","startedAtMs":10,"lastUpdatedAtMs":20,"lifecycleState":"active","memoryWarnings":2,"footprintBytes":100,"peakFootprintBytes":200}
        """.data(using: .utf8)!
        do {
            let legacy = try JSONDecoder().decode(PanelRunRecord.self, from: build103JSON)
            Check.expect(legacy.runId == "legacy", "Build 104 decodes a Build 103 run record")
            Check.expect(legacy.warningEvents.isEmpty, "missing warning history defaults to empty")
            Check.expect(legacy.webContentTerminations.isEmpty, "missing WebKit history defaults to empty")
        } catch {
            Check.expect(false, "Build 103 record should decode: \(error)")
        }

        var bounded = PanelRunRecord.fresh(runId: "bounded", nowMs: 1, footprintBytes: 10)
        for index in 0..<40 {
            bounded.appendMemoryWarning(
                PanelMemoryWarningEvent(
                    timestampMs: Int64(index),
                    lifecycleState: "active",
                    footprintBytes: UInt64(index),
                    peakFootprintBytes: UInt64(index)
                )
            )
        }
        Check.expect(bounded.memoryWarnings == 40, "total memory-warning count is unbounded and exact")
        Check.expect(bounded.warningEvents.count == PanelRunRecord.eventHistoryLimit, "warning history is bounded")
        Check.expect(bounded.warningEvents.first?.timestampMs == 24, "bounded history retains the newest warning events")

        // MetricKit can deliver exit/peak-memory evidence hours after the event.
        // Its raw JSON is therefore archived independently of the current run,
        // atomically and with hard record/byte bounds.
        let metricFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("kiosk-metrickit-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: metricFile) }
        let metricArchive = PanelMetricKitArchive(
            fileURL: metricFile,
            maxRecords: 2,
            maxPayloadBytes: 24
        )
        metricArchive.append(kind: .metric, receivedAtMs: 1, payloadData: Data("{\"irrelevant\":true}".utf8))
        let largeMetricJSON = """
        {"applicationMemoryMetrics":{"peakMemoryUsage":123},"applicationExitMetrics":{"cumulativeMemoryResourceLimitExitCount":2}}
        """
        metricArchive.append(kind: .diagnostic, receivedAtMs: 2, payloadData: Data(largeMetricJSON.utf8))
        metricArchive.append(kind: .metric, receivedAtMs: 3, payloadData: Data("{\"cpuTime\":9}".utf8))
        let metricRecords = metricArchive.records()
        Check.expect(metricRecords.count == 2, "MetricKit archive retains only its record bound")
        Check.expect(metricRecords.first?.receivedAtMs == 2, "MetricKit archive evicts the oldest payload")
        Check.expect(metricRecords.first?.rawPayloadPrefixUTF8.utf8.count == 24, "MetricKit raw payload bytes are capped")
        Check.expect(metricRecords.first?.truncated == true, "truncated MetricKit payload is marked")
        Check.expect(
            metricRecords.first?.evidence.contains { $0.path.contains("peakMemoryUsage") && $0.value == "123" } == true,
            "peak-memory evidence survives raw payload truncation"
        )
        Check.expect(
            metricRecords.first?.evidence.contains {
                $0.path.contains("cumulativeMemoryResourceLimitExitCount") && $0.value == "2"
            } == true,
            "app-exit evidence survives raw payload truncation"
        )
        let reopenedArchive = PanelMetricKitArchive(
            fileURL: metricFile,
            maxRecords: 2,
            maxPayloadBytes: 24
        )
        Check.expect(reopenedArchive.records().count == 2, "MetricKit archive survives a process restart")

        if Check.failures.isEmpty {
            print("\nALL PASS")
            exit(0)
        } else {
            print("\n\(Check.failures.count) FAILURE(S)")
            exit(1)
        }
    }
}
