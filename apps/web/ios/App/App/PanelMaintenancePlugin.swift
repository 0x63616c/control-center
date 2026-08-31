import Capacitor
import Foundation

extension Notification.Name {
    static let panelMaintenanceConfigurationChanged = Notification.Name(
        "co.worldwidewebb.panelMaintenanceConfigurationChanged"
    )
    static let panelMaintenanceRunRequested = Notification.Name(
        "co.worldwidewebb.panelMaintenanceRunRequested"
    )
}

@objc(PanelMaintenancePlugin)
public class PanelMaintenancePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PanelMaintenancePlugin"
    public let jsName = "PanelMaintenance"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getConfiguration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setConfiguration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "runNow", returnType: CAPPluginReturnPromise),
    ]

    private let configurationStore = PanelMaintenanceConfigurationStore()

    @objc func getConfiguration(_ call: CAPPluginCall) {
        call.resolve(payload(for: configurationStore.configuration))
    }

    @objc func setConfiguration(_ call: CAPPluginCall) {
        guard
            let enabled = call.getBool("enabled"),
            let time = call.getString("time"),
            let configuration = PanelMaintenanceConfiguration(enabled: enabled, time: time),
            configurationStore.save(configuration)
        else {
            call.reject("Invalid maintenance configuration")
            return
        }
        NotificationCenter.default.post(name: .panelMaintenanceConfigurationChanged, object: nil)
        call.resolve(payload(for: configuration))
    }

    @objc func runNow(_ call: CAPPluginCall) {
        NotificationCenter.default.post(name: .panelMaintenanceRunRequested, object: nil)
        call.resolve(["accepted": true])
    }

    private func payload(for configuration: PanelMaintenanceConfiguration) -> [String: Any] {
        let nextRun = configuration.enabled
            ? PanelNightlyMaintenanceSchedule(
                hour: configuration.hour,
                minute: configuration.minute,
                calendar: .current
            ).nextDate(after: Date())
            : nil
        return [
            "enabled": configuration.enabled,
            "time": configuration.time,
            "nextRunAtMs": nextRun.map { $0.timeIntervalSince1970 * 1_000 } ?? NSNull(),
        ]
    }
}
