# GeoAICore

Foundation-only data layer for the GeoAI iOS app. Swift tools 5.9, Swift 5 language mode, iOS 17 / macOS 13. No third-party dependencies.

```swift
let configuration = try SupabaseConfiguration(
    url: URL(string: "https://YOUR_PROJECT.supabase.co")!,
    publicKey: "YOUR_PUBLIC_PUBLISHABLE_OR_ANON_KEY"
)
let dataset = try await AssessmentRepository(configuration: configuration).loadLive()
let urgent = AssessmentFilter(severity: .high).apply(to: dataset.assessments)
```

The configuration initializer throws for secret/service-role keys, malformed public keys and insecure non-loopback URLs. Key-kind validation does not authenticate a key; Supabase performs authentication and enforces its row-level access policies. Publishable keys go in `apikey`; legacy anon JWTs also receive a bearer header.

Live loading requests both tables concurrently and reads deterministic 500-row pages. It requires exact response counts, checks duplicate IDs and changing totals, and refuses to return an unverifiable partial dataset. Bounds are 100,000 rows and 200 requests per table, 20 seconds per request and 60 seconds per table. A complete export represents records visible to the supplied public role; the app cannot detect records hidden by database policies. Concurrent database changes without count changes are not an atomic database snapshot.

`SnapshotDecoder` reads the repository's `{photos, assessments, fetchedAt}` export. It retains capture timestamps, prefers the newest assessment for a photo, applies reviewed corrections (including an empty corrected type list), excludes invalid coordinates and preserves unassessed uploads as pending. Civil twilight determines day/night from capture time and coordinates.

Run the checked-in XCTest suite using an Xcode-selected developer directory:

```sh
swift test
```

The fixture is copied from the website repository's May 25, 2026 snapshot. HTTP tests use URLProtocol stubs and do not access Supabase or upload data. Command Line Tools installations without XCTest can build the library, but require full Xcode to run `swift test`.
