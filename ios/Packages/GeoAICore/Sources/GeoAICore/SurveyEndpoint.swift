import Foundation

/// The survey dashboard and its read-only API must belong to one explicit host.
/// This is also used by the native share/download bridge; page content never
/// gains permission to read arbitrary local URLs or contact an unrelated host.
public struct SurveyEndpoint: Equatable, Sendable {
    public enum ValidationError: LocalizedError {
        case missing, invalid, insecure
        public var errorDescription: String? {
            switch self {
            case .missing: return "Enter the address of your deployed GeoAI survey dashboard."
            case .invalid: return "Use a complete dashboard URL without a username or password."
            case .insecure: return "Use HTTPS for your survey dashboard. Local HTTP is only available in debug builds."
            }
        }
    }

    public let url: URL

    public init(_ text: String, allowLoopbackHTTP: Bool = false) throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ValidationError.missing }
        guard let parts = URLComponents(string: trimmed),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              let url = parts.url,
              parts.port.map({ (1...65535).contains($0) }) ?? true,
              !trimmed.contains(where: { $0.isWhitespace || $0.isNewline })
        else { throw ValidationError.invalid }
        let scheme = parts.scheme?.lowercased()
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
        guard scheme == "https" || (allowLoopbackHTTP && scheme == "http" && loopback) else {
            throw ValidationError.insecure
        }
        self.url = url
    }

    public var initialVideoURL: URL {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        var items = (parts.queryItems ?? []).filter { $0.name != "video" }
        items.append(URLQueryItem(name: "video", value: "1"))
        parts.queryItems = items
        return parts.url ?? url
    }

    public func contains(_ other: URL) -> Bool {
        guard other.user == nil, other.password == nil,
              let scheme = other.scheme?.lowercased(),
              scheme == url.scheme?.lowercased(),
              other.host?.lowercased() == url.host?.lowercased() else { return false }
        func port(_ value: URL) -> Int { value.port ?? (value.scheme?.lowercased() == "https" ? 443 : 80) }
        return port(other) == port(url)
    }

    /// External previews open only through explicit user links. HTTPS is
    /// supported everywhere; a debug HTTP endpoint may open its own previews.
    public func canOpenInBrowser(_ other: URL) -> Bool {
        guard other.user == nil, other.password == nil else { return false }
        if other.scheme?.lowercased() == "https" { return true }
        return other.scheme?.lowercased() == "http" && url.scheme?.lowercased() == "http" && contains(other)
    }

    public func resourceURL(_ text: String) -> URL? {
        guard let candidate = URL(string: text, relativeTo: url)?.absoluteURL,
              contains(candidate) else { return nil }
        return candidate
    }
}
