import Capacitor
import Darwin
import Foundation
import UIKit
import os.log

enum KioskLifecycleState: String {
    case launching
    case inactive
    case background
    case foreground
    case active
    case terminating
}

extension Notification.Name {
    static let kioskMemoryPressureRecoveryRequested = Notification.Name(
        "co.worldwidewebb.kioskMemoryPressureRecoveryRequested"
    )
}

/**
 * Durable process-lifecycle evidence for the unattended wall panel.
 *
 * iOS jetsam does not call applicationWillTerminate and JavaScript receives no
 * final event. The current run is therefore written atomically every five
 * minutes and on every lifecycle or memory-warning transition. A new process
 * reads that file before replacing it, preserving the previous process's last
 * known state and physical footprint for the web logger to ship.
 */
final class KioskDiagnosticsRecorder {
    static let shared = KioskDiagnosticsRecorder()

    private let fileURL: URL
    private var currentRun: KioskRunRecord?
    private var previousRun: KioskRunRecord?
    private var timer: Timer?
    private var lastCPUSampleSeconds: Double?
    private var lastCPUSampleAtMs: Int64?

    private init() {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        try? FileManager.default.createDirectory(
            at: support,
            withIntermediateDirectories: true
        )
        fileURL = support.appendingPathComponent("kiosk-process-diagnostics.json")
    }

    func start() {
        guard currentRun == nil else { return }
        previousRun = readPersistedRun()
        let now = Self.nowMs()
        let footprint = physicalFootprintBytes()
        currentRun = KioskRunRecord.fresh(
            runId: UUID().uuidString.lowercased(),
            nowMs: now,
            footprintBytes: footprint
        )
        UIDevice.current.isBatteryMonitoringEnabled = true
        sampleCurrentRun(nowMs: now)
        persistCurrentRun()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onMemoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )

