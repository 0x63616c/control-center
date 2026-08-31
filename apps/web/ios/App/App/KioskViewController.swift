import Capacitor
import UIKit
import WebKit

// Capacitor owns WKWebView.navigationDelegate and already reloads after a
// WebContent-only process termination. This transparent proxy records that
// specific event, then forwards it (and every other delegate callback) so the
// framework's recovery behavior remains intact.
private final class KioskNavigationDelegateProxy: NSObject, WKNavigationDelegate {
    weak var downstream: WKNavigationDelegate?
    private var awaitedNavigation: WKNavigation?
    private var onAwaitedNavigationFinished: (() -> Void)?

    init(downstream: WKNavigationDelegate?) {
        self.downstream = downstream
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        KioskDiagnosticsRecorder.shared.recordWebContentTermination()
        downstream?.webViewWebContentProcessDidTerminate?(webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        downstream?.webView?(webView, didFinish: navigation)
        guard navigation === awaitedNavigation else { return }
        let completion = onAwaitedNavigationFinished
        awaitedNavigation = nil
        onAwaitedNavigationFinished = nil
        completion?()
    }

    func whenFinished(_ navigation: WKNavigation?, perform completion: @escaping () -> Void) {
        awaitedNavigation = navigation
        onAwaitedNavigationFinished = completion
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

// The maintenance cover belongs to the UIWindow so it remains above the live
// WKWebView throughout an authenticated-origin refresh. Keeping this tiny bit
// of presentation state outside the bridge also prevents a slow navigation
// from revealing a half-loaded dashboard.
private final class PanelMaintenanceCoverCoordinator {
    static let shared = PanelMaintenanceCoverCoordinator()

    private var coverView: UIView?
    private weak var coverLabel: UILabel?
    private init() {}

    func show(over window: UIWindow) {
        if coverView == nil {
            let cover = UIView(frame: window.bounds)
            cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            cover.backgroundColor = UIColor(red: 0.063, green: 0.078, blue: 0.098, alpha: 1)

            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.color = UIColor(white: 0.72, alpha: 1)
            spinner.startAnimating()
            let label = UILabel()
            label.text = "Refreshing Control Center…"
            label.textColor = UIColor(white: 0.82, alpha: 1)
            label.font = UIFont.systemFont(ofSize: 17, weight: .medium)
            let stack = UIStackView(arrangedSubviews: [spinner, label])
            stack.axis = .vertical
            stack.alignment = .center
            stack.spacing = 16
            stack.translatesAutoresizingMaskIntoConstraints = false
            cover.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
                stack.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
            ])
            window.addSubview(cover)
            coverView = cover
            coverLabel = label
        }
        if let coverView {
            window.bringSubviewToFront(coverView)
        }
    }

    func showSlowRefresh() {
        coverLabel?.text = "Still refreshing Control Center…"
    }

    func dismiss() {
        guard let cover = coverView else { return }
        coverView = nil
        coverLabel = nil
        UIView.animate(withDuration: 0.35, animations: {
            cover.alpha = 0
        }, completion: { _ in
            cover.removeFromSuperview()
        })
    }
}

class KioskViewController: CAPBridgeViewController {
    private var watchdog: KioskWatchdog?
    private var navigationDelegateProxy: KioskNavigationDelegateProxy?
    private var observesMemoryPressure = false
    private var observesMaintenanceRequests = false
    private var nightlyMaintenanceTimer: Timer?
    private var maintenanceCoverFallbackTimer: Timer?
    private let maintenanceConfigurationStore = PanelMaintenanceConfigurationStore()
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
        bridge?.registerPluginInstance(PanelMaintenancePlugin())
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        installNavigationDelegateProxyIfNeeded()
        observeMemoryPressureIfNeeded()
        observeMaintenanceRequestsIfNeeded()
        injectAccessHeadersIfNeeded()
        startWatchdogIfNeeded()
        scheduleNightlyMaintenanceIfNeeded()
    }

