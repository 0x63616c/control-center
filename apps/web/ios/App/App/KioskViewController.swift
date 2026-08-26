import Capacitor
import UIKit
import WebKit

// Capacitor owns WKWebView.navigationDelegate and already reloads after a
// WebContent-only process termination. This transparent proxy records that
// specific event, then forwards it (and every other delegate callback) so the
// framework's recovery behavior remains intact.
private final class KioskNavigationDelegateProxy: NSObject, WKNavigationDelegate {
    weak var downstream: WKNavigationDelegate?

    init(downstream: WKNavigationDelegate?) {
        self.downstream = downstream
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        KioskDiagnosticsRecorder.shared.recordWebContentTermination()
        downstream?.webViewWebContentProcessDidTerminate?(webView)
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
    private var memoryPressurePolicy = MemoryPressureRecoveryPolicy(
        cooldownMs: 15 * 60 * 1_000,
        windowMs: 60 * 60 * 1_000,
        maxRecoveriesPerWindow: 3
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
    }

    deinit {
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
            name: .kioskMemoryPressureRecoveryRequested,
            object: nil
        )
        observesMemoryPressure = true
    }

    @objc private func recoverFromMemoryPressure() {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
        guard memoryPressurePolicy.shouldRecover(atMs: nowMs) else {
            KioskDiagnosticsRecorder.shared.recordRecovery(
                trigger: "memory-warning",
                outcome: "suppressed-by-loop-protection"
            )
            return
        }

        KioskDiagnosticsRecorder.shared.recordRecovery(
            trigger: "memory-warning",
            outcome: "authenticated-origin-reload"
        )
        loadAuthenticatedOrigin()
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
