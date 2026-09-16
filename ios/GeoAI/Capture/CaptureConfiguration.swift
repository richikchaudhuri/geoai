import Foundation

/// Client-safe settings only. No service-role or Cloudinary secret belongs in the app.
struct CaptureConfiguration {
    let supabaseURL: URL?
    let supabasePublicKey: String
    let cloudinaryCloudName: String
    let cloudinaryUploadPreset: String

    init(supabaseURL: URL?, supabasePublicKey: String, cloudinaryCloudName: String, cloudinaryUploadPreset: String) {
        self.supabaseURL = supabaseURL
        self.supabasePublicKey = supabasePublicKey.trimmingCharacters(in: .whitespacesAndNewlines)
        self.cloudinaryCloudName = cloudinaryCloudName.trimmingCharacters(in: .whitespacesAndNewlines)
        self.cloudinaryUploadPreset = cloudinaryUploadPreset.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var isConfigured: Bool { setupIssue == nil }

    var setupIssue: String? {
        guard let url = supabaseURL, let host = url.host, !host.isEmpty else {
            return "Add your Supabase project URL to the build configuration to send reports."
        }
        let localHost = ["localhost", "127.0.0.1", "::1"].contains(host.lowercased())
        guard url.scheme == "https" || (url.scheme == "http" && localHost) else {
            return "Use an HTTPS Supabase project URL."
        }
        guard url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            return "Use the Supabase project URL without a path, credentials or query."
        }
        guard !supabasePublicKey.isEmpty else {
            return "Add your Supabase public key to the build configuration to send reports."
        }
        guard Self.isPublicKey(supabasePublicKey) else {
            return "Use a Supabase publishable key or an anon JWT. Secret and service-role keys cannot be used in this app."
        }
        guard !cloudinaryCloudName.isEmpty, !cloudinaryUploadPreset.isEmpty else {
            return "Add a Cloudinary cloud name and unsigned upload preset to the build configuration."
        }
        guard cloudinaryCloudName.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
            return "The Cloudinary cloud name contains unsupported characters."
        }
        return nil
    }

    fileprivate static func isPublicKey(_ key: String) -> Bool {
        if key.hasPrefix("sb_secret_") { return false }
        if key.hasPrefix("sb_publishable_") { return key.count > "sb_publishable_".count }
        let parts = key.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return false }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return object["role"] as? String == "anon"
    }

    /// Publishable keys are not JWTs and must not be used as bearer tokens.
    var hasJWTKey: Bool { supabasePublicKey.split(separator: ".").count == 3 }
}
