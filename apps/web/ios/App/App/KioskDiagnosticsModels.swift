import Foundation

struct KioskMemoryWarningEvent: Codable {
    let timestampMs: Int64
    let lifecycleState: String
    let footprintBytes: UInt64
    let peakFootprintBytes: UInt64
}

struct KioskWebContentTerminationEvent: Codable {
    let timestampMs: Int64
    let lifecycleState: String
    let footprintBytes: UInt64
}

struct KioskRecoveryEvent: Codable {
    let timestampMs: Int64
    let trigger: String
    let outcome: String
}

struct KioskMetricKitRecord: Codable {
    let id: String
    let kind: String
    let receivedAtMs: Int64
    let payloadUTF8: String
    let truncated: Bool
}

final class KioskMetricKitArchive {
    private let fileURL: URL
    private let maxRecords: Int
    private let maxPayloadBytes: Int
    private let lock = NSLock()

    init(fileURL: URL, maxRecords: Int = 4, maxPayloadBytes: Int = 64 * 1_024) {
        self.fileURL = fileURL
        self.maxRecords = maxRecords
        self.maxPayloadBytes = maxPayloadBytes
    }

    func append(kind: String, receivedAtMs: Int64, payloadData: Data) {
        lock.lock()
        defer { lock.unlock() }

        var saved = readUnlocked()
        let boundedData = Data(payloadData.prefix(maxPayloadBytes))
        saved.append(
            KioskMetricKitRecord(
                id: UUID().uuidString.lowercased(),
                kind: kind,
                receivedAtMs: receivedAtMs,
                payloadUTF8: String(decoding: boundedData, as: UTF8.self),
                truncated: payloadData.count > maxPayloadBytes
            )
        )
        saved = Array(saved.suffix(maxRecords))
        guard let data = try? JSONEncoder().encode(saved) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    func records() -> [KioskMetricKitRecord] {
        lock.lock()
        defer { lock.unlock() }
        return readUnlocked()
    }

    private func readUnlocked() -> [KioskMetricKitRecord] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([KioskMetricKitRecord].self, from: data)) ?? []
    }
}

// Persisted across launches. New fields must always decode with defaults so an
// installed update can consume the smaller record written by an older build.
struct KioskRunRecord: Codable {
    static let eventHistoryLimit = 16

    let runId: String
    let startedAtMs: Int64
    var lastUpdatedAtMs: Int64
    var lifecycleState: String
    var memoryWarnings: Int
    var warningEvents: [KioskMemoryWarningEvent]
    var webContentTerminations: [KioskWebContentTerminationEvent]
    var recoveryEvents: [KioskRecoveryEvent]
    var footprintBytes: UInt64
    var peakFootprintBytes: UInt64
    var cpuTimeSeconds: Double
    var cpuPercentOfOneCore: Double
    var thermalState: String
    var batteryLevel: Double?
    var batteryState: String
    var appUptimeSeconds: Double
    var systemUptimeSeconds: Double

    static func fresh(runId: String, nowMs: Int64, footprintBytes: UInt64) -> KioskRunRecord {
        KioskRunRecord(
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

    mutating func appendMemoryWarning(_ event: KioskMemoryWarningEvent) {
        memoryWarnings += 1
        warningEvents.append(event)
        warningEvents = Array(warningEvents.suffix(Self.eventHistoryLimit))
    }

    mutating func appendWebContentTermination(_ event: KioskWebContentTerminationEvent) {
        webContentTerminations.append(event)
        webContentTerminations = Array(webContentTerminations.suffix(Self.eventHistoryLimit))
    }

    mutating func appendRecovery(_ event: KioskRecoveryEvent) {
        recoveryEvents.append(event)
        recoveryEvents = Array(recoveryEvents.suffix(Self.eventHistoryLimit))
    }

    private enum CodingKeys: String, CodingKey {
        case runId
        case startedAtMs
        case lastUpdatedAtMs
        case lifecycleState
        case memoryWarnings
        case warningEvents
        case webContentTerminations
        case recoveryEvents
        case footprintBytes
        case peakFootprintBytes
        case cpuTimeSeconds
        case cpuPercentOfOneCore
        case thermalState
        case batteryLevel
        case batteryState
        case appUptimeSeconds
        case systemUptimeSeconds
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        runId = try values.decode(String.self, forKey: .runId)
        startedAtMs = try values.decode(Int64.self, forKey: .startedAtMs)
        lastUpdatedAtMs = try values.decode(Int64.self, forKey: .lastUpdatedAtMs)
        lifecycleState = try values.decode(String.self, forKey: .lifecycleState)
        memoryWarnings = try values.decodeIfPresent(Int.self, forKey: .memoryWarnings) ?? 0
        warningEvents = try values.decodeIfPresent([KioskMemoryWarningEvent].self, forKey: .warningEvents) ?? []
        webContentTerminations = try values.decodeIfPresent(
            [KioskWebContentTerminationEvent].self,
            forKey: .webContentTerminations
        ) ?? []
        recoveryEvents = try values.decodeIfPresent([KioskRecoveryEvent].self, forKey: .recoveryEvents) ?? []
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
        warningEvents: [KioskMemoryWarningEvent],
        webContentTerminations: [KioskWebContentTerminationEvent],
        recoveryEvents: [KioskRecoveryEvent],
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
