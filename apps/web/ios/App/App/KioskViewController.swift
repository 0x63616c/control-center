import Capacitor
import UIKit
import WebKit

// Capacitor owns WKWebView.navigationDelegate and already reloads after a
// WebContent-only process termination. This transparent proxy records that
// specific event, then forwards it (and every other delegate callback) so the
// framework's recovery behavior remains intact.
private final class KioskNavigationDelegateProxy: NSObject, WKNavigationDelegate {
    weak var downstream: WKNavigationDelegate?
    var onNextNavigationFinished: (() -> Void)?

    init(downstream: WKNavigationDelegate?) {
        self.downstream = downstream
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        KioskDiagnosticsRecorder.shared.recordWebContentTermination()
        downstream?.webViewWebContentProcessDidTerminate?(webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        downstream?.webView?(webView, didFinish: navigation)
        let completion = onNextNavigationFinished
        onNextNavigationFinished = nil
        completion?()
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || downstream?.responds(to: selector) == true
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        if downstream?.responds(to: selector) == true {
            return downstream
        }
        return super.forwardingTarget(for: selector)
    }
}

class KioskViewController: CAPBridgeViewController {
    private var watchdog: KioskWatchdog?
    private var navigationDelegateProxy: KioskNavigationDelegateProxy?
    private var observesMemoryPressure = false
    private var nightlyMaintenanceTimer: Timer?
    private var stagedResetFallbackTimer: Timer?
    private var memoryPressurePolicy = PanelMemoryPressureRecoveryPolicy(
        windowMs: 60 * 60 * 1_000
    )

    override var prefersStatusBarHidden: Bool {
        return true
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        return UIDevice.current.userInterfaceIdiom == .pad ? .landscape : .portrait
    }

    // Capacitor does NOT discover plugins by scanning the ObjC runtime. Its
    // registerPlugins() only walks the `packageClassList` in the generated
    // capacitor.config.json, and `cap sync` builds that list from installed npm
    // packages , so a plugin living in this app target can never appear there
    // and would silently never register (isPluginAvailable false, every call
    // falling back). Registering the instance here is the supported route:
    // capacitorDidLoad runs right after the bridge is built and before the
    // webview loads, so the JS shim exists by the time the page runs.
    //
    // registerPluginInstance, NOT registerPluginType , the latter early-returns
    // whenever autoRegisterPlugins is true (the default), which is exactly the
    // silent no-op this override exists to avoid.
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(UISoundPlugin())
        bridge?.registerPluginInstance(PanelVolumePlugin())
        bridge?.registerPluginInstance(KioskDiagnosticsPlugin())
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        installNavigationDelegateProxyIfNeeded()
        observeMemoryPressureIfNeeded()
        injectAccessHeadersIfNeeded()
        startWatchdogIfNeeded()
        scheduleNightlyMaintenanceIfNeeded()
    }

    deinit {
        nightlyMaintenanceTimer?.invalidate()
        stagedResetFallbackTimer?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    // CF Access service-token credentials (www-cuuw), baked into Info.plist at
    // `cap sync` time from repo secrets (ios-build.yml). nil for an open/dev build
    // (keys absent or blank) , then nothing is injected and behavior is identical
    // to today (an empty header value is never sent).
    private var kioskAccess: KioskAccess? {
        let id = Bundle.main.object(forInfoDictionaryKey: "CFAccessClientId") as? String
        let secret = Bundle.main.object(forInfoDictionaryKey: "CFAccessClientSecret") as? String
        return KioskAccess.from(clientId: id, clientSecret: secret)
    }

    // Capacitor's `loadWebView()` is `public final` and issues the INITIAL
    // origin load as a header-less `URLRequest(url:)` we cannot override or
    // configure (Capacitor 8 has no `server.headers`, verified against the SDK
    // declarations , so the documented capacitor.config.ts path does not exist;
    // this WKNavigationDelegate-adjacent re-load is the §5 fallback). So once the
    // view appears, if the dashboard is gated we re-issue the load WITH the
    // CF-Access headers so the first authenticated nav establishes the
    // CF_Authorization cookie. No-op when the origin is open (kioskAccess == nil).
    private func injectAccessHeadersIfNeeded() {
        guard kioskAccess != nil else { return }
        loadAuthenticatedOrigin()
    }

    private func loadAuthenticatedOrigin() {
        guard let webView = webView else { return }
        guard let origin = bridge?.config.appStartServerURL ?? webView.url else { return }
        var request = URLRequest(url: origin)
        for (name, value) in kioskAccess?.headers ?? [:] {
            request.setValue(value, forHTTPHeaderField: name)
        }
        webView.load(request)
    }

    private func installNavigationDelegateProxyIfNeeded() {
        guard navigationDelegateProxy == nil, let webView = webView else { return }
        let proxy = KioskNavigationDelegateProxy(downstream: webView.navigationDelegate)
        webView.navigationDelegate = proxy
        navigationDelegateProxy = proxy
    }

    private func observeMemoryPressureIfNeeded() {
        guard !observesMemoryPressure else { return }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(recoverFromMemoryPressure),
            name: .panelMemoryPressureRecoveryRequested,
            object: nil
        )
        observesMemoryPressure = true
    }

