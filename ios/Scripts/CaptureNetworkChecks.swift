// Foundation-only checks. Every HTTP request is intercepted by URLProtocol.
// This program never contacts Cloudinary or Supabase and contains no real keys.
import Foundation
import Darwin

private struct CheckFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw CheckFailure(message) }
}

private final class CaptureMockProtocol: URLProtocol {
    struct Reply {
        var status: Int = 200
        var body: Data = Data()
        var error: URLError?
        init(status: Int = 200, json: String = "", error: URLError? = nil) {
            self.status = status
            self.body = Data(json.utf8)
            self.error = error
        }
    }
    static var handler: ((URLRequest) throws -> Reply)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw CheckFailure("Unexpected HTTP request") }
            let reply = try handler(request)
            if let error = reply.error { throw error }
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: reply.status,
                                                  httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]) else {
                throw CheckFailure("Invalid mock response")
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.body)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private func requestBody(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        result.append(contentsOf: buffer.prefix(count))
    }
    return result
}

private func key(role: String) -> String {
    let payload = Data("{\"role\":\"\(role)\"}".utf8).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    return "test-header.\(payload).test-signature"
}

@main
private struct CaptureNetworkChecks {
    static func main() async {
        do {
            try await run()
            print("PASS — all 17 capture network/configuration/metadata checks; no external requests")
        } catch {
            fputs("FAIL — \(error)\n", stderr)
            exit(1)
        }
    }

