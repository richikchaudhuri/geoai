// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GeoAICore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "GeoAICore", targets: ["GeoAICore"])],
    targets: [
        .target(name: "GeoAICore"),
        .testTarget(name: "GeoAICoreTests", dependencies: ["GeoAICore"], resources: [.copy("Fixtures")])
    ],
    swiftLanguageVersions: [.v5]
)
