import SwiftUI

@main
struct GeoAIApp: App {
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            DashboardView(store: store)
                .tint(.primary)
                // Keep the whole experience comfortably legible on modern iPhones.
                .dynamicTypeSize(.xLarge...)
        }
    }
}
