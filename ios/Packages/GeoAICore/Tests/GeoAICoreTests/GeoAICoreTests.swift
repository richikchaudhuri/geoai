import XCTest
@testable import GeoAICore
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class GeoAICoreTests: XCTestCase {
    private func decode(_ json: String) throws -> AssessmentDataset {
        try SnapshotDecoder.decode(Data(json.utf8))
    }

    func testActualSnapshotIsReadableAndPreservesPendingPhotos() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "snapshot", withExtension: "json", subdirectory: "Fixtures"))
        let dataset = try SnapshotDecoder.decode(Data(contentsOf: url))
        XCTAssertEqual(dataset.assessments.count, 79)
        XCTAssertEqual(Set(dataset.assessments.map(\.id)).count, 79)
        XCTAssertEqual(dataset.assessments.filter { $0.state == .pending }.count, 25)
        XCTAssertEqual(dataset.assessments.filter { $0.state == .expertReview }.count, 47)
        XCTAssertEqual(dataset.assessments.filter { $0.state == .classified }.count, 7)
        XCTAssertEqual(dataset.generatedAt, parseDate("2026-05-25T08:40:01Z"))
        let newest = try XCTUnwrap(dataset.assessments.first { $0.photoID == 135 })
        XCTAssertEqual(newest.capturedAt, parseDate("2026-05-25T03:48:01.400463+00:00"))
        XCTAssertEqual(newest.severity, .low)
        XCTAssertEqual(newest.dayPeriod, .day)
    }

    func testNewestAssessmentWinsAndPhotoCaptureTimeSurvives() throws {
        let data = try decode("""
        {"photos":[{"id":1,"latitude":12,"longitude":77,"created_at":"2026-01-01T05:00:00Z"}],
        "assessments":[
          {"id":"old","photo_id":1,"latitude":12,"longitude":77,"created_at":"2026-01-02T00:00:00Z","status":"classified","severity":"Low"},
          {"id":"new","photo_id":1,"latitude":12,"longitude":77,"created_at":"2026-01-03T00:00:00Z","status":"classified","severity":"High"}]}
        """)
        XCTAssertEqual(data.assessments.count, 1)
        XCTAssertEqual(data.assessments[0].id, "new")
        XCTAssertEqual(data.assessments[0].severity, .high)
        XCTAssertEqual(data.assessments[0].capturedAt, parseDate("2026-01-01T05:00:00Z"))
    }

    func testExplicitCaptureTimeOverridesUploadTimeWithoutInventingLegacyTimes() throws {
        let data = try decode("""
        {"photos":[
          {"id":1,"latitude":0,"longitude":0,"captured_at":"2026-03-20T00:00:00Z","created_at":"2026-03-20T12:00:00Z"},
          {"id":2,"latitude":0,"longitude":0,"created_at":"2026-03-20T12:00:00Z"},
          {"id":3,"latitude":0,"longitude":0,"captured_at":null,"created_at":"2026-03-20T12:00:00Z"},
          {"id":4,"latitude":0,"longitude":0,"captured_at":"invalid","created_at":"2026-03-20T12:00:00Z"}],
        "assessments":[{"id":"a","photo_id":1,"latitude":0,"longitude":0,
          "created_at":"2026-03-21T12:00:00Z","status":"classified"}]}
        """)
        let captured = try XCTUnwrap(data.assessments.first { $0.photoID == 1 })
        XCTAssertEqual(captured.capturedAt, parseDate("2026-03-20T00:00:00Z"))
        XCTAssertEqual(captured.dayPeriod, .night)
        let legacy = try XCTUnwrap(data.assessments.first { $0.photoID == 2 })
        XCTAssertEqual(legacy.capturedAt, parseDate("2026-03-20T12:00:00Z"))
        XCTAssertEqual(legacy.dayPeriod, .day)
        for id in [3, 4] {
            let unknown = try XCTUnwrap(data.assessments.first { $0.photoID == id })
            XCTAssertNil(unknown.capturedAt)
            XCTAssertEqual(unknown.dayPeriod, .unknown)
        }
    }

    func testExplicitNullCaptureTimeNeverUsesPhotoOrAssessmentUploadTime() throws {
        let data = try decode("""
        {"photos":[{"id":1,"latitude":0,"longitude":0,
          "captured_at":null,"created_at":"2026-03-20T12:00:00Z"}],
        "assessments":[{"id":"a","photo_id":1,"latitude":0,"longitude":0,
          "created_at":"2026-03-21T12:00:00Z","status":"classified"}]}
        """)
        let row = try XCTUnwrap(data.assessments.first)
        XCTAssertNil(row.capturedAt)
        XCTAssertEqual(row.dayPeriod, .unknown)
    }

    func testExpertCanCorrectDistressToAnEmptyTypeList() throws {
        let data = try decode("""
        {"assessments":[{"id":"reviewed","latitude":0,"longitude":0,"status":"done",
          "expert_reviewed":true,"distress_types":["Potholes"],"severity":"High",
          "expert_corrected_types":[],"expert_corrected_severity":"None"}]}
        """)
        XCTAssertEqual(data.assessments[0].types, [])
        XCTAssertEqual(data.assessments[0].severity, .none)
        XCTAssertEqual(data.assessments[0].primaryType, "Normal pavement")
        XCTAssertTrue(data.assessments[0].isAssessed)
    }

    func testUnreviewedCorrectionsDoNotOverrideModelResults() throws {
        let data = try decode("""
        {"assessments":[{"id":"a","latitude":12,"longitude":77,"status":"expert_review",
        "expert_reviewed":false,"distress_types":["Potholes"],"severity":"High",
        "expert_corrected_types":[],"expert_corrected_severity":"None"}]}
        """)
        XCTAssertEqual(data.assessments[0].types, ["Potholes"])
        XCTAssertEqual(data.assessments[0].severity, .high)
    }

    func testInvalidCoordinatesAreExcludedAndValidPhotoCoordinatesAreFallback() throws {
        let data = try decode("""
        {"photos":[{"id":"1","latitude":"12.9","longitude":"77.5"},
          {"id":2,"latitude":91,"longitude":2},{"id":3,"latitude":null,"longitude":3}],
        "assessments":[{"id":"a","photo_id":"1","latitude":null,"longitude":null,"status":"processing"}]}
        """)
        XCTAssertEqual(data.assessments.count, 1)
        XCTAssertEqual(data.assessments[0].latitude, 12.9)
        XCTAssertEqual(data.assessments[0].longitude, 77.5)
        XCTAssertEqual(data.assessments[0].state, .processing)
    }

    func testPendingUnknownAndRejectedDoNotAppearAsNormal() {
        for state: AssessmentState in [.pending, .processing, .failed, .unknown, .rejected] {
            let row = RoadAssessment(id: "a", latitude: 0, longitude: 0, state: state)
            XCTAssertFalse(row.isAssessed)
            XCTAssertNotEqual(row.primaryType, "Normal pavement")
        }
    }

    func testUnknownStateAndInvalidConfidenceRemainHonest() throws {
        let data = try decode("""
        {"assessments":[{"id":"a","latitude":0,"longitude":0,"status":"future_state",
        "severity":"unrecognized","stage1_confidence":1.5,"created_at":"bad-date"}]}
        """)
        XCTAssertEqual(data.assessments[0].state, .unknown)
        XCTAssertEqual(data.assessments[0].severity, .unknown)
        XCTAssertNil(data.assessments[0].confidence)
        XCTAssertNil(data.assessments[0].capturedAt)
        XCTAssertEqual(data.assessments[0].dayPeriod, .unknown)
    }

    func testLegacyImageMatchAndStandaloneAssessmentAreRetained() throws {
        let data = try decode("""
        {"photos":[{"id":1,"latitude":1,"longitude":2,"image_url":"https://example.com/a.jpg"}],
        "assessments":[{"id":"legacy","latitude":1,"longitude":2,"image_url":"https://example.com/a.jpg","status":"classified"},
        {"id":"standalone","latitude":3,"longitude":4,"status":"classified"}]}
        """)
        XCTAssertEqual(Set(data.assessments.map(\.id)), ["legacy", "standalone"])
    }

    func testDayNightUsesCaptureLongitudeNotDeviceTimezone() {
        let noonUTC = parseDate("2026-03-20T12:00:00Z")
        let greenwich = RoadAssessment(id: "g", latitude: 0, longitude: 0, capturedAt: noonUTC)
        let dateLine = RoadAssessment(id: "d", latitude: 0, longitude: 180, capturedAt: noonUTC)
        XCTAssertEqual(greenwich.dayPeriod, .day)
        XCTAssertEqual(dateLine.dayPeriod, .night)
        XCTAssertEqual(RoadAssessment(id: "n", latitude: 0, longitude: 0, capturedAt: parseDate("2026-03-20T00:00:00Z")).dayPeriod, .night)
    }

    func testRepeatedLegacyPhotoURLCannotProduceDuplicateIdentifiableIDs() throws {
        let data = try decode("""
        {"photos":[{"id":1,"latitude":1,"longitude":2,"image_url":"https://example.com/a.jpg"},
          {"id":2,"latitude":1,"longitude":2,"image_url":"https://example.com/a.jpg"}],
        "assessments":[{"id":"legacy","latitude":1,"longitude":2,"image_url":"https://example.com/a.jpg","status":"classified"}]}
        """)
        XCTAssertEqual(data.assessments.count, 2)
        XCTAssertEqual(Set(data.assessments.map(\.id)).count, 2)
        XCTAssertEqual(data.assessments.filter { $0.state == .pending }.count, 1)
    }

    func testCivilTwilightAndPolarDayNight() {
        XCTAssertEqual(RoadAssessment(id: "t", latitude: 0, longitude: 0, capturedAt: parseDate("2026-03-20T05:50:00Z")).dayPeriod, .day)
        XCTAssertEqual(RoadAssessment(id: "p", latitude: 89, longitude: 0, capturedAt: parseDate("2026-06-21T00:00:00Z")).dayPeriod, .day)
        XCTAssertEqual(RoadAssessment(id: "p", latitude: 89, longitude: 0, capturedAt: parseDate("2026-12-21T12:00:00Z")).dayPeriod, .night)
    }

    func testFiltersCombineSeverityDayPeriodAndNormalizedSearch() {
        let rows = [RoadAssessment(id: "a", latitude: 0, longitude: 0, address: "Café Road", capturedAt: parseDate("2026-03-20T12:00:00Z"), state: .classified, types: ["Pothole"], severity: .high),
                    RoadAssessment(id: "b", latitude: 0, longitude: 0, address: "Cafe Lane", severity: .low)]
        XCTAssertEqual(AssessmentFilter(severity: .high, dayPeriod: .day, query: "  cafe ").apply(to: rows).map(\.id), ["a"])
        XCTAssertEqual(AssessmentFilter(query: "pothole").apply(to: rows).map(\.id), ["a"])
        XCTAssertEqual(AssessmentFilter(dayPeriod: .night).apply(to: rows), [])
        XCTAssertEqual(AssessmentFilter().apply(to: rows), rows)
    }

    func testMissingTablesIsAnErrorRatherThanFalseEmptyDataset() {
        XCTAssertThrowsError(try decode("{}"))
    }

    func testSearchMatchesStatusEvenWhenPrimaryTypeShowsDamage() {
        let rows = [
            RoadAssessment(id: "review", latitude: 0, longitude: 0, state: .expertReview, types: ["Pothole"]),
            RoadAssessment(id: "pending", latitude: 0, longitude: 0, state: .pending),
            RoadAssessment(id: "classified", latitude: 0, longitude: 0, state: .classified, types: ["Crack"])
        ]
        XCTAssertEqual(AssessmentFilter(query: "review").apply(to: rows).map(\.id), ["review"])
        XCTAssertEqual(AssessmentFilter(query: "expert_review").apply(to: rows).map(\.id), ["review"])
        XCTAssertEqual(AssessmentFilter(query: "pending").apply(to: rows).map(\.id), ["pending"])
        XCTAssertEqual(AssessmentFilter(query: "classified").apply(to: rows).map(\.id), ["classified"])
    }

    func testPublicKeysAcceptedAndPrivilegedKeysRejected() throws {
        let url = URL(string: "https://example.supabase.co")!
        XCTAssertNoThrow(try SupabaseConfiguration(url: url, publicKey: "sb_publishable_test"))
        func jwt(_ role: String) -> String {
            let data = Data("{\"role\":\"\(role)\"}".utf8)
            return "header." + data.base64EncodedString().replacingOccurrences(of: "=", with: "") + ".signature"
        }
        XCTAssertNoThrow(try SupabaseConfiguration(url: url, publicKey: jwt("anon")))
        XCTAssertThrowsError(try SupabaseConfiguration(url: url, publicKey: "sb_secret_test"))
        XCTAssertThrowsError(try SupabaseConfiguration(url: url, publicKey: jwt("service_role")))
        XCTAssertThrowsError(try SupabaseConfiguration(url: url, publicKey: jwt("authenticated")))
        XCTAssertThrowsError(try SupabaseConfiguration(url: url, publicKey: "unrecognized"))
        XCTAssertThrowsError(try SupabaseConfiguration(url: URL(string: "http://example.com")!, publicKey: "sb_publishable_test"))
        XCTAssertNoThrow(try SupabaseConfiguration(url: URL(string: "http://127.0.0.1:54321")!, publicKey: "sb_publishable_test"))
    }
}