    @objc private func recoverFromMemoryPressure() {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
        switch memoryPressurePolicy.action(atMs: nowMs) {
        case .authenticatedOriginReload:
            KioskDiagnosticsRecorder.shared.recordRecovery(
                trigger: .memoryWarning,
                outcome: .authenticatedOriginReload
            )
            loadAuthenticatedOrigin()
        case .stagedWebDocumentReset:
            KioskDiagnosticsRecorder.shared.recordRecovery(
                trigger: .memoryWarning,
                outcome: .stagedWebDocumentReset
            )
            stageAuthenticatedOriginReset()
        case .suppressedByLoopProtection:
            KioskDiagnosticsRecorder.shared.recordRecovery(
                trigger: .memoryWarning,
                outcome: .suppressedByLoopProtection
            )
        }
    }

    private func scheduleNightlyMaintenanceIfNeeded() {
        guard nightlyMaintenanceTimer == nil else { return }
        let schedule = PanelNightlyMaintenanceSchedule(hour: 3, calendar: .current)
        guard let nextDate = schedule.nextDate(after: Date()) else { return }
        let timer = Timer(fire: nextDate, interval: 0, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.nightlyMaintenanceTimer = nil
            self.performNightlyMaintenance()
            self.scheduleNightlyMaintenanceIfNeeded()
        }
        RunLoop.main.add(timer, forMode: .common)
        nightlyMaintenanceTimer = timer
    }

    private func performNightlyMaintenance() {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
        let action = memoryPressurePolicy.scheduledMaintenanceAction(atMs: nowMs)
        let outcome: PanelRecoveryOutcome
        switch action {
        case .authenticatedOriginReload:
            outcome = .authenticatedOriginReload
        case .stagedWebDocumentReset:
            outcome = .stagedWebDocumentReset
        case .suppressedByLoopProtection:
            outcome = .suppressedByLoopProtection
        }
        // Persist the decision before navigation so the nightly event survives
        // even if WebKit or iOS terminates the process during recovery.
        KioskDiagnosticsRecorder.shared.recordRecovery(
            trigger: .scheduledMaintenance,
            outcome: outcome
        )
        switch action {
        case .authenticatedOriginReload:
            loadAuthenticatedOrigin()
        case .stagedWebDocumentReset:
            stageAuthenticatedOriginReset()
        case .suppressedByLoopProtection:
            break
        }
    }

    private func stageAuthenticatedOriginReset() {
        guard let webView, let navigationDelegateProxy else {
            loadAuthenticatedOrigin()
            return
        }
        stagedResetFallbackTimer?.invalidate()
        webView.stopLoading()
        // A same-origin navigation replaces the document but lets WebKit retain
        // its old graph while the new response is fetched. Commit a tiny inert
        // document first so repeated pressure gets one stronger, public-API-only
        // teardown without clearing cookies, website data, or feature state.
        let finishReset = { [weak self, weak webView, weak navigationDelegateProxy] in
            guard let self, let webView, self.webView === webView else { return }
            self.stagedResetFallbackTimer?.invalidate()
            self.stagedResetFallbackTimer = nil
            navigationDelegateProxy?.onNextNavigationFinished = nil
            self.loadAuthenticatedOrigin()
        }
        navigationDelegateProxy.onNextNavigationFinished = finishReset
        let fallback = Timer(timeInterval: 10, repeats: false) { _ in finishReset() }
        RunLoop.main.add(fallback, forMode: .common)
        stagedResetFallbackTimer = fallback
        webView.loadHTMLString("<!doctype html><title>Recovering</title>", baseURL: nil)
    }

    // The kiosk is unattended, so it must recover on its own from a Cloudflare
    // outage that leaves the WKWebView stuck on an error page (www-bwoy) or, once
    // gated, on the CF Access login interstitial after cookie expiry (www-cuuw).
    // Start the watchdog once the bridge has created the web view and resolved the
    // server URL it loaded; fall back to the live page URL if config is absent.
    private func startWatchdogIfNeeded() {
        guard watchdog == nil, let webView = webView else { return }
        // appStartServerURL is the remote `server.url` the kiosk loaded; fall
        // back to the live page URL if the bridge config isn't available yet.
        guard let origin = bridge?.config.appStartServerURL ?? webView.url else { return }
        // Pass the Access creds so the watchdog's probe + reload authenticate
        // through the gate instead of looping on the login wall (www-cuuw).
        let watchdog = KioskWatchdog(webView: webView, originURL: origin, access: kioskAccess)
        watchdog.start()
        self.watchdog = watchdog
    }
}
