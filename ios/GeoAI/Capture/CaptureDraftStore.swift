import Foundation
#if canImport(UIKit)
import UIKit
import ImageIO
#endif

struct CaptureGeoTag: Codable, Equatable, Sendable {
    enum Source: String, Codable, Sendable { case cameraGPS, currentLocation, photoMetadata, manual }
    let latitude: Double
    let longitude: Double
    let accuracyMetres: Double?
    let fixTimestamp: Date?
    let source: Source

    static func freshCameraFix(latitude: Double, longitude: Double, accuracyMetres: Double,
                               fixTimestamp: Date, shutterTimestamp: Date) -> CaptureGeoTag? {
        guard latitude.isFinite, longitude.isFinite, (-90...90).contains(latitude),
              (-180...180).contains(longitude), accuracyMetres.isFinite,
              (0...150).contains(accuracyMetres),
              abs(fixTimestamp.timeIntervalSince(shutterTimestamp)) <= 15 else { return nil }
        return CaptureGeoTag(latitude: latitude, longitude: longitude, accuracyMetres: accuracyMetres,
                             fixTimestamp: fixTimestamp, source: .cameraGPS)
    }

    func matches(latitude: Double, longitude: Double) -> Bool {
        abs(self.latitude - latitude) < 0.00000051 && abs(self.longitude - longitude) < 0.00000051
    }
}

struct CapturePhotoMetadata: Codable, Equatable, Sendable {
    enum Source: String, Codable, Sendable { case camera, library, unknown }
    enum TimeSource: String, Codable, Sendable { case shutter, originalPhoto, importOnly, cameraReceiptOnly }
    var source: Source
    var capturedAt: Date?
    var importedAt: Date?
    var timeSource: TimeSource
    /// Preserved when EXIF has a local time but no timezone; never guessed into UTC.
    var originalLocalTimestamp: String?
    var location: CaptureGeoTag?
}

struct CaptureDraft: Codable, Identifiable {
    let id: UUID
    let createdAt: Date
    let imageFilename: String
    let pixelWidth: Int
    let pixelHeight: Int
    var latitudeText = ""
    var longitudeText = ""
    var address = ""
    var locationDescription = "Enter coordinates or use your current location."
    var cloudImageURL: URL?
    /// Locks status reconciliation to the project that received the first insert.
    var submissionProjectURL: String?
    /// Saved before POST. A lost response requires reconciliation before any retry.
    var metadataOutcomeUnknown = false
    var lastSubmissionError: String?
    /// Optional for compatibility with drafts saved before capture metadata support.
    var captureMetadata: CapturePhotoMetadata?
}

#if canImport(UIKit)
actor CaptureDraftStore {
    private func folder() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                               appropriateFor: nil, create: true)
        var directory = base.appendingPathComponent("GeoAICapture", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.complete])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        return directory
    }

    func load() throws -> (CaptureDraft, Data)? {
        let directory = try folder()
        let recordURL = directory.appendingPathComponent("draft.json")
        guard FileManager.default.fileExists(atPath: recordURL.path) else { return nil }
        let draft = try JSONDecoder().decode(CaptureDraft.self, from: Data(contentsOf: recordURL))
        guard draft.imageFilename == "\(draft.id.uuidString).jpg" else { throw CaptureDraftError.unreadable }
        let imageData = try Data(contentsOf: directory.appendingPathComponent(draft.imageFilename))
        guard !imageData.isEmpty else { throw CaptureDraftError.unreadable }
        return (draft, imageData)
    }

    func create(photo: CapturePreparedPhoto, metadata: CapturePhotoMetadata) throws -> CaptureDraft {
        let directory = try folder()
        let id = UUID()
        let name = "\(id.uuidString).jpg"
        var draft = CaptureDraft(id: id, createdAt: Date(), imageFilename: name,
                                 pixelWidth: photo.width, pixelHeight: photo.height)
        draft.captureMetadata = metadata
        if let tag = metadata.location {
            draft.latitudeText = String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), tag.latitude)
            draft.longitudeText = String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), tag.longitude)
        }
        let imageURL = directory.appendingPathComponent(name)
        try photo.data.write(to: imageURL, options: [.atomic, .completeFileProtection])
        do { try save(draft) } catch {
            try? FileManager.default.removeItem(at: imageURL)
            throw error
        }
        // Remove replaced images only after the new record is committed.
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where url.pathExtension == "jpg" && url.lastPathComponent != name {
            try? FileManager.default.removeItem(at: url)
        }
        return draft
    }

    func save(_ draft: CaptureDraft) throws {
        let url = try folder().appendingPathComponent("draft.json")
        try JSONEncoder().encode(draft).write(to: url, options: [.atomic, .completeFileProtection])
    }

    func remove() throws {
        let directory = try folder()
        try FileManager.default.removeItem(at: directory)
    }
}

