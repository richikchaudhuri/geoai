import Foundation

enum CaptureUploadError: LocalizedError {
    case configuration(String)
    case invalidResponse
    case cloudRejected(Int)
    case lookupRejected(Int)
    case metadataRejected(Int)
    case uncertainMetadata
    case unresolvedSubmission
    case captureTimeMigrationRequired

    var isDefinitiveMetadataRejection: Bool {
        if case .captureTimeMigrationRequired = self { return true }
        if case .metadataRejected(let code) = self { return (400..<500).contains(code) }
        return false
    }

    var errorDescription: String? {
        switch self {
        case .configuration(let message): return message
        case .invalidResponse: return "The service returned an unreadable response. Your draft is still saved."
        case .cloudRejected(let code): return "The photo service rejected this upload (HTTP \(code)). Check the unsigned upload preset, then try again."
        case .lookupRejected(let code): return "Could not check whether this report was received (HTTP \(code)). Your draft is still saved. Check the public read policy and project settings."
        case .metadataRejected(let code): return "The report service rejected this submission (HTTP \(code)). The uploaded photo is saved for retry. Check the photos insert policy and project settings."
        case .uncertainMetadata: return "The connection ended before receipt was confirmed. Your draft is saved. Check its status before sending it again."
        case .unresolvedSubmission: return "No matching report is visible yet. Check again shortly. If you decide to resend, use ‘Retry sending report’ below."
        case .captureTimeMigrationRequired: return "This project needs the capture-time database update. Apply Backend/001_photos_captured_at.sql in Supabase, then retry this saved report. Its uploaded photo and timestamp are kept."
        }
    }
}

actor CaptureUploadClient {
    private let configuration: CaptureConfiguration
    private let session: URLSession

    init(configuration: CaptureConfiguration, session: URLSession? = nil) {
        self.configuration = configuration
        if let session {
            self.session = session
            return
        }
        let settings = URLSessionConfiguration.ephemeral
        settings.timeoutIntervalForRequest = 60
        settings.timeoutIntervalForResource = 180
        settings.waitsForConnectivity = false
        settings.urlCache = nil
        settings.httpCookieStorage = nil
        self.session = URLSession(configuration: settings)
    }

    private func validate() throws {
        if let issue = configuration.setupIssue { throw CaptureUploadError.configuration(issue) }
    }

    func uploadImage(_ image: Data) async throws -> URL {
        try validate()
        guard let url = URL(string: "https://api.cloudinary.com/v1_1/\(configuration.cloudinaryCloudName)/image/upload") else {
            throw CaptureUploadError.invalidResponse
        }
        let boundary = "GeoAI-\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"upload_preset\"\r\n\r\n")
        append(configuration.cloudinaryUploadPreset)
        append("\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"report.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n")
        body.append(image)
        append("\r\n--\(boundary)--\r\n")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.upload(for: request, from: body)
        guard let http = response as? HTTPURLResponse else { throw CaptureUploadError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw CaptureUploadError.cloudRejected(http.statusCode) }
        struct UploadResponse: Decodable { let secure_url: String }
        guard let reply = try? JSONDecoder().decode(UploadResponse.self, from: data),
              let imageURL = URL(string: reply.secure_url), imageURL.scheme == "https", imageURL.host != nil else {
            throw CaptureUploadError.invalidResponse
        }
        return imageURL
    }

    private func photosURL() throws -> URL {
        try validate()
        guard let base = configuration.supabaseURL else { throw CaptureUploadError.invalidResponse }
        return base.appendingPathComponent("rest/v1/photos")
    }

    private func authorize(_ request: inout URLRequest) {
        request.setValue(configuration.supabasePublicKey, forHTTPHeaderField: "apikey")
        if configuration.hasJWTKey {
            request.setValue("Bearer \(configuration.supabasePublicKey)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
    }

    func reportExists(imageURL: URL) async throws -> Bool {
        var components = URLComponents(url: try photosURL(), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "select", value: "id"),
                                  URLQueryItem(name: "image_url", value: "eq.\(imageURL.absoluteString)"),
                                  URLQueryItem(name: "limit", value: "1")]
        guard let url = components?.url else { throw CaptureUploadError.invalidResponse }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        authorize(&request)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CaptureUploadError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw CaptureUploadError.lookupRejected(http.statusCode) }
        guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw CaptureUploadError.invalidResponse
        }
        return !rows.isEmpty
    }

    func insertReport(imageURL: URL, latitude: Double, longitude: Double, address: String, capturedAt: Date? = nil) async throws {
        var request = URLRequest(url: try photosURL())
        request.httpMethod = "POST"
        authorize(&request)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        var payload: [String: Any] = [
            "image_url": imageURL.absoluteString, "latitude": latitude,
            "longitude": longitude, "address": address
        ]
        if let capturedAt {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            payload["captured_at"] = formatter.string(from: capturedAt)
        } else { payload["captured_at"] = NSNull() }
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let response: URLResponse
        let data: Data
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw CaptureUploadError.uncertainMetadata
        }
        guard let http = response as? HTTPURLResponse else { throw CaptureUploadError.uncertainMetadata }
        guard (200..<300).contains(http.statusCode) else {
            let details = String(data: data, encoding: .utf8)?.lowercased() ?? ""
            if (400..<500).contains(http.statusCode), details.contains("captured_at"),
               details.contains("pgrst204") || details.contains("42703") || details.contains("column") {
                throw CaptureUploadError.captureTimeMigrationRequired
            }
            if (400..<500).contains(http.statusCode) { throw CaptureUploadError.metadataRejected(http.statusCode) }
            throw CaptureUploadError.uncertainMetadata
        }
    }
}
