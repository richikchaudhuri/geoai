import Foundation

public enum Severity: String, Codable, CaseIterable, Sendable {
    case low = "Low", moderate = "Medium", high = "High", none = "None", unknown = "Unknown"
    public var title: String {
        switch self {
        case .low: return "Less"
        case .moderate: return "Moderate"
        case .high: return "Red Alert"
        case .none: return "None"
        case .unknown: return "Unknown"
        }
    }
    public var rank: Int {
        switch self {
        case .high: return 3
        case .moderate: return 2
        case .low: return 1
        case .none: return 0
        case .unknown: return -1
        }
    }
    static func parse(_ value: String?) -> Self {
        switch value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "low", "less": return .low
        case "medium", "moderate": return .moderate
        case "high", "red alert": return .high
        case "none": return .none
        default: return .unknown
        }
    }
}

public enum DayPeriod: String, Codable, CaseIterable, Sendable {
    case day, night, unknown
    public var title: String { rawValue.capitalized }
}

public enum AssessmentState: String, Codable, CaseIterable, Sendable {
    case pending, processing, classified, expertReview = "expert_review", done, failed
    case rejected = "rejected_non_pavement", unknown
    public var title: String {
        switch self {
        case .pending: return "Awaiting assessment"
        case .processing: return "Processing"
        case .classified: return "Assessed"
        case .expertReview: return "Awaiting expert review"
        case .done: return "Reviewed"
        case .failed: return "Assessment failed"
        case .rejected: return "Not pavement"
        case .unknown: return "Unknown"
        }
    }
}

public struct RoadAssessment: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var photoID: Int?
    public var latitude: Double
    public var longitude: Double
    public var address: String
    public var imageURL: URL?
    public var capturedAt: Date?
    public var processedAt: Date?
    public var state: AssessmentState
    public var types: [String]
    public var severity: Severity
    public var confidence: Double?
    public var expertReviewed: Bool
    public var description: String

    public init(id: String, photoID: Int? = nil, latitude: Double, longitude: Double,
                address: String = "", imageURL: URL? = nil, capturedAt: Date? = nil,
                processedAt: Date? = nil, state: AssessmentState = .pending, types: [String] = [],
                severity: Severity = .unknown, confidence: Double? = nil,
                expertReviewed: Bool = false, description: String = "") {
        self.id = id; self.photoID = photoID; self.latitude = latitude; self.longitude = longitude
        self.address = address; self.imageURL = imageURL; self.capturedAt = capturedAt
        self.processedAt = processedAt; self.state = state; self.types = types
        self.severity = severity; self.confidence = confidence
        self.expertReviewed = expertReviewed; self.description = description
    }

    public var isAssessed: Bool {
        switch state {
        case .classified, .expertReview, .done: return true
        case .unknown: return expertReviewed || !types.isEmpty
        default: return false
        }
    }

    public var primaryType: String {
        guard isAssessed else { return state.title }
        return types.first ?? "Normal pavement"
    }

    /// Civil twilight (-6° solar elevation) is the boundary. Computed from
    /// capture time and coordinates, independent of the phone's time zone.
    public var dayPeriod: DayPeriod {
        guard let capturedAt, latitude.isFinite, longitude.isFinite,
              abs(latitude) <= 90, abs(longitude) <= 180 else { return .unknown }
        let rad = Double.pi / 180
        let days = capturedAt.timeIntervalSince1970 / 86400 + 2440587.5 - 2451545
        let meanAnomaly = rad * (357.5291 + 0.98560028 * days)
        let center = rad * (1.9148 * sin(meanAnomaly) + 0.02 * sin(2 * meanAnomaly) + 0.0003 * sin(3 * meanAnomaly))
        let longitudeSun = meanAnomaly + center + rad * 102.9372 + Double.pi
        let obliquity = rad * 23.4397
        let declination = asin(sin(longitudeSun) * sin(obliquity))
        let rightAscension = atan2(sin(longitudeSun) * cos(obliquity), cos(longitudeSun))
        let hourAngle = rad * (280.16 + 360.9856235 * days + longitude) - rightAscension
        let latitudeRadians = latitude * rad
        let sineElevation = sin(latitudeRadians) * sin(declination)
            + cos(latitudeRadians) * cos(declination) * cos(hourAngle)
        let elevation = asin(min(1, max(-1, sineElevation))) / rad
        return elevation >= -6 ? .day : .night
    }
}

public struct AssessmentDataset: Equatable, Sendable {
    public var assessments: [RoadAssessment]
    public var generatedAt: Date?
    public init(assessments: [RoadAssessment], generatedAt: Date? = nil) {
        self.assessments = assessments; self.generatedAt = generatedAt
    }
}

public struct AssessmentFilter: Sendable {
    public var severity: Severity?
    public var dayPeriod: DayPeriod?
    public var query: String
    public init(severity: Severity? = nil, dayPeriod: DayPeriod? = nil, query: String = "") {
        self.severity = severity; self.dayPeriod = dayPeriod; self.query = query
    }
    public func apply(to assessments: [RoadAssessment]) -> [RoadAssessment] {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return assessments.filter { row in
            (severity == nil || row.severity == severity)
                && (dayPeriod == nil || row.dayPeriod == dayPeriod)
                && (search.isEmpty || ([row.address, row.primaryType, row.description, row.state.title, row.state.rawValue] + row.types)
                    .contains { $0.localizedStandardContains(search) })
        }
    }
}
