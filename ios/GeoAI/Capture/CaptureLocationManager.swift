import Foundation
import CoreLocation
import Combine

@MainActor
final class CaptureLocationManager: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate {
    @Published private(set) var isLocating = false
    @Published private(set) var cameraLocationStatus = "No fresh GPS fix was available at capture. Enter the photo's coordinates."
    private let manager = CLLocationManager()
    private var completion: ((Result<CLLocation, Error>) -> Void)?
    private var timeout: Task<Void, Never>?
    private var collectingCamera = false
    private var cameraFixes: [CLLocation] = []

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    /// Called only by the user's Use current location button.
    func requestLocation(completion: @escaping (Result<CLLocation, Error>) -> Void) {
        guard !isLocating else { return }
        self.completion = completion
        isLocating = true
        guard CLLocationManager.locationServicesEnabled() else {
            finish(.failure(LocationIssue.disabled))
            return
        }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse: startFix()
        case .denied, .restricted: finish(.failure(LocationIssue.denied))
        @unknown default: finish(.failure(LocationIssue.unavailable))
        }
    }

    func cancel() {
        timeout?.cancel()
        manager.stopUpdatingLocation()
        completion = nil
        isLocating = false
        collectingCamera = false
        cameraFixes = []
    }

    /// Only called after the user taps Take photo and grants camera access.
    func beginCameraUpdates() {
        cancel()
        collectingCamera = true
        isLocating = true
        cameraLocationStatus = "No fresh GPS fix was available at capture. Enter the photo's coordinates."
        guard CLLocationManager.locationServicesEnabled() else {
            cameraLocationStatus = "Location Services are off. Enter the photo's coordinates manually."
            cancel(); return
        }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse: startCameraFixes()
        case .denied, .restricted:
            cameraLocationStatus = "Location permission was not granted. No coordinates were guessed. Enter them manually."
            cancel()
        @unknown default: cancel()
        }
    }

    func cameraGeotag(at shutterTime: Date?) -> CaptureGeoTag? {
        guard let shutterTime else { return nil }
        return cameraFixes.compactMap { fix in
            CaptureGeoTag.freshCameraFix(latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude,
                                        accuracyMetres: fix.horizontalAccuracy, fixTimestamp: fix.timestamp,
                                        shutterTimestamp: shutterTime)
        }.min { abs(($0.fixTimestamp ?? .distantPast).timeIntervalSince(shutterTime))
            < abs(($1.fixTimestamp ?? .distantPast).timeIntervalSince(shutterTime)) }
    }

    private func startCameraFixes() {
        timeout?.cancel()
        manager.startUpdatingLocation()
        timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 120_000_000_000) } catch { return }
            self?.manager.stopUpdatingLocation()
            self?.isLocating = false
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard isLocating else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            if collectingCamera { startCameraFixes() } else { startFix() }
        case .denied, .restricted:
            if collectingCamera {
                cameraLocationStatus = "Location permission was not granted. Enter coordinates manually."
                cancel()
            } else { finish(.failure(LocationIssue.denied)) }
        default: break
        }
    }

    private func startFix() {
        timeout?.cancel()
        manager.requestLocation()
        timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            self?.finish(.failure(LocationIssue.timeout))
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard isLocating else { return }
        if collectingCamera {
            cameraFixes.append(contentsOf: locations.filter { abs($0.timestamp.timeIntervalSinceNow) <= 20 && (0...150).contains($0.horizontalAccuracy) })
            cameraFixes = Array(cameraFixes.filter { abs($0.timestamp.timeIntervalSinceNow) <= 30 }.suffix(40))
            return
        }
        guard let fix = locations.filter({
            abs($0.timestamp.timeIntervalSinceNow) <= 60 && $0.horizontalAccuracy >= 0
        }).min(by: { $0.horizontalAccuracy < $1.horizontalAccuracy }) else {
            finish(.failure(LocationIssue.stale))
            return
        }
        guard fix.horizontalAccuracy <= 150 else {
            finish(.failure(LocationIssue.inaccurate(Int(fix.horizontalAccuracy.rounded()))))
            return
        }
        finish(.success(fix))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard isLocating else { return }
        if collectingCamera {
            if let error = error as? CLError, error.code == .denied {
                cameraLocationStatus = "Location permission was not granted. Enter coordinates manually."
                cancel()
            }
            return // A temporary GPS failure can recover while the camera stays open.
        }
        if let error = error as? CLError, error.code == .denied {
            finish(.failure(LocationIssue.denied))
        } else {
            finish(.failure(LocationIssue.unavailable))
        }
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        timeout?.cancel()
        timeout = nil
        manager.stopUpdatingLocation()
        let callback = completion
        completion = nil
        isLocating = false
        callback?(result)
    }

    private enum LocationIssue: LocalizedError {
        case disabled, denied, unavailable, timeout, stale, inaccurate(Int)
        var errorDescription: String? {
            switch self {
            case .disabled: return "Location Services are turned off. Enable them in Settings, or enter the photo's coordinates below."
            case .denied: return "Location access is unavailable. You can allow access in Settings or enter coordinates manually."
            case .unavailable: return "A location fix isn't available. Try outside or enter the photo's coordinates manually."
            case .timeout: return "Finding your location took too long. Try again or enter coordinates manually."
            case .stale: return "The device returned an old location. Try again or enter the correct coordinates."
            case .inaccurate(let metres): return "This location is only accurate to about \(metres) m. Try outside or enter more accurate coordinates."
            }
        }
    }
}
