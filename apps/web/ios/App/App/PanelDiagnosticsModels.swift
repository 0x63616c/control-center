import Foundation

struct PanelMemoryWarningEvent: Codable {
    let timestampMs: Int64
    let lifecycleState: String
    let footprintBytes: UInt64
    let peakFootprintBytes: UInt64
}

struct PanelWebContentTerminationEvent: Codable {
    let timestampMs: Int64
    let lifecycleState: String
    let footprintBytes: UInt64
}

enum PanelRecoveryTrigger: String, Codable {
    case memoryWarning = "memory-warning"
}

enum PanelRecoveryOutcome: String, Codable {
    case authenticatedOriginReload = "authenticated-origin-reload"
    case suppressedByLoopProtection = "suppressed-by-loop-protection"
}

struct PanelRecoveryEvent: Codable {
    let timestampMs: Int64
    let trigger: PanelRecoveryTrigger
    let outcome: PanelRecoveryOutcome
}

enum PanelMetricKitPayloadKind: String, Codable {
    case metric
    case diagnostic
}

struct PanelMetricKitEvidence: Codable {
    let path: String
    let value: String
}

struct PanelMetricKitRecord: Codable {
    let sequence: Int64
    let kind: PanelMetricKitPayloadKind
    let receivedAtMs: Int64
    let rawPayloadPrefixUTF8: String
    let rawPayloadBytes: Int
    let truncated: Bool
    let evidence: [PanelMetricKitEvidence]
}

final class PanelMetricKitArchive {
    private struct EvidenceCandidate {
        let evidence: PanelMetricKitEvidence
        let insertionIndex: Int
    }

    private let fileURL: URL
    private let maxRecords: Int
    private let maxPayloadBytes: Int
    private let lock = NSLock()

    init(fileURL: URL, maxRecords: Int = 4, maxPayloadBytes: Int = 64 * 1_024) {
        self.fileURL = fileURL
        self.maxRecords = maxRecords
        self.maxPayloadBytes = maxPayloadBytes
    }

    func append(kind: PanelMetricKitPayloadKind, receivedAtMs: Int64, payloadData: Data) {
        lock.lock()
        defer { lock.unlock() }

        var saved = readUnlocked()
        let boundedData = Data(payloadData.prefix(maxPayloadBytes))
        let nextSequence = (saved.map(\.sequence).max() ?? 0) + 1
        saved.append(
            PanelMetricKitRecord(
                sequence: nextSequence,
                kind: kind,
                receivedAtMs: receivedAtMs,
                rawPayloadPrefixUTF8: String(decoding: boundedData, as: UTF8.self),
                rawPayloadBytes: payloadData.count,
                truncated: payloadData.count > maxPayloadBytes,
                // Extract from the complete payload before bounding the raw copy.
                // A byte prefix may not be valid JSON, but the required exit and
                // peak-memory evidence remains valid structured data.
                evidence: Self.extractEvidence(from: payloadData)
            )
        )
        saved = Array(saved.suffix(maxRecords))
        guard let data = try? JSONEncoder().encode(saved) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    func records() -> [PanelMetricKitRecord] {
        lock.lock()
        defer { lock.unlock() }
        return readUnlocked()
    }

    private func readUnlocked() -> [PanelMetricKitRecord] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([PanelMetricKitRecord].self, from: data)) ?? []
    }

    private static func extractEvidence(from data: Data) -> [PanelMetricKitEvidence] {
        guard let root = try? JSONSerialization.jsonObject(with: data) else { return [] }
        var candidates: [EvidenceCandidate] = []

        func visit(_ value: Any, path: [String]) {
            guard candidates.count < 200 else { return }
            if let dictionary = value as? [String: Any] {
                for (key, child) in dictionary {
                    visit(child, path: path + [key])
                }
                return
            }
            if let array = value as? [Any] {
                for (index, child) in array.enumerated() {
                    visit(child, path: path + [String(index)])
                }
                return
            }

            let joinedPath = path.joined(separator: ".")
            guard joinedPath.range(
                of: "memory|exit|crash|hang|cpu|thermal|termination|peak|jetsam",
                options: [.regularExpression, .caseInsensitive]
            ) != nil else { return }
            let renderedValue = value is NSNull ? "null" : String(describing: value)
            candidates.append(
                EvidenceCandidate(
                    evidence: PanelMetricKitEvidence(
                        path: String(joinedPath.prefix(120)),
                        value: String(renderedValue.prefix(80))
                    ),
                    insertionIndex: candidates.count
                )
            )
        }

        visit(root, path: [])
        return candidates
            .sorted {
                let leftScore = evidenceScore($0.evidence.path)
                let rightScore = evidenceScore($1.evidence.path)
                return leftScore == rightScore
                    ? $0.insertionIndex < $1.insertionIndex
                    : leftScore < rightScore
            }
            .prefix(8)
            .map(\.evidence)
    }

    private static func evidenceScore(_ path: String) -> Int {
        let lower = path.lowercased()
        if lower.contains("memoryresourcelimit") || lower.contains("jetsam") { return 0 }
        if lower.contains("termination") || lower.contains("exit") { return 1 }
        if lower.contains("peak") && lower.contains("memory") { return 2 }
        if lower.contains("crash") { return 3 }
        if lower.contains("hang") { return 4 }
        if lower.contains("memory") { return 5 }
        if lower.contains("cpu") { return 6 }
        return 7
    }
}

// Persisted across launches. New fields must always decode with defaults so an
// installed update can consume the smaller record written by an older build.
struct PanelRunRecord: Codable {
    static let eventHistoryLimit = 16

