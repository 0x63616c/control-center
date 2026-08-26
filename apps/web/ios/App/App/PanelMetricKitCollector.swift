import Foundation
import MetricKit
import os.log

final class PanelMetricKitCollector: NSObject, MXMetricManagerSubscriber {
    static let shared = PanelMetricKitCollector()

    private let archive: PanelMetricKitArchive
    private var deliveredSequences: Set<Int64> = []
    private let deliveryLock = NSLock()
    private var started = false

    private override init() {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        archive = PanelMetricKitArchive(
            fileURL: support.appendingPathComponent("panel-metrickit.json")
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

        let records = archive.records().filter { !deliveredSequences.contains($0.sequence) }
        deliveredSequences.formUnion(records.map(\.sequence))
        return records.compactMap { record in
            guard
                let data = try? JSONEncoder().encode(record),
                let value = try? JSONSerialization.jsonObject(with: data),
                var dictionary = value as? [String: Any]
            else {
                return nil
            }
            // The bounded raw prefix remains available in the durable native
            // archive. Only the small structured evidence crosses into the web
            // logger, whose per-entry bound is 2,000 characters.
            dictionary.removeValue(forKey: "rawPayloadPrefixUTF8")
            return dictionary
        }
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        let nowMs = Self.nowMs()
        for payload in payloads {
            archive.append(
                kind: .metric,
                receivedAtMs: nowMs,
                payloadData: payload.jsonRepresentation()
            )
        }
        os_log("panel diagnostics: received %d MetricKit metric payload(s)", payloads.count)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let nowMs = Self.nowMs()
        for payload in payloads {
            archive.append(
                kind: .diagnostic,
                receivedAtMs: nowMs,
                payloadData: payload.jsonRepresentation()
            )
        }
        os_log("panel diagnostics: received %d MetricKit diagnostic payload(s)", payloads.count)
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }
}
