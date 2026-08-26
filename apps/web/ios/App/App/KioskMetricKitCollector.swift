import Foundation
import MetricKit
import os.log

final class KioskMetricKitCollector: NSObject, MXMetricManagerSubscriber {
    static let shared = KioskMetricKitCollector()

    private let archive: KioskMetricKitArchive
    private var deliveredRecordIds: Set<String> = []
    private let deliveryLock = NSLock()
    private var started = false

    private override init() {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        archive = KioskMetricKitArchive(
            fileURL: support.appendingPathComponent("kiosk-metrickit.json")
        )
        super.init()
    }

    func start() {
        guard !started else { return }
        started = true
        MXMetricManager.shared.add(self)
    }

    func takeUndeliveredRecords() -> [[String: Any]] {
        deliveryLock.lock()
        defer { deliveryLock.unlock() }

        let records = archive.records().filter { !deliveredRecordIds.contains($0.id) }
        deliveredRecordIds.formUnion(records.map(\.id))
        return records.compactMap { record in
            guard
                let data = try? JSONEncoder().encode(record),
                let value = try? JSONSerialization.jsonObject(with: data),
                let dictionary = value as? [String: Any]
            else {
                return nil
            }
            return dictionary
        }
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        let nowMs = Self.nowMs()
        for payload in payloads {
            archive.append(
                kind: "metric",
                receivedAtMs: nowMs,
                payloadData: payload.jsonRepresentation()
            )
        }
        os_log("kiosk diagnostics: received %d MetricKit metric payload(s)", payloads.count)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let nowMs = Self.nowMs()
        for payload in payloads {
            archive.append(
                kind: "diagnostic",
                receivedAtMs: nowMs,
                payloadData: payload.jsonRepresentation()
            )
        }
        os_log("kiosk diagnostics: received %d MetricKit diagnostic payload(s)", payloads.count)
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }
}
