import Foundation

public enum SnapshotDecodingError: Error, LocalizedError {
    case missingTables
    public var errorDescription: String? { "The snapshot does not contain photo or assessment data." }
}

public enum SnapshotDecoder {
    public static func decode(_ data: Data) throws -> AssessmentDataset {
        let envelope = try JSONDecoder().decode(SnapshotEnvelope.self, from: data)
        guard envelope.photos != nil || envelope.assessments != nil else { throw SnapshotDecodingError.missingTables }
        return merge(photos: envelope.photos ?? [], assessments: envelope.assessments ?? [],
                     generatedAt: parseDate(envelope.fetchedAt))
    }

    static func merge(photos: [RawRecord], assessments: [RawRecord], generatedAt: Date?) -> AssessmentDataset {
        // First insert wins after sorting: older assessments must never replace
        // newer ones, or leak back into the result as duplicate map markers.
        let newest = assessments.sorted {
            let a = $0.createdAt ?? $0.processedAt ?? .distantPast
            let b = $1.createdAt ?? $1.processedAt ?? .distantPast
            if a != b { return a > b }
            if $0.processedAt != $1.processedAt { return ($0.processedAt ?? .distantPast) > ($1.processedAt ?? .distantPast) }
            return ($0.id ?? "") < ($1.id ?? "")
        }
        var canonical: [RawRecord] = []
        var keys = Set<String>()
        for row in newest {
            guard let id = row.id else { continue }
            let key = row.photoID.map { "photo:\($0)" } ?? row.imageURL.map { "image:\($0.absoluteString)" } ?? "id:\(id)"
            if keys.insert(key).inserted { canonical.append(row) }
        }
        var byPhoto: [Int: RawRecord] = [:]
        var byImage: [URL: RawRecord] = [:]
        for row in canonical {
            if let photoID = row.photoID, byPhoto[photoID] == nil { byPhoto[photoID] = row }
            if let url = row.imageURL, byImage[url] == nil { byImage[url] = row }
        }
        var used = Set<String>()
        var seenPhotos = Set<String>()
        var result: [RoadAssessment] = []
        for photo in photos.sorted(by: { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }) {
            guard let photoStringID = photo.id, seenPhotos.insert(photoStringID).inserted else { continue }
            let photoID = Int(photoStringID)
            var assessment = photoID.flatMap { byPhoto[$0] }
            if assessment == nil, let image = photo.imageURL, let candidate = byImage[image],
               candidate.photoID == nil || candidate.photoID == photoID {
                assessment = candidate
            }
            // Duplicate uploads can share an image URL. A legacy assessment
            // can describe only one map item; preserve other photos as pending.
            if let id = assessment?.id, used.contains(id) { assessment = nil }
            if let row = makeAssessment(photo: photo, assessment: assessment) {
                result.append(row)
                if let id = assessment?.id { used.insert(id) }
            }
        }
        for assessment in canonical {
            guard let id = assessment.id, !used.contains(id),
                  let row = makeAssessment(photo: nil, assessment: assessment) else { continue }
            result.append(row)
        }
        result.sort {
            if $0.capturedAt != $1.capturedAt { return ($0.capturedAt ?? .distantPast) > ($1.capturedAt ?? .distantPast) }
            return $0.id < $1.id
        }
        return AssessmentDataset(assessments: result, generatedAt: generatedAt)
    }

