import Foundation
import Combine
import MapKit

struct PlaceResult: Identifiable, Equatable {
    let id: String
    let title: String
    let subtitle: String
    let latitude: Double
    let longitude: Double

    var lat: Double { latitude }
    var lon: Double { longitude }
}

/// Native Apple place search. Every query cancels both debounce and network work,
/// and a generation token prevents late responses from reviving cleared results.
@MainActor
final class PlaceSearchModel: ObservableObject {
    @Published private(set) var results: [PlaceResult] = []
    @Published private(set) var isSearching = false
    @Published private(set) var errorMessage: String?

    private var debounceTask: Task<Void, Never>?
    private var activeSearch: MKLocalSearch?
    private var generation = UUID()

    func search(_ query: String) {
        cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { return }

        isSearching = true
        let requestGeneration = generation
        debounceTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 400_000_000)
            } catch {
                return
            }
            guard let self, !Task.isCancelled, self.generation == requestGeneration else { return }

            let request = MKLocalSearch.Request()
            request.naturalLanguageQuery = trimmed
            request.resultTypes = [.address, .pointOfInterest]
            // A relevance hint, not a boundary: explicit places elsewhere remain searchable.
            request.region = MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: 12.9716, longitude: 77.5946),
                span: MKCoordinateSpan(latitudeDelta: 0.8, longitudeDelta: 0.8)
            )
            let search = MKLocalSearch(request: request)
            self.activeSearch = search

            do {
                let response = try await search.start()
                guard !Task.isCancelled, self.generation == requestGeneration else { return }
                var seen = Set<String>()
                self.results = response.mapItems.compactMap { item in
                    let coordinate = item.placemark.coordinate
                    guard CLLocationCoordinate2DIsValid(coordinate) else { return nil }
                    let title = item.name ?? item.placemark.name ?? trimmed
                    let id = "\(coordinate.latitude)|\(coordinate.longitude)|\(title)"
                    guard seen.insert(id).inserted else { return nil }
                    let placemark = item.placemark
                    let street = [placemark.subThoroughfare, placemark.thoroughfare]
                        .compactMap { $0 }.joined(separator: " ")
                    let pieces = [street.isEmpty ? nil : street, placemark.locality,
                                  placemark.administrativeArea, placemark.country]
                        .compactMap { $0 }
                    var seenParts = Set<String>()
                    let subtitle = pieces.filter { $0 != title && seenParts.insert($0).inserted }
                        .joined(separator: ", ")
                    return PlaceResult(id: id, title: title, subtitle: subtitle,
                                       latitude: coordinate.latitude, longitude: coordinate.longitude)
                }
                self.isSearching = false
                self.activeSearch = nil
            } catch {
                guard !Task.isCancelled, self.generation == requestGeneration else { return }
                self.results = []
                self.isSearching = false
                self.activeSearch = nil
                self.errorMessage = "Places could not be loaded. Check your connection and try again."
            }
        }
    }

    func cancel() {
        generation = UUID()
        debounceTask?.cancel()
        debounceTask = nil
        activeSearch?.cancel()
        activeSearch = nil
        results = []
        errorMessage = nil
        isSearching = false
    }
}
