import Capacitor
import Foundation

@objc(AppInfoPlugin)
public class AppInfoPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppInfoPlugin"
    public let jsName = "AppInfo"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise)
    ]

    @objc func getInfo(_ call: CAPPluginCall) {
        let bundle = Bundle.main
        call.resolve([
            "version": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0",
            "build": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        ])
    }
}