    deinit {
        nightlyMaintenanceTimer?.invalidate()
        maintenanceCoverFallbackTimer?.invalidate()
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

    private func loadAuthenticatedOrigin(onFinished: (() -> Void)? = nil) {
        guard let webView = webView else { return }
        guard let origin = bridge?.config.appStartServerURL ?? webView.url else { return }
        var request = URLRequest(url: origin)
        for (name, value) in kioskAccess?.headers ?? [:] {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let navigation = webView.load(request)
        if let onFinished {
            navigationDelegateProxy?.whenFinished(navigation, perform: onFinished)
        }
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

    private func observeMaintenanceRequestsIfNeeded() {
        guard !observesMaintenanceRequests else { return }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(rescheduleNightlyMaintenance),
            name: .panelMaintenanceConfigurationChanged,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(performManualMaintenance),
            name: .panelMaintenanceRunRequested,
            object: nil
        )
        observesMaintenanceRequests = true
    }

    @objc private func recoverFromMemoryPressure() {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
        executeRecovery(
            memoryPressurePolicy.action(atMs: nowMs),
            trigger: .memoryWarning
        )
    }

    private func scheduleNightlyMaintenanceIfNeeded() {
        guard nightlyMaintenanceTimer == nil else { return }
        let configuration = maintenanceConfigurationStore.configuration
        guard configuration.enabled else { return }
        let scheduler = PanelMaintenanceScheduler(calendar: .current)
        guard let nextDate = scheduler.nextDate(for: configuration, after: Date()) else { return }
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
        executeRecovery(
            memoryPressurePolicy.scheduledMaintenanceAction(atMs: nowMs),
            trigger: .scheduledMaintenance
        )
    }

    @objc private func rescheduleNightlyMaintenance() {
        nightlyMaintenanceTimer?.invalidate()
        nightlyMaintenanceTimer = nil
        scheduleNightlyMaintenanceIfNeeded()
    }

    @objc private func performManualMaintenance() {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
        executeRecovery(
            memoryPressurePolicy.manualMaintenanceAction(atMs: nowMs),
            trigger: .manualMaintenance
        )
    }

    private func executeRecovery(
        _ action: PanelMemoryPressureRecoveryAction,
        trigger: PanelRecoveryTrigger
    ) {
        // Persist the decision before navigation so the recovery event survives
        // even if WebKit or iOS terminates the process during recovery.
        KioskDiagnosticsRecorder.shared.recordRecovery(
            trigger: trigger,
            outcome: action.diagnosticsOutcome
        )
        switch action {
        case .authenticatedOriginReload:
            showMaintenanceCover()
            loadAuthenticatedOrigin { [weak self] in
                self?.handleMaintenanceTransition(.authenticatedOriginFinished)
            }
        case .suppressedByLoopProtection:
            break
        }
    }

    private func showMaintenanceCover() {
        guard let window = view.window else { return }
        PanelMaintenanceCoverCoordinator.shared.show(over: window)
        armMaintenanceCoverSafetyTimer()
    }

    private func armMaintenanceCoverSafetyTimer() {
        maintenanceCoverFallbackTimer?.invalidate()
        let fallback = Timer(timeInterval: 20, repeats: false) { [weak self] _ in
            self?.handleMaintenanceTransition(.coverSafetyTimedOut)
        }
        RunLoop.main.add(fallback, forMode: .common)
        maintenanceCoverFallbackTimer = fallback
    }

    private func handleMaintenanceTransition(_ event: PanelMaintenanceTransitionEvent) {
        switch PanelMaintenanceTransition.action(for: event) {
        case .dismissCover:
            dismissMaintenanceCover()
        case .loadAuthenticatedOriginKeepingCover:
            PanelMaintenanceCoverCoordinator.shared.showSlowRefresh()
            armMaintenanceCoverSafetyTimer()
            loadAuthenticatedOrigin { [weak self] in
                self?.handleMaintenanceTransition(.authenticatedOriginFinished)
            }
        }
    }

    private func dismissMaintenanceCover() {
        maintenanceCoverFallbackTimer?.invalidate()
        maintenanceCoverFallbackTimer = nil
        PanelMaintenanceCoverCoordinator.shared.dismiss()
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