    private static func run() async throws {
        let settings = URLSessionConfiguration.ephemeral
        settings.protocolClasses = [CaptureMockProtocol.self]
        let session = URLSession(configuration: settings)
        defer { session.invalidateAndCancel() }
        let projectURL = URL(string: "https://capture-unit-test.supabase.co")!
        let publicKey = "sb_publishable_LOCAL_TEST_ONLY"
        func configuration(_ keyValue: String = publicKey) -> CaptureConfiguration {
            CaptureConfiguration(supabaseURL: projectURL, supabasePublicKey: keyValue,
                                 cloudinaryCloudName: "unit-test", cloudinaryUploadPreset: "test-unsigned")
        }
        let client = CaptureUploadClient(configuration: configuration(), session: session)

        try require(configuration().isConfigured, "Publishable configuration rejected")
        try require(configuration(key(role: "anon")).isConfigured, "Anon JWT configuration rejected")
        try require(!configuration(key(role: "service_role")).isConfigured, "Service-role JWT accepted")
        try require(!configuration("sb_secret_DO_NOT_SEND").isConfigured, "Secret key accepted")
        print("PASS public keys accepted; privileged keys rejected")

        let expectedURL = URL(string: "https://res.cloudinary.com/unit-test/image/upload/v1/report.jpg")!
        let jpegBytes = Data([0xff, 0xd8, 0xff, 0xd9])
        CaptureMockProtocol.handler = { request in
            try require(request.httpMethod == "POST", "Upload must POST")
            try require(request.url?.path == "/v1_1/unit-test/image/upload", "Wrong cloud upload endpoint")
            try require(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data;") == true, "Missing multipart type")
            let body = requestBody(request)
            try require(body.range(of: Data("test-unsigned".utf8)) != nil, "Missing unsigned preset")
            try require(body.range(of: Data("filename=\"report.jpg\"".utf8)) != nil, "Missing JPEG filename")
            try require(body.range(of: jpegBytes) != nil, "Missing image bytes")
            return .init(json: "{\"secure_url\":\"\(expectedURL.absoluteString)\"}")
        }
        let uploadedURL = try await client.uploadImage(jpegBytes)
        try require(uploadedURL == expectedURL, "Cloudinary secure URL not preserved")
        print("PASS multipart upload and secure_url decoding")

        CaptureMockProtocol.handler = { request in
            try require(request.httpMethod == "GET", "Reconciliation must GET")
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            try require(items.contains(URLQueryItem(name: "image_url", value: "eq.\(expectedURL.absoluteString)")), "Missing exact image_url filter")
            try require(items.contains(URLQueryItem(name: "limit", value: "1")), "Unbounded reconciliation")
            try require(request.value(forHTTPHeaderField: "apikey") == publicKey, "Public apikey missing")
            try require(request.value(forHTTPHeaderField: "Authorization") == nil, "Publishable key incorrectly used as JWT")
            return .init(json: "[]")
        }
        let absent = try await client.reportExists(imageURL: uploadedURL)
        try require(!absent, "Empty lookup was treated as existing")
        print("PASS reconciliation absence and publishable-key auth")

        CaptureMockProtocol.handler = { request in
            try require(request.httpMethod == "POST", "Metadata must POST")
            try require(request.url?.path == "/rest/v1/photos", "Wrong photos endpoint")
            let object = try JSONSerialization.jsonObject(with: requestBody(request)) as! [String: Any]
            try require(Set(object.keys) == Set(["image_url", "latitude", "longitude", "address", "captured_at"]), "Unexpected photos payload fields")
            try require(object["captured_at"] is NSNull, "Unknown capture time must be explicit null")
            try require(object["created_at"] == nil, "Client must not override upload/FIFO time")
            try require(object["image_url"] as? String == uploadedURL.absoluteString, "Uploaded URL not reused")
            try require(object["latitude"] as? Double == 12.9716, "Latitude changed")
            try require(object["longitude"] as? Double == 77.5946, "Longitude changed")
            try require(object["address"] as? String == "Reviewed road", "Address changed")
            try require(request.value(forHTTPHeaderField: "apikey") == publicKey, "Insert apikey missing")
            try require(request.value(forHTTPHeaderField: "Authorization") == nil, "Invalid publishable bearer token")
            return .init(status: 201)
        }
        try await client.insertReport(imageURL: uploadedURL, latitude: 12.9716, longitude: 77.5946, address: "Reviewed road")
        print("PASS confirmed insert and exact metadata JSON fields")

        CaptureMockProtocol.handler = { _ in .init(json: "[{\"id\":\"existing-photo\"}]") }
        let exists = try await client.reportExists(imageURL: uploadedURL)
        try require(exists, "Existing receipt not recognized")
        print("PASS reconciliation of existing receipt")

        let anonKey = key(role: "anon")
        let anonClient = CaptureUploadClient(configuration: configuration(anonKey), session: session)
        CaptureMockProtocol.handler = { request in
            try require(request.value(forHTTPHeaderField: "apikey") == anonKey, "Anon apikey missing")
            try require(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(anonKey)", "Anon bearer missing")
            return .init(json: "[]")
        }
        _ = try await anonClient.reportExists(imageURL: uploadedURL)
        print("PASS anon JWT auth headers")

        CaptureMockProtocol.handler = { _ in .init(status: 400) }
        do {
            _ = try await client.uploadImage(jpegBytes)
            throw CheckFailure("Rejected cloud upload was accepted")
        } catch CaptureUploadError.cloudRejected(let code) { try require(code == 400, "Lost cloud status") }
        print("PASS Cloudinary rejection")

        CaptureMockProtocol.handler = { _ in .init(status: 401) }
        do {
            _ = try await client.reportExists(imageURL: uploadedURL)
            throw CheckFailure("Denied lookup treated as absence")
        } catch CaptureUploadError.lookupRejected(let code) { try require(code == 401, "Lost lookup status") }
        print("PASS lookup denial is not false absence")

        CaptureMockProtocol.handler = { _ in .init(status: 403) }
        do {
            try await client.insertReport(imageURL: uploadedURL, latitude: 1, longitude: 2, address: "x")
            throw CheckFailure("Rejected metadata accepted")
        } catch let error as CaptureUploadError {
            try require(error.isDefinitiveMetadataRejection, "Definitive rejection misclassified")
        }
        print("PASS definitive metadata rejection")

        CaptureMockProtocol.handler = { _ in .init(error: URLError(.timedOut)) }
        do {
            try await client.insertReport(imageURL: uploadedURL, latitude: 1, longitude: 2, address: "x")
            throw CheckFailure("Lost insert response accepted")
        } catch CaptureUploadError.uncertainMetadata {}
        print("PASS uncertain insert requires reconciliation")

        let invalidClient = CaptureUploadClient(configuration: configuration("sb_secret_DO_NOT_SEND"), session: session)
        CaptureMockProtocol.handler = { _ in throw CheckFailure("Privileged credential reached transport") }
        do {
            _ = try await invalidClient.uploadImage(jpegBytes)
            throw CheckFailure("Privileged configuration accepted by transport")
        } catch CaptureUploadError.configuration {}
        print("PASS privileged configuration blocked before networking")

        let shutterTime = Date(timeIntervalSince1970: 1_777_777_777.123)
        let fixTime = shutterTime.addingTimeInterval(-2)
        guard let tag = CaptureGeoTag.freshCameraFix(latitude: 12.9716123, longitude: 77.5946123,
                                                    accuracyMetres: 12, fixTimestamp: fixTime, shutterTimestamp: shutterTime) else {
            throw CheckFailure("Fresh camera fix was rejected")
        }
        try require(tag.fixTimestamp == fixTime && tag.accuracyMetres == 12, "GPS provenance lost")
        try require(CaptureGeoTag.freshCameraFix(latitude: 12, longitude: 77, accuracyMetres: 12,
                                                 fixTimestamp: shutterTime.addingTimeInterval(-16), shutterTimestamp: shutterTime) == nil,
                    "Stale camera coordinates accepted")
        try require(CaptureGeoTag.freshCameraFix(latitude: 12, longitude: 77, accuracyMetres: 151,
                                                 fixTimestamp: shutterTime, shutterTimestamp: shutterTime) == nil,
                    "Inaccurate coordinates accepted")
        try require(CaptureGeoTag.freshCameraFix(latitude: 91, longitude: 77, accuracyMetres: 12,
                                                 fixTimestamp: shutterTime, shutterTimestamp: shutterTime) == nil,
                    "Invalid coordinates accepted")
        print("PASS bounded shutter GPS freshness, accuracy and coordinate validation")

        let id = UUID()
        var draft = CaptureDraft(id: id, createdAt: shutterTime.addingTimeInterval(30), imageFilename: "\(id.uuidString).jpg",
                                  pixelWidth: 1_600, pixelHeight: 1_200)
        let oldJSON = try JSONEncoder().encode(draft)
        let restoredOld = try JSONDecoder().decode(CaptureDraft.self, from: oldJSON)
        try require(restoredOld.captureMetadata == nil && restoredOld.id == id, "Legacy draft compatibility broken")
        print("PASS old drafts without capture metadata remain readable")

        draft.captureMetadata = CapturePhotoMetadata(source: .camera, capturedAt: shutterTime,
                                                      importedAt: shutterTime.addingTimeInterval(1), timeSource: .shutter,
                                                      location: tag)
        draft.cloudImageURL = uploadedURL
        draft.metadataOutcomeUnknown = true
        let restored = try JSONDecoder().decode(CaptureDraft.self, from: JSONEncoder().encode(draft))
        try require(restored.captureMetadata == draft.captureMetadata, "Draft lost capture timestamp/GPS provenance")
        try require(restored.captureMetadata?.capturedAt != restored.createdAt, "Draft creation time replaced shutter time")
        try require(restored.metadataOutcomeUnknown && restored.cloudImageURL == uploadedURL, "Receipt recovery state lost")
        print("PASS capture time and GPS accuracy/fix time survive draft/retry serialization")

        let imported = CapturePhotoMetadata(source: .library, capturedAt: nil, importedAt: shutterTime,
                                            timeSource: .importOnly, originalLocalTimestamp: "2020:01:02 03:04:05")
        let restoredImport = try JSONDecoder().decode(CapturePhotoMetadata.self, from: JSONEncoder().encode(imported))
        try require(restoredImport.capturedAt == nil && restoredImport.importedAt == shutterTime,
                    "Import time incorrectly promoted to capture time")
        try require(restoredImport.originalLocalTimestamp == imported.originalLocalTimestamp && restoredImport.location == nil,
                    "Unknown timezone metadata or missing imported geotag incorrectly inferred")
        print("PASS unknown imported capture time stays unknown; import date remains separate")

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let expectedTime = formatter.string(from: shutterTime)
        CaptureMockProtocol.handler = { request in
            let body = try JSONSerialization.jsonObject(with: requestBody(request)) as! [String: Any]
            try require(body["captured_at"] as? String == expectedTime, "Original capture timestamp was changed on submission/retry")
            try require(body["created_at"] == nil, "FIFO upload timestamp must remain server-generated")
            return .init(status: 201)
        }
        try await client.insertReport(imageURL: uploadedURL, latitude: tag.latitude, longitude: tag.longitude,
                                      address: "Capture location", capturedAt: restored.captureMetadata?.capturedAt)
        try await client.insertReport(imageURL: uploadedURL, latitude: tag.latitude, longitude: tag.longitude,
                                      address: "Capture location", capturedAt: restored.captureMetadata?.capturedAt)
        print("PASS known captured_at serialized as unchanged UTC ISO 8601 across retries")

        CaptureMockProtocol.handler = { _ in .init(status: 400, json: "{\"code\":\"PGRST204\",\"message\":\"Could not find the captured_at column of photos in the schema cache\"}") }
        do {
            try await client.insertReport(imageURL: uploadedURL, latitude: 12, longitude: 77, address: "x", capturedAt: shutterTime)
            throw CheckFailure("Missing capture-time migration was silently ignored")
        } catch let error as CaptureUploadError {
            guard case .captureTimeMigrationRequired = error else { throw CheckFailure("Migration error not actionable") }
            try require(error.isDefinitiveMetadataRejection, "Missing-column response incorrectly treated as uncertain insert")
        }
        print("PASS missing captured_at migration is actionable and never drops capture metadata")
    }
}
