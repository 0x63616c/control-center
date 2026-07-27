import Capacitor
import Foundation
import UIKit
import WebKit

/**
 * KioskBrowser , presents a URL in a WKWebView we own, modally over the kiosk.
 *
 * Replaces @capacitor/browser (SFSafariViewController) for links opened from
 * inside the app (see external-browser.ts). SFSafariViewController ships an
 * OS-owned "open in Safari.app" button in its top-right corner with no API to
 * remove it , tapping it exits the kiosk shell entirely, onto the open web,
 * with no way back short of physically relaunching the app (#56). A WKWebView
 * we present ourselves has no such escape: the only chrome is the "Done"
 * button this class adds, so the panel can never leave its own app via a link.
 */
@objc(KioskBrowserPlugin)
public class KioskBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KioskBrowserPlugin"
    public let jsName = "KioskBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    private weak var presented: KioskBrowserViewController?

    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("Missing or invalid url")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self, let host = self.bridge?.viewController else {
                call.reject("No host view controller")
                return
            }

            let browserVC = KioskBrowserViewController(url: url) { [weak self] in
                self?.notifyListeners("browserFinished", data: [:])
                self?.presented = nil
            }
            browserVC.modalPresentationStyle = .fullScreen
            self.presented = browserVC
            host.present(browserVC, animated: true) {
                call.resolve()
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let browserVC = self?.presented else {
                call.resolve()
                return
            }
            browserVC.dismiss(animated: true) {
                call.resolve()
            }
        }
    }
}

/// Full-screen modal hosting the WKWebView. Chrome is deliberately minimal:
/// a title bar with only a "Done" button , no share sheet, no "open in
/// Safari" action, no address bar to type an escape into.
private final class KioskBrowserViewController: UIViewController, WKUIDelegate {
    private let url: URL
    private let onDismissed: () -> Void
    private var webView: WKWebView!

    init(url: URL, onDismissed: @escaping () -> Void) {
        self.url = url
        self.onDismissed = onDismissed
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        // No long-press "Open in Safari" / "Open in Background" callout on
        // links , the whole point of owning this view is that a link can only
        // ever navigate inside it.
        webView.allowsLinkPreview = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        let doneButton = UIButton(type: .system)
        doneButton.setTitle("Done", for: .normal)
        doneButton.setTitleColor(.white, for: .normal)
        doneButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        doneButton.addTarget(self, action: #selector(dismissTapped), for: .touchUpInside)
        doneButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(doneButton)

        let safeArea = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            doneButton.topAnchor.constraint(equalTo: safeArea.topAnchor, constant: 8),
            doneButton.trailingAnchor.constraint(equalTo: safeArea.trailingAnchor, constant: -16),
            doneButton.heightAnchor.constraint(equalToConstant: 44),

            webView.topAnchor.constraint(equalTo: doneButton.bottomAnchor, constant: 4),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        webView.load(URLRequest(url: url))
    }

    @objc private func dismissTapped() {
        dismiss(animated: true)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Fires for both the Done button and a system-driven dismissal (e.g.
        // the board's idle reset calling KioskBrowser.close()), same contract
        // as @capacitor/browser's browserFinished.
        onDismissed()
    }

    // MARK: - WKUIDelegate

    // target="_blank"/window.open links have no frame to load into; without
    // this they silently no-op instead of opening in the same view.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
        }
        return nil
    }
}
