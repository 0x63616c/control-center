import Capacitor
import UIKit

class KioskViewController: CAPBridgeViewController {
    private var watchdog: KioskWatchdog?

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
        injectAccessHeadersIfNeeded()
        startWatchdogIfNeeded()
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
        guard let access = kioskAccess, let webView = webView else { return }
        guard let origin = bridge?.config.appStartServerURL ?? webView.url else { return }
        var request = URLRequest(url: origin)
        for (name, value) in access.headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        webView.load(request)
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
