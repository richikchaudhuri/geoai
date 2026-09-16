import Foundation
import GeoAICore

struct AppConfiguration {
    let supabaseURL: URL?
    let publicKey: String
    let cloudName: String
    let uploadPreset: String

    init(bundle: Bundle = .main) {
        let url = bundle.url(forResource: "Configuration", withExtension: "plist")
        let data = url.flatMap { try? Data(contentsOf: $0) }
        let values = data.flatMap {
            (try? PropertyListSerialization.propertyList(from: $0, format: nil)) as? [String: String]
        } ?? [:]
        func value(_ key: String) -> String {
            (values[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let rawURL = value("SupabaseURL")
        supabaseURL = rawURL.isEmpty ? nil : URL(string: rawURL)
        publicKey = value("SupabasePublicKey")
        cloudName = value("CloudinaryCloudName")
        uploadPreset = value("CloudinaryUploadPreset")
    }

    var hasDatabase: Bool { supabaseURL != nil && !publicKey.isEmpty }

    func database() throws -> SupabaseConfiguration? {
        guard let url = supabaseURL, !publicKey.isEmpty else { return nil }
        return try SupabaseConfiguration(url: url, publicKey: publicKey)
    }

    var capture: CaptureConfiguration {
        CaptureConfiguration(supabaseURL: supabaseURL, supabasePublicKey: publicKey,
                             cloudinaryCloudName: cloudName, cloudinaryUploadPreset: uploadPreset)
    }
}