enum CaptureDraftError: LocalizedError {
    case unreadable, imageTooLarge, unsupportedImage
    var errorDescription: String? {
        switch self {
        case .unreadable: return "The saved draft could not be read. It has been kept on this device."
        case .imageTooLarge: return "This photo is too large to prepare. Please retake the photo."
        case .unsupportedImage: return "This image could not be prepared. Please retake the photo."
        }
    }
}

struct CapturePreparedPhoto: Sendable {
    let data: Data
    let width: Int
    let height: Int
}

enum CapturePhotoProcessor {
    static func metadata(in data: Data, source: CapturePhotoMetadata.Source,
                         importedAt: Date, assetDate: Date? = nil, shutterAt: Date? = nil) -> CapturePhotoMetadata {
        let imageSource = CGImageSourceCreateWithData(data as CFData, nil)
        let properties = imageSource.flatMap { CGImageSourceCopyPropertiesAtIndex($0, 0, nil) as? [String: Any] } ?? [:]
        let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any] ?? [:]
        let localTime = exif[kCGImagePropertyExifDateTimeOriginal as String] as? String
        let offset = exif["OffsetTimeOriginal"] as? String
        var exifDate: Date?
        if let localTime, let offset {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.isLenient = false
            formatter.dateFormat = "yyyy:MM:dd HH:mm:ssXXXXX"
            exifDate = formatter.date(from: localTime + offset)
        }
        let capturedAt = shutterAt ?? assetDate ?? exifDate
        let timeSource: CapturePhotoMetadata.TimeSource = shutterAt != nil ? .shutter
            : (capturedAt != nil ? .originalPhoto : (source == .camera ? .cameraReceiptOnly : .importOnly))
        var result = CapturePhotoMetadata(source: source, capturedAt: capturedAt, importedAt: importedAt,
                                          timeSource: timeSource, originalLocalTimestamp: localTime)
        // A library photo keeps only its own GPS metadata. It is never assigned the
        // device's current location automatically.
        if source == .library,
           let gps = properties[kCGImagePropertyGPSDictionary as String] as? [String: Any],
           let lat = gps[kCGImagePropertyGPSLatitude as String] as? Double,
           let lon = gps[kCGImagePropertyGPSLongitude as String] as? Double,
           let latRef = (gps[kCGImagePropertyGPSLatitudeRef as String] as? String)?.uppercased(),
           let lonRef = (gps[kCGImagePropertyGPSLongitudeRef as String] as? String)?.uppercased(),
           ["N", "S"].contains(latRef), ["E", "W"].contains(lonRef) {
            let latitude = latRef == "S" ? -abs(lat) : abs(lat)
            let longitude = lonRef == "W" ? -abs(lon) : abs(lon)
            if latitude.isFinite, longitude.isFinite, (-90...90).contains(latitude), (-180...180).contains(longitude) {
                result.location = CaptureGeoTag(latitude: latitude, longitude: longitude,
                                                accuracyMetres: nil, fixTimestamp: nil, source: .photoMetadata)
            }
        }
        return result
    }

    static func prepare(data: Data) throws -> CapturePreparedPhoto {
        guard data.count <= 40 * 1_024 * 1_024 else { throw CaptureDraftError.imageTooLarge }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1_600,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { throw CaptureDraftError.unsupportedImage }
        return try prepare(image: UIImage(cgImage: image))
    }

    static func prepare(image: UIImage) throws -> CapturePreparedPhoto {
        guard image.size.width > 0, image.size.height > 0 else { throw CaptureDraftError.unsupportedImage }
        // Rendering applies orientation and strips original EXIF/GPS metadata.
        // Reviewed coordinates are sent explicitly as report metadata instead.
        for longestEdge: CGFloat in [1_600, 1_280, 960] {
            let ratio = min(1, longestEdge / max(image.size.width, image.size.height))
            let size = CGSize(width: max(1, floor(image.size.width * ratio)),
                              height: max(1, floor(image.size.height * ratio)))
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let rendered = UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            for quality: CGFloat in [0.82, 0.70, 0.58] {
                if let jpeg = rendered.jpegData(compressionQuality: quality), jpeg.count <= 2 * 1_024 * 1_024 {
                    return CapturePreparedPhoto(data: jpeg, width: Int(size.width), height: Int(size.height))
                }
            }
        }
        throw CaptureDraftError.unsupportedImage
    }
}
#endif
