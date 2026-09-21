import Foundation
import UIKit
import SwiftUI
import Combine
import CoreLocation

@MainActor
final class CaptureViewModel: ObservableObject {
    enum SubmissionStage {
        case savingDraft
        case uploadingPhoto
        case checkingReceipt
        case sendingDetails

        var label: String {
            switch self {
            case .savingDraft: return "Saving your reviewed report…"
            case .uploadingPhoto: return "Uploading your photo…"
            case .checkingReceipt: return "Checking report status…"
            case .sendingDetails: return "Sending report details…"
            }
        }
    }

    @Published private(set) var draft: CaptureDraft?
    @Published private(set) var preview: UIImage?
    @Published private(set) var isLoading = true
    @Published private(set) var isPreparing = false
    @Published private(set) var isSubmitting = false
    @Published private(set) var isSubmitted = false
    @Published private(set) var hasUnreadableDraft = false
    @Published var latitudeText = ""
    @Published var longitudeText = ""
    @Published var address = ""
    @Published var locationReviewed = false
    @Published var locationDescription = "Enter coordinates or use your current location."
    @Published var errorMessage: String?
    @Published var statusMessage = "A photo and reviewed location make a useful report."
    @Published private(set) var submissionStage: SubmissionStage = .savingDraft

    let configuration: CaptureConfiguration
    private let store = CaptureDraftStore()
    private let client: CaptureUploadClient
    private var imageData: Data?
    private var saveTask: Task<Void, Never>?

    init(configuration: CaptureConfiguration) {
        self.configuration = configuration
        self.client = CaptureUploadClient(configuration: configuration)
    }

    var isBusy: Bool { isLoading || isPreparing || isSubmitting }
    var imageSelectionLocked: Bool { isBusy || draft?.cloudImageURL != nil || hasUnreadableDraft }
    var metadataLocked: Bool { isSubmitting || draft?.metadataOutcomeUnknown == true }
    var hasDraft: Bool { draft != nil || hasUnreadableDraft }
    var needsReconciliation: Bool { draft?.metadataOutcomeUnknown == true }
    var photoTimestampText: String {
        guard let metadata = draft?.captureMetadata else { return "Capture time unavailable for this older draft." }
        if let date = metadata.capturedAt {
            let label = metadata.timeSource == .shutter ? "Captured" : "Original photo time"
            return "\(label): \(Self.display(date))"
        }
        if let local = metadata.originalLocalTimestamp {
            return "Original photo time: \(local) · timezone not recorded. Absolute capture time is unknown."
        }
        if let date = metadata.importedAt {
            let label = metadata.source == .camera ? "Photo received" : "Imported"
            return "\(label): \(Self.display(date)) · original capture time unavailable."
        }
        return "Original capture time unavailable."
    }