        let timer = Timer(timeInterval: 5 * 60, repeats: true) { [weak self] _ in
            self?.sampleAndPersist()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func transition(to lifecycleState: KioskLifecycleState) {
        guard currentRun != nil else { return }
        currentRun?.lifecycleState = lifecycleState.rawValue
        sampleAndPersist()
    }

    func snapshot() -> [String: Any] {
        start()
        sampleAndPersist()
        guard let currentRun else { return [:] }

        var result: [String: Any] = [
            "currentRun": dictionary(for: currentRun),
            "physicalMemoryBytes": ProcessInfo.processInfo.physicalMemory,
            "osVersion": UIDevice.current.systemVersion,
        ]
        if let previousRun {
            result["previousRun"] = dictionary(for: previousRun)
        }
        let metricKitRecords = KioskMetricKitCollector.shared.takeUndeliveredRecords()
        if !metricKitRecords.isEmpty {
            result["metricKitRecords"] = metricKitRecords
        }
        return result
    }

    func recordWebContentTermination() {
        guard currentRun != nil else { return }
        sampleAndPersist()
        guard let run = currentRun else { return }
        currentRun?.appendWebContentTermination(
            KioskWebContentTerminationEvent(
                timestampMs: Self.nowMs(),
                lifecycleState: run.lifecycleState,
                footprintBytes: run.footprintBytes
            )
        )
        persistCurrentRun()
        os_log("kiosk diagnostics: WebKit content process terminated, footprint=%llu", run.footprintBytes)
    }

    func recordRecovery(trigger: String, outcome: String) {
        guard currentRun != nil else { return }
        currentRun?.appendRecovery(
            KioskRecoveryEvent(
                timestampMs: Self.nowMs(),
                trigger: trigger,
                outcome: outcome
            )
        )
        persistCurrentRun()
    }

    @objc private func onMemoryWarning() {
        guard currentRun != nil else { return }
        sampleAndPersist()
        guard let run = currentRun else { return }
        currentRun?.appendMemoryWarning(
            KioskMemoryWarningEvent(
                timestampMs: Self.nowMs(),
                lifecycleState: run.lifecycleState,
                footprintBytes: run.footprintBytes,
                peakFootprintBytes: run.peakFootprintBytes
            )
        )
        // Persist before asking the controller to reload: if iOS kills the app
        // during recovery, the warning and exact pre-recovery sample survive.
        persistCurrentRun()
        os_log("kiosk diagnostics: memory warning, footprint=%llu", run.footprintBytes)
        NotificationCenter.default.post(name: .kioskMemoryPressureRecoveryRequested, object: nil)
    }

    private func sampleAndPersist() {
        guard currentRun != nil else { return }
        sampleCurrentRun(nowMs: Self.nowMs())
        persistCurrentRun()
    }

    private func sampleCurrentRun(nowMs: Int64) {
        guard var run = currentRun else { return }
        let footprint = physicalFootprintBytes()
        let cpuSeconds = processCPUTimeSeconds()
        let elapsedSeconds = lastCPUSampleAtMs.map { Double(nowMs - $0) / 1_000 }
        let cpuDelta = lastCPUSampleSeconds.map { cpuSeconds - $0 }

        run.lastUpdatedAtMs = nowMs
        run.footprintBytes = footprint
        run.peakFootprintBytes = max(run.peakFootprintBytes, footprint)
        run.cpuTimeSeconds = cpuSeconds
        if let elapsedSeconds, elapsedSeconds > 0, let cpuDelta, cpuDelta >= 0 {
            run.cpuPercentOfOneCore = (cpuDelta / elapsedSeconds) * 100
        }
        run.thermalState = thermalStateName(ProcessInfo.processInfo.thermalState)
        let level = UIDevice.current.batteryLevel
        run.batteryLevel = level >= 0 ? Double(level) * 100 : nil
        run.batteryState = batteryStateName(UIDevice.current.batteryState)
        run.appUptimeSeconds = max(0, Double(nowMs - run.startedAtMs) / 1_000)
        run.systemUptimeSeconds = ProcessInfo.processInfo.systemUptime
        currentRun = run
        lastCPUSampleSeconds = cpuSeconds
        lastCPUSampleAtMs = nowMs
    }

    private func persistCurrentRun() {
        guard let currentRun else { return }
        do {
            let data = try JSONEncoder().encode(currentRun)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            os_log("kiosk diagnostics: persist failed: %@", error.localizedDescription)
        }
    }

    private func readPersistedRun() -> KioskRunRecord? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(KioskRunRecord.self, from: data)
    }

    private func dictionary(for record: KioskRunRecord) -> [String: Any] {
        guard
            let data = try? JSONEncoder().encode(record),
            let value = try? JSONSerialization.jsonObject(with: data),
            let dictionary = value as? [String: Any]
        else {
            return [:]
        }
        return dictionary
    }

    private func physicalFootprintBytes() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
        )
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
            }
        }
        return status == KERN_SUCCESS ? UInt64(info.phys_footprint) : 0
    }

    private func processCPUTimeSeconds() -> Double {
        var usage = rusage()
        guard getrusage(RUSAGE_SELF, &usage) == 0 else { return 0 }
        let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1_000_000
        let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1_000_000
        return user + system
    }

    private func thermalStateName(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    private func batteryStateName(_ state: UIDevice.BatteryState) -> String {
        switch state {
        case .unknown: return "unknown"
        case .unplugged: return "unplugged"
        case .charging: return "charging"
        case .full: return "full"
        @unknown default: return "unknown"
        }
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }
}

@objc(KioskDiagnosticsPlugin)
public class KioskDiagnosticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KioskDiagnosticsPlugin"
    public let jsName = "KioskDiagnostics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSnapshot", returnType: CAPPluginReturnPromise),
    ]

    @objc func getSnapshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(KioskDiagnosticsRecorder.shared.snapshot())
        }
    }
}