    let runId: String
    let startedAtMs: Int64
    var lastUpdatedAtMs: Int64
    var lifecycleState: String
    var memoryWarnings: Int
    var warningEvents: [PanelMemoryWarningEvent]
    var webContentTerminations: [PanelWebContentTerminationEvent]
    var recoveryEvents: [PanelRecoveryEvent]
    var footprintBytes: UInt64
    var peakFootprintBytes: UInt64
    var cpuTimeSeconds: Double
    var cpuPercentOfOneCore: Double
    var thermalState: String
    var batteryLevel: Double?
    var batteryState: String
    var appUptimeSeconds: Double
    var systemUptimeSeconds: Double

    static func fresh(runId: String, nowMs: Int64, footprintBytes: UInt64) -> PanelRunRecord {
        PanelRunRecord(
            runId: runId,
            startedAtMs: nowMs,
            lastUpdatedAtMs: nowMs,
            lifecycleState: "launching",
            memoryWarnings: 0,
            warningEvents: [],
            webContentTerminations: [],
            recoveryEvents: [],
            footprintBytes: footprintBytes,
            peakFootprintBytes: footprintBytes,
            cpuTimeSeconds: 0,
            cpuPercentOfOneCore: 0,
            thermalState: "unknown",
            batteryLevel: nil,
            batteryState: "unknown",
            appUptimeSeconds: 0,
            systemUptimeSeconds: 0
        )
    }

    mutating func appendMemoryWarning(_ event: PanelMemoryWarningEvent) {
        memoryWarnings += 1
        warningEvents.append(event)
        warningEvents = Array(warningEvents.suffix(Self.eventHistoryLimit))
    }

    mutating func appendWebContentTermination(_ event: PanelWebContentTerminationEvent) {
        webContentTerminations.append(event)
        webContentTerminations = Array(webContentTerminations.suffix(Self.eventHistoryLimit))
    }

    mutating func appendRecovery(_ event: PanelRecoveryEvent) {
        recoveryEvents.append(event)
        recoveryEvents = Array(recoveryEvents.suffix(Self.eventHistoryLimit))
    }

    private enum CodingKeys: String, CodingKey {
        case runId, startedAtMs, lastUpdatedAtMs, lifecycleState, memoryWarnings
        case warningEvents, webContentTerminations, recoveryEvents
        case footprintBytes, peakFootprintBytes, cpuTimeSeconds, cpuPercentOfOneCore
        case thermalState, batteryLevel, batteryState, appUptimeSeconds, systemUptimeSeconds
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        runId = try values.decode(String.self, forKey: .runId)
        startedAtMs = try values.decode(Int64.self, forKey: .startedAtMs)
        lastUpdatedAtMs = try values.decode(Int64.self, forKey: .lastUpdatedAtMs)
        lifecycleState = try values.decode(String.self, forKey: .lifecycleState)
        memoryWarnings = try values.decodeIfPresent(Int.self, forKey: .memoryWarnings) ?? 0
        warningEvents = try values.decodeIfPresent([PanelMemoryWarningEvent].self, forKey: .warningEvents) ?? []
        webContentTerminations = try values.decodeIfPresent(
            [PanelWebContentTerminationEvent].self,
            forKey: .webContentTerminations
        ) ?? []
        recoveryEvents = try values.decodeIfPresent([PanelRecoveryEvent].self, forKey: .recoveryEvents) ?? []
        footprintBytes = try values.decodeIfPresent(UInt64.self, forKey: .footprintBytes) ?? 0
        peakFootprintBytes = try values.decodeIfPresent(UInt64.self, forKey: .peakFootprintBytes) ?? footprintBytes
        cpuTimeSeconds = try values.decodeIfPresent(Double.self, forKey: .cpuTimeSeconds) ?? 0
        cpuPercentOfOneCore = try values.decodeIfPresent(Double.self, forKey: .cpuPercentOfOneCore) ?? 0
        thermalState = try values.decodeIfPresent(String.self, forKey: .thermalState) ?? "unknown"
        batteryLevel = try values.decodeIfPresent(Double.self, forKey: .batteryLevel)
        batteryState = try values.decodeIfPresent(String.self, forKey: .batteryState) ?? "unknown"
        appUptimeSeconds = try values.decodeIfPresent(Double.self, forKey: .appUptimeSeconds) ?? 0
        systemUptimeSeconds = try values.decodeIfPresent(Double.self, forKey: .systemUptimeSeconds) ?? 0
    }

    private init(
        runId: String,
        startedAtMs: Int64,
        lastUpdatedAtMs: Int64,
        lifecycleState: String,
        memoryWarnings: Int,
        warningEvents: [PanelMemoryWarningEvent],
        webContentTerminations: [PanelWebContentTerminationEvent],
        recoveryEvents: [PanelRecoveryEvent],
        footprintBytes: UInt64,
        peakFootprintBytes: UInt64,
        cpuTimeSeconds: Double,
        cpuPercentOfOneCore: Double,
        thermalState: String,
        batteryLevel: Double?,
        batteryState: String,
        appUptimeSeconds: Double,
        systemUptimeSeconds: Double
    ) {
        self.runId = runId
        self.startedAtMs = startedAtMs
        self.lastUpdatedAtMs = lastUpdatedAtMs
        self.lifecycleState = lifecycleState
        self.memoryWarnings = memoryWarnings
        self.warningEvents = warningEvents
        self.webContentTerminations = webContentTerminations
        self.recoveryEvents = recoveryEvents
        self.footprintBytes = footprintBytes
        self.peakFootprintBytes = peakFootprintBytes
        self.cpuTimeSeconds = cpuTimeSeconds
        self.cpuPercentOfOneCore = cpuPercentOfOneCore
        self.thermalState = thermalState
        self.batteryLevel = batteryLevel
        self.batteryState = batteryState
        self.appUptimeSeconds = appUptimeSeconds
        self.systemUptimeSeconds = systemUptimeSeconds
    }
}
