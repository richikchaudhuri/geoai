import Foundation
import Combine
import GeoAICore

@MainActor
final class AppStore: ObservableObject {
    enum Source {
        case snapshot(Date?), cached(Date), live(Date)
        var label: String {
            switch self {
            case .snapshot: return "DEMO SNAPSHOT"
            case .cached: return "SAVED DATA"
            case .live: return "LIVE DATA"
            }
        }
        var date: Date? {
            switch self {
            case .snapshot(let date): return date
            case .cached(let date), .live(let date): return date
            }
        }
        var isLive: Bool { if case .live = self { return true }; return false }
    }

    @Published private(set) var rows: [RoadAssessment] = []
    @Published private(set) var source: Source = .snapshot(nil)
    @Published private(set) var isLoading = false
    @Published var message: String?
    @Published var filter = AssessmentFilter()
    let configuration = AppConfiguration()
    private var didRefresh = false

    private struct CacheEntry: Codable {
        let savedAt: Date
        let rows: [RoadAssessment]
        let projectURL: String
    }

    init() {
        do {
            guard let url = Bundle.main.url(forResource: "snapshot", withExtension: "json") else {
                throw CocoaError(.fileNoSuchFile)
            }
            let snapshot = try SnapshotDecoder.decode(Data(contentsOf: url))
            rows = snapshot.assessments
            source = .snapshot(snapshot.generatedAt)
        } catch {
            message = "The sample observations could not be loaded. Try refreshing after configuring live data."
        }
        if configuration.hasDatabase, let url = cacheURL,
           let data = try? Data(contentsOf: url),
           let entry = try? JSONDecoder().decode(CacheEntry.self, from: data),
           entry.projectURL == configuration.supabaseURL?.absoluteString {
            rows = entry.rows
            source = .cached(entry.savedAt)
        }
    }

    var visibleRows: [RoadAssessment] { filter.apply(to: rows) }
    var assessedCount: Int { visibleRows.filter(\.isAssessed).count }
    var highCount: Int { visibleRows.filter { $0.severity == .high && $0.isAssessed }.count }
    var hasFilters: Bool { filter.severity != nil || filter.dayPeriod != nil }

    func initialRefresh() async {
        guard !didRefresh else { return }
        didRefresh = true
        if configuration.hasDatabase { await refresh() }
    }

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let config = try configuration.database() else {
                message = "You’re exploring the bundled demo. Add your public Supabase configuration to load live observations."
                return
            }
            let result = try await AssessmentRepository(configuration: config).loadLive()
            // Always replace data: equal counts do not mean unchanged assessments.
            rows = result.assessments
            let now = Date()
            source = .live(now)
            message = nil
            if let url = cacheURL {
                let entry = CacheEntry(savedAt: now, rows: rows, projectURL: config.url.absoluteString)
                do {
                    let data = try JSONEncoder().encode(entry)
                    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                } catch {
                    message = "Observations are up to date, but this device couldn’t save an offline copy."
                }
            }
        } catch is CancellationError {
            // Keep the last visible dataset when the view's task is cancelled.
        } catch {
            if case .live(let date) = source { source = .cached(date) }
            message = "Live data is unavailable. The last loaded observations are still available. Check your connection and configuration."
        }
    }

    func clearFilters() { filter = AssessmentFilter() }

    private var cacheURL: URL? {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let folder = base.appendingPathComponent("GeoAI", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("assessments.json")
    }
}