    private static func makeAssessment(photo: RawRecord?, assessment: RawRecord?) -> RoadAssessment? {
        guard let coordinates = assessment?.coordinates ?? photo?.coordinates else { return nil }
        guard let id = assessment?.id ?? photo?.id.map({ "photo-\($0)" }) else { return nil }
        let reviewed = assessment?.expertReviewed ?? false
        let types = reviewed ? (assessment?.correctedTypes ?? assessment?.types ?? []) : (assessment?.types ?? [])
        let severity = reviewed
            ? Severity.parse(assessment?.correctedSeverity ?? assessment?.severity)
            : Severity.parse(assessment?.severity)
        let rawConfidence = types.isEmpty ? assessment?.stage1Confidence : assessment?.stage2Confidence
        let confidence = rawConfidence.flatMap { $0.isFinite && (0...1).contains($0) ? $0 : nil }
        let state = assessment.map { AssessmentState(rawValue: $0.status ?? "") ?? .unknown } ?? .pending
        // A present null means the capture time is genuinely unknown. Only
        // older schemas/snapshots without the key retain the upload-time proxy.
        let capturedAt: Date?
        if let photo, photo.hasCapturedAtField {
            capturedAt = photo.capturedAt
        } else {
            capturedAt = photo?.createdAt ?? assessment?.createdAt
        }
        return RoadAssessment(id: id, photoID: photo?.id.flatMap(Int.init) ?? assessment?.photoID,
                              latitude: coordinates.0, longitude: coordinates.1,
                              address: nonempty(assessment?.address) ?? photo?.address ?? "",
                              imageURL: assessment?.imageURL ?? photo?.imageURL,
                              capturedAt: capturedAt,
                              processedAt: assessment?.processedAt, state: state, types: types,
                              severity: severity, confidence: confidence, expertReviewed: reviewed,
                              description: assessment?.description ?? "")
    }

    private static func nonempty(_ string: String?) -> String? {
        guard let string, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return string
    }
}

private struct SnapshotEnvelope: Decodable {
    var photos: [RawRecord]?
    var assessments: [RawRecord]?
    var fetchedAt: String?
}

struct RawRecord: Decodable, Sendable {
    var id: String?
    var photoID: Int?
    var latitude: Double?
    var longitude: Double?
    var address: String?
    var imageURL: URL?
    var capturedAt: Date?
    var hasCapturedAtField: Bool
    var createdAt: Date?
    var processedAt: Date?
    var status: String?
    var types: [String]?
    var severity: String?
    var stage1Confidence: Double?
    var stage2Confidence: Double?
    var expertReviewed: Bool
    var correctedTypes: [String]?
    var correctedSeverity: String?
    var description: String?
    var coordinates: (Double, Double)? {
        guard let latitude, let longitude, latitude.isFinite, longitude.isFinite,
              abs(latitude) <= 90, abs(longitude) <= 180 else { return nil }
        return (latitude, longitude)
    }
    enum CodingKeys: String, CodingKey {
        case id, latitude, longitude, address, status, severity, description
        case photoID = "photo_id", imageURL = "image_url", createdAt = "created_at", processedAt = "processed_at"
        case capturedAt = "captured_at"
        case types = "distress_types", stage1Confidence = "stage1_confidence", stage2Confidence = "stage2_confidence"
        case expertReviewed = "expert_reviewed", correctedTypes = "expert_corrected_types", correctedSeverity = "expert_corrected_severity"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) -> String? {
            if let s = try? c.decode(String.self, forKey: key) { return s }
            return (try? c.decode(Int.self, forKey: key)).map(String.init)
        }
        func number(_ key: CodingKeys) -> Double? {
            (try? c.decode(Double.self, forKey: key)) ?? text(key).flatMap(Double.init)
        }
        id = text(.id); photoID = text(.photoID).flatMap(Int.init)
        latitude = number(.latitude); longitude = number(.longitude)
        address = text(.address)
        imageURL = text(.imageURL).flatMap(URL.init(string:)).flatMap {
            guard ["https", "http"].contains($0.scheme?.lowercased() ?? ""), $0.host != nil else { return nil }
            return $0
        }
        capturedAt = parseDate(text(.capturedAt))
        hasCapturedAtField = c.contains(.capturedAt)
        createdAt = parseDate(text(.createdAt)); processedAt = parseDate(text(.processedAt))
        status = text(.status); severity = text(.severity); description = text(.description)
        types = try? c.decode([String].self, forKey: .types)
        correctedTypes = try? c.decode([String].self, forKey: .correctedTypes)
        correctedSeverity = text(.correctedSeverity)
        expertReviewed = (try? c.decode(Bool.self, forKey: .expertReviewed)) ?? false
        stage1Confidence = number(.stage1Confidence); stage2Confidence = number(.stage2Confidence)
    }
}

func parseDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
}