    private static func display(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .standard) + " " + (TimeZone.current.abbreviation() ?? "")
    }

    private func describe(_ tag: CaptureGeoTag?) -> String {
        guard let tag else { return "No geotag available. Enter and review the photo's coordinates." }
        switch tag.source {
        case .cameraGPS, .currentLocation:
            let prefix = tag.source == .cameraGPS ? "GPS at capture" : "Current location requested by you"
            let accuracy = tag.accuracyMetres.map { " · ±\(Int($0.rounded())) m" } ?? ""
            let time = tag.fixTimestamp.map { " · fix \(Self.display($0))" } ?? ""
            return prefix + accuracy + time
        case .photoMetadata: return "Original photo GPS · accuracy and fix time not recorded. Review before submitting."
        case .manual: return "Coordinates entered manually · GPS accuracy and fix time do not apply."
        }
    }
    var coordinate: CLLocationCoordinate2D? {
        let latString = latitudeText.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        let lonString = longitudeText.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        guard let latitude = Double(latString), let longitude = Double(lonString),
              latitude.isFinite, longitude.isFinite,
              (-90...90).contains(latitude), (-180...180).contains(longitude) else { return nil }
        return CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    func load() async {
        guard isLoading else { return }
        defer { isLoading = false }
        do {
            if let (saved, data) = try await store.load() {
                guard let image = UIImage(data: data) else { throw CaptureDraftError.unreadable }
                draft = saved
                imageData = data
                preview = image
                latitudeText = saved.latitudeText
                longitudeText = saved.longitudeText
                address = saved.address
                locationDescription = saved.locationDescription
                errorMessage = saved.lastSubmissionError
                statusMessage = saved.metadataOutcomeUnknown
                    ? "Saved submission restored. Check its status before sending again."
                    : "Saved draft restored. Review its location before submitting."
            }
        } catch {
            hasUnreadableDraft = true
            errorMessage = "Your saved draft could not be opened. Unlock the device and try again. Discard it only if you no longer need it."
        }
    }

    func acceptCameraPhoto(_ photo: CaptureCameraPhoto, geotag: CaptureGeoTag?, locationNote: String) async {
        guard !imageSelectionLocked else { return }
        isPreparing = true
        errorMessage = nil
        defer { isPreparing = false }
        do {
            let (prepared, extracted) = try await Task.detached(priority: .userInitiated) {
                (try CapturePhotoProcessor.prepare(data: photo.data),
                 CapturePhotoProcessor.metadata(in: photo.data, source: .camera, importedAt: photo.receivedAt,
                                                shutterAt: photo.shutterTimestamp))
            }.value
            var metadata = extracted
            metadata.location = geotag
            try await acceptPrepared(prepared, metadata: metadata)
            if geotag == nil { locationDescription = locationNote; await saveDraft(showFeedback: false) }
        } catch { errorMessage = error.localizedDescription }
    }

    private func acceptPrepared(_ prepared: CapturePreparedPhoto, metadata: CapturePhotoMetadata) async throws {
        saveTask?.cancel()
        let saved = try await store.create(photo: prepared, metadata: metadata)
        draft = saved
        imageData = prepared.data
        preview = UIImage(data: prepared.data)
        latitudeText = saved.latitudeText
        longitudeText = saved.longitudeText
        address = ""
        locationDescription = describe(metadata.location)
        locationReviewed = false
        isSubmitted = false
        statusMessage = "Photo saved on this device. Nothing has been uploaded."
        await saveDraft(showFeedback: false)
    }

    func useLocation(_ location: CLLocation) {
        let tag = CaptureGeoTag(latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
                                accuracyMetres: location.horizontalAccuracy, fixTimestamp: location.timestamp, source: .currentLocation)
        updateGeotag(tag)
        latitudeText = String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), location.coordinate.latitude)
        longitudeText = String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), location.coordinate.longitude)
        locationDescription = describe(tag)
        locationReviewed = false
        errorMessage = nil
        scheduleSave()
    }

    func coordinatesChanged() {
        guard !isLoading else { return }
        locationReviewed = false
        if !metadataLocked {
            if let coordinate {
                if draft?.captureMetadata?.location?.matches(latitude: coordinate.latitude, longitude: coordinate.longitude) != true {
                    let manual = CaptureGeoTag(latitude: coordinate.latitude, longitude: coordinate.longitude,
                                               accuracyMetres: nil, fixTimestamp: nil, source: .manual)
                    updateGeotag(manual)
                    locationDescription = describe(manual)
                }
            } else {
                updateGeotag(nil)
                locationDescription = "Coordinates are incomplete or invalid. Enter and review the photo's location."
            }
        }
        scheduleSave()
    }

    private func updateGeotag(_ tag: CaptureGeoTag?) {
        guard var value = draft, !value.metadataOutcomeUnknown else { return }
        var metadata = value.captureMetadata ?? CapturePhotoMetadata(source: .unknown, timeSource: .importOnly)
        metadata.location = tag
        value.captureMetadata = metadata
        draft = value
    }

    func scheduleSave() {
        guard !isLoading, !isSubmitting, draft != nil else { return }
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 400_000_000) } catch { return }
            guard !Task.isCancelled else { return }
            await self?.saveDraft(showFeedback: false)
        }
    }

    private func currentDraft() -> CaptureDraft? {
        guard var value = draft else { return nil }
        // Never change the metadata of an insert with an uncertain outcome.
        if !value.metadataOutcomeUnknown {
            value.latitudeText = latitudeText
            value.longitudeText = longitudeText
            value.address = address.trimmingCharacters(in: .whitespacesAndNewlines)
            value.locationDescription = locationDescription
        }
        return value
    }

    @discardableResult
    func saveDraft(showFeedback: Bool = true) async -> Bool {
        guard !isSubmitting else { return false }
        guard let value = currentDraft() else { return true }
        guard !Task.isCancelled else { return false }
        do {
            try await store.save(value)
            if showFeedback && !isSubmitting && !isSubmitted {
                statusMessage = configuration.isConfigured
                    ? "Draft saved on this device. Tap Submit when you're ready."
                    : "Draft saved on this device. Connect the upload services in the build configuration to submit it."
            }
            return true
        } catch {
            errorMessage = "Couldn't save these changes. Keep this screen open and try again after unlocking your device or freeing some storage."
            return false
        }
    }

    func submit() async {
        guard !isBusy, var value = currentDraft(), let data = imageData else { return }
        errorMessage = nil
        guard configuration.isConfigured else {
            await saveDraft()
            errorMessage = configuration.setupIssue
            return
        }
        let targetProject = configuration.supabaseURL?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if let originalProject = value.submissionProjectURL, originalProject != targetProject {
            errorMessage = "This saved submission belongs to a different Supabase project. Restore that project's settings to check or retry it."
            return
        }
        guard value.metadataOutcomeUnknown || (coordinate != nil && locationReviewed) else {
            errorMessage = "Enter valid latitude (−90 to 90) and longitude (−180 to 180), then confirm you've reviewed the location."
            return
        }
        saveTask?.cancel()
        submissionStage = .savingDraft
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            // The protected image and all reviewed metadata are persisted before networking.
            try await store.save(value)
            draft = value
            var imageURL: URL
            if let uploaded = value.cloudImageURL {
                imageURL = uploaded
            } else {
                submissionStage = .uploadingPhoto
                imageURL = try await client.uploadImage(data)
                value.cloudImageURL = imageURL
                draft = value
                try await store.save(value)
            }

            submissionStage = .checkingReceipt
            if try await client.reportExists(imageURL: imageURL) {
                await finishConfirmed()
                return
            }
            if value.metadataOutcomeUnknown { throw CaptureUploadError.unresolvedSubmission }
            guard let coordinates = coordinate else { throw CaptureDraftError.unreadable }
            let resolvedAddress = value.address.isEmpty
                ? String(format: "%.6f, %.6f", locale: Locale(identifier: "en_US_POSIX"), coordinates.latitude, coordinates.longitude)
                : value.address
            value.metadataOutcomeUnknown = true
            value.submissionProjectURL = targetProject
            value.lastSubmissionError = nil
            draft = value
            try await store.save(value)
            submissionStage = .sendingDetails
            try await client.insertReport(imageURL: imageURL, latitude: coordinates.latitude,
                                          longitude: coordinates.longitude, address: resolvedAddress,
                                          capturedAt: value.captureMetadata?.capturedAt)
            await finishConfirmed()
        } catch {
            if let uploadError = error as? CaptureUploadError, uploadError.isDefinitiveMetadataRejection {
                value.metadataOutcomeUnknown = false
            }
            value.lastSubmissionError = error.localizedDescription
            draft = value
            do { try await store.save(value) }
            catch { statusMessage = "Keep the app open: the latest submission state could not be saved locally." }
            errorMessage = value.lastSubmissionError
        }
    }

    /// Only called after an explicit confirmation; submit still reconciles first.
    func retryMetadataAfterConfirmation() async {
        guard !isBusy, var value = draft, value.metadataOutcomeUnknown else { return }
        value.metadataOutcomeUnknown = false
        value.lastSubmissionError = nil
        do {
            try await store.save(value)
            draft = value
            locationReviewed = true // User confirmed resending this exact saved location.
            await submit()
        } catch {
            errorMessage = "Couldn't save the retry state. The original draft has been kept."
        }
    }

    private func finishConfirmed() async {
        do {
            try await store.remove()
            statusMessage = "Your report was received. Analysis results will appear on the map when processing finishes."
        } catch {
            statusMessage = "Your report was received, but the local draft couldn't be removed. Its receipt will be checked again before any future retry."
        }
        draft = nil
        imageData = nil
        isSubmitted = true
        errorMessage = nil
    }

    func discard() async {
        guard !isBusy else { return }
        saveTask?.cancel()
        do {
            try await store.remove()
            draft = nil
            imageData = nil
            preview = nil
            hasUnreadableDraft = false
            latitudeText = ""
            longitudeText = ""
            address = ""
            locationReviewed = false
            locationDescription = "Enter coordinates or use your current location."
            errorMessage = nil
            statusMessage = "Draft discarded from this device."
        } catch { errorMessage = "Couldn't discard the saved draft. Unlock your device and try again." }
    }

    func prepareNextReport() {
        guard isSubmitted, !isBusy else { return }
        preview = nil; draft = nil; imageData = nil
        latitudeText = ""; longitudeText = ""; address = ""
        locationReviewed = false; errorMessage = nil; isSubmitted = false
        locationDescription = "Enter coordinates or use your current location."
        statusMessage = "A photo and reviewed location make a useful report."
    }
}
