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

private struct KioskRunRecord: Codable {
    let runId: String
    let startedAtMs: Int64
    var lastUpdatedAtMs: Int64
    var lifecycleState: String
    var memoryWarnings: Int
    var footprintBytes: UInt64
    var peakFootprintBytes: UInt64
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

    private init() {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
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
        currentRun = KioskRunRecord(
            runId: UUID().uuidString.lowercased(),
            startedAtMs: now,
            lastUpdatedAtMs: now,
            lifecycleState: KioskLifecycleState.launching.rawValue,
            memoryWarnings: 0,
            footprintBytes: footprint,
            peakFootprintBytes: footprint
        )
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
        return result
    }

    @objc private func onMemoryWarning() {
        guard currentRun != nil else { return }
        currentRun?.memoryWarnings += 1
        sampleAndPersist()
        os_log("kiosk diagnostics: memory warning, footprint=%llu", currentRun?.footprintBytes ?? 0)
    }

    private func sampleAndPersist() {
        guard var run = currentRun else { return }
        let footprint = physicalFootprintBytes()
        run.lastUpdatedAtMs = Self.nowMs()
        run.footprintBytes = footprint
        run.peakFootprintBytes = max(run.peakFootprintBytes, footprint)
        currentRun = run
        persistCurrentRun()
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
