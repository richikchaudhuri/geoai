import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum RepositoryError: Error, LocalizedError, Equatable {
    case invalidConfiguration, secretKeyNotAllowed, invalidPublicKey
    case httpStatus(Int), invalidResponse, incompleteResult, tooManyRows, timedOut
    public var errorDescription: String? {
        switch self {
        case .invalidConfiguration: return "Use an HTTPS Supabase project URL (or a loopback URL for local development)."
        case .secretKeyNotAllowed: return "Server and service-role keys must never be placed in this app. Use a public publishable or anon key."
        case .invalidPublicKey: return "Enter a Supabase publishable key or an anon JWT."
        case .httpStatus(let status): return "The data service returned HTTP \(status)."
        case .invalidResponse: return "The data service returned an invalid response."
        case .incompleteResult: return "The data changed during loading or a complete response could not be verified. Please refresh."
        case .tooManyRows: return "The dataset exceeds the mobile download limit. Narrow the server dataset before retrying."
        case .timedOut: return "Loading the complete dataset took too long. Please try again."
        }
    }
}

public struct SupabaseConfiguration: Sendable {
    public let url: URL
    public let publicKey: String

    /// Validates key *kind*, not cryptographic authenticity. The service verifies
    /// authenticity; privileged server credentials are rejected before networking.
    public init(url: URL, publicKey: String) throws {
        let host = url.host?.lowercased() ?? ""
        let isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard !host.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
              url.scheme?.lowercased() == "https" || (url.scheme?.lowercased() == "http" && isLoopback)
        else { throw RepositoryError.invalidConfiguration }
        let key = publicKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.hasPrefix("sb_secret_") else { throw RepositoryError.secretKeyNotAllowed }
        if key.hasPrefix("sb_publishable_") {
            guard key.count > "sb_publishable_".count,
                  !key.contains(where: { $0.isWhitespace }) else { throw RepositoryError.invalidPublicKey }
        } else {
            let parts = key.split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count == 3, !parts[0].isEmpty, !parts[2].isEmpty else { throw RepositoryError.invalidPublicKey }
            var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
            guard let data = Data(base64Encoded: payload),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let role = object["role"] as? String else { throw RepositoryError.invalidPublicKey }
            guard role == "anon" else { throw RepositoryError.secretKeyNotAllowed }
        }
        self.url = url; self.publicKey = key
    }
}

public actor AssessmentRepository {
    private let configuration: SupabaseConfiguration
    private let session: URLSession
    private let pageSize = 500
    private let maximumRows = 100_000

    public init(configuration: SupabaseConfiguration, session: URLSession = .shared) {
        self.configuration = configuration; self.session = session
    }

    public func loadLive() async throws -> AssessmentDataset {
        async let photos = fetchTable("photos", select: "id,latitude,longitude,address,image_url,created_at,captured_at")
        async let assessments = fetchTable("assessments", select:
            "id,photo_id,latitude,longitude,address,image_url,status,distress_types,severity,stage2_confidence,stage1_confidence,description,processed_at,created_at,expert_reviewed,expert_corrected_types,expert_corrected_severity")
        return try await SnapshotDecoder.merge(photos: photos, assessments: assessments, generatedAt: Date())
    }

    private func fetchTable(_ table: String, select: String) async throws -> [RawRecord] {
        let started = Date()
        var selectedColumns = select
        var rows: [RawRecord] = []
        var seenIDs = Set<String>()
        var expectedTotal: Int?
        var pageCount = 0
        while true {
            try Task.checkCancellation()
            let timeRemaining = 60 - Date().timeIntervalSince(started)
            guard timeRemaining > 0 else { throw RepositoryError.timedOut }
            guard pageCount < 200 else { throw RepositoryError.tooManyRows }
            var components = URLComponents(url: configuration.url.appendingPathComponent("rest/v1/\(table)"), resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "select", value: selectedColumns),
                                     URLQueryItem(name: "order", value: "created_at.desc,id.desc"),
                                     URLQueryItem(name: "limit", value: String(pageSize)),
                                     URLQueryItem(name: "offset", value: String(rows.count))]
            guard let url = components.url else { throw RepositoryError.invalidConfiguration }
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: min(20, timeRemaining))
            request.setValue(configuration.publicKey, forHTTPHeaderField: "apikey")
            // Publishable keys are API gateway keys, not bearer JWTs.
            if !configuration.publicKey.hasPrefix("sb_publishable_") {
                request.setValue("Bearer \(configuration.publicKey)", forHTTPHeaderField: "Authorization")
            }
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue("count=exact", forHTTPHeaderField: "Prefer")
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw RepositoryError.invalidResponse }
            // Older projects can still be browsed before the additive migration.
            // Only a specific missing-column response permits this single retry;
            // authorization failures and unrelated database errors are not hidden.
            if http.statusCode == 400, table == "photos", rows.isEmpty,
               selectedColumns.split(separator: ",").contains("captured_at"),
               data.count <= 64 * 1024,
               let error = try? JSONDecoder().decode(ServiceError.self, from: data),
               ["42703", "PGRST204"].contains(error.code),
               error.message.lowercased().contains("captured_at") {
                selectedColumns = selectedColumns.split(separator: ",").filter { $0 != "captured_at" }.joined(separator: ",")
                continue
            }
            guard (200...299).contains(http.statusCode) else { throw RepositoryError.httpStatus(http.statusCode) }
            guard data.count <= 8 * 1024 * 1024,
                  let range = http.value(forHTTPHeaderField: "Content-Range"),
                  let totalString = range.split(separator: "/").last,
                  let total = Int(totalString), total >= 0 else { throw RepositoryError.incompleteResult }
            guard total <= maximumRows else { throw RepositoryError.tooManyRows }
            if let expectedTotal, expectedTotal != total { throw RepositoryError.incompleteResult }
            expectedTotal = total
            let page = try JSONDecoder().decode([RawRecord].self, from: data)
            guard page.count <= pageSize, rows.count + page.count <= total else { throw RepositoryError.incompleteResult }
            for row in page {
                guard let id = row.id, seenIDs.insert(id).inserted else { throw RepositoryError.incompleteResult }
            }
            rows.append(contentsOf: page)
            pageCount += 1
            if rows.count == total { return rows }
            guard !page.isEmpty else { throw RepositoryError.incompleteResult }
        }
    }

    private struct ServiceError: Decodable {
        let code: String
        let message: String
    }
}