private final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, [String: String], Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (code, headers, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class AssessmentRepositoryTests: XCTestCase {
    private var session: URLSession!
    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        session = URLSession(configuration: config)
    }
    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        StubURLProtocol.handler = nil
        super.tearDown()
    }
    private func repository() throws -> AssessmentRepository {
        AssessmentRepository(configuration: try SupabaseConfiguration(url: URL(string: "https://test.supabase.co")!, publicKey: "sb_publishable_test"), session: session)
    }

    func testPaginationContinuesWhenServerCapIsBelowRequestedPageSize() async throws {
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "apikey"), "sb_publishable_test")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            let query = Dictionary(uniqueKeysWithValues: parts.queryItems!.map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(query["order"], "created_at.desc,id.desc")
            XCTAssertEqual(query["limit"], "500")
            if parts.path.hasSuffix("assessments") { return (200, ["Content-Range": "*/0"], Data("[]".utf8)) }
            if query["offset"] == "0" {
                return (200, ["Content-Range": "0-1/3"], Data("[{\"id\":3,\"latitude\":1,\"longitude\":1},{\"id\":2,\"latitude\":2,\"longitude\":2}]".utf8))
            }
            XCTAssertEqual(query["offset"], "2")
            return (200, ["Content-Range": "2-2/3"], Data("[{\"id\":1,\"latitude\":3,\"longitude\":3}]".utf8))
        }
        let dataset = try await repository().loadLive()
        XCTAssertEqual(dataset.assessments.count, 3)
        XCTAssertNotNil(dataset.generatedAt)
    }

    func testMissingCountFailsRatherThanSilentlyReturningTruncatedRows() async throws {
        StubURLProtocol.handler = { _ in (200, [:], Data("[]".utf8)) }
        do { _ = try await repository().loadLive(); XCTFail("Should reject unverified completeness") }
        catch { XCTAssertEqual(error as? RepositoryError, .incompleteResult) }
    }

    func testOlderPhotoSchemaRetriesOnceWithoutCaptureColumn() async throws {
        for code in ["42703", "PGRST204"] {
            var photoRequests = 0
            StubURLProtocol.handler = { request in
                if request.url!.path.hasSuffix("assessments") { return (200, ["Content-Range": "*/0"], Data("[]".utf8)) }
                photoRequests += 1
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
                let select = query.first { $0.name == "select" }!.value!
                if photoRequests == 1 {
                    XCTAssertTrue(select.split(separator: ",").contains("captured_at"))
                    return (400, [:], Data("{\"code\":\"\(code)\",\"message\":\"column photos.captured_at does not exist\"}".utf8))
                }
                XCTAssertEqual(photoRequests, 2)
                XCTAssertFalse(select.split(separator: ",").contains("captured_at"))
                XCTAssertEqual(query.first { $0.name == "order" }!.value, "created_at.desc,id.desc")
                return (200, ["Content-Range": "0-0/1"], Data("[{\"id\":1,\"latitude\":0,\"longitude\":0,\"created_at\":\"2026-03-20T12:00:00Z\"}]".utf8))
            }
            let dataset = try await repository().loadLive()
            XCTAssertEqual(photoRequests, 2)
            XCTAssertEqual(dataset.assessments.first?.capturedAt, parseDate("2026-03-20T12:00:00Z"))
        }
    }

    func testUnrelatedMissingColumnDoesNotTriggerCompatibilityRetry() async throws {
        var photoRequests = 0
        StubURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("assessments") { return (200, ["Content-Range": "*/0"], Data("[]".utf8)) }
            photoRequests += 1
            return (400, [:], Data("{\"code\":\"42703\",\"message\":\"column photos.address does not exist\"}".utf8))
        }
        do { _ = try await repository().loadLive(); XCTFail("Should report unrelated schema errors") }
        catch { XCTAssertEqual(error as? RepositoryError, .httpStatus(400)) }
        XCTAssertEqual(photoRequests, 1)
    }

    func testPermissionFailureIsReportedWithoutEmptySuccess() async throws {
        StubURLProtocol.handler = { _ in (403, [:], Data("{}".utf8)) }
        do { _ = try await repository().loadLive(); XCTFail("Should fail") }
        catch { XCTAssertEqual(error as? RepositoryError, .httpStatus(403)) }
    }

    func testDuplicatePageIDsDetectDatasetShift() async throws {
        StubURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("assessments") { return (200, ["Content-Range": "*/0"], Data("[]".utf8)) }
            return (200, ["Content-Range": "0-0/2"], Data("[{\"id\":1,\"latitude\":1,\"longitude\":1}]".utf8))
        }
        do { _ = try await repository().loadLive(); XCTFail("Should detect repeated ID") }
        catch { XCTAssertEqual(error as? RepositoryError, .incompleteResult) }
    }

    func testDatasetBoundRejectsOversizedDownload() async throws {
        StubURLProtocol.handler = { _ in (200, ["Content-Range": "*/100001"], Data("[]".utf8)) }
        do { _ = try await repository().loadLive(); XCTFail("Should enforce dataset cap") }
        catch { XCTAssertEqual(error as? RepositoryError, .tooManyRows) }
    }
}
