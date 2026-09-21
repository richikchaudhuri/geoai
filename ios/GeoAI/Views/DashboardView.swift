import SwiftUI
import GeoAICore
import ThinkingOrbsKit

struct DashboardView: View {
    @ObservedObject var store: AppStore
    @StateObject private var places = PlaceSearchModel()
    @StateObject private var location = UserLocationController()
    @AppStorage("mapStyle") private var mapStyleName = GeoMapStyle.light.rawValue
    @State private var focus: MapFocus?
    @State private var selection: [RoadAssessment] = []
    @State private var selectionIndex = 0
    @State private var selectionPresentationID = UUID()
    @State private var detail: RoadAssessment?
    @State private var sheet: DashboardSheet?
    @State private var selectedTab = DashboardTab.map
    @State private var searchText = ""
    @State private var isSearchOpen = false
    @State private var summaryExpanded = false
    @State private var summaryHeight: CGFloat = 250
    @State private var refreshOrbStyle = ThinkingOrbStyles.next()
    @GestureState private var summaryDrag: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .headline) private var summaryHandleHeight: CGFloat = 76
    @FocusState private var searchFocused: Bool

    private var style: GeoMapStyle { GeoMapStyle(rawValue: mapStyleName) ?? .light }
    private var selectedRow: RoadAssessment? {
        selection.indices.contains(selectionIndex) ? selection[selectionIndex] : nil
    }
    private var panelMotion: Animation? {
        reduceMotion ? nil : .spring(response: 0.46, dampingFraction: 0.86)
    }
    private var panelTransition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(
            insertion: .move(edge: .bottom).combined(with: .opacity).combined(with: .scale(scale: 0.97, anchor: .bottom)),
            removal: .opacity.combined(with: .scale(scale: 0.98, anchor: .bottom)))
    }
    private var handleHeight: CGFloat { min(summaryHandleHeight, 112) }
    private var summaryTravel: CGFloat { max(0, summaryHeight - handleHeight) }
    private var summaryOffset: CGFloat {
        guard selectedRow == nil else { return 0 }
        return min(summaryTravel, max(0, (summaryExpanded ? 0 : summaryTravel) + summaryDrag))
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            mapPage
                .tabItem { Label("Map", systemImage: "map") }
                .tag(DashboardTab.map)

            FilterSheet(store: store, embedded: true) { selectedTab = .map }
                .tabItem { Label("Filters", systemImage: "line.3.horizontal.decrease") }
                .tag(DashboardTab.filters)

            NavigationStack {
                CaptureFlow(configuration: store.configuration.capture, embedded: true,
                            onClose: { selectedTab = .map }) {
                    Task { await store.refresh() }
                }
            }
            .tabItem { Label("Report", systemImage: "camera") }
            .tag(DashboardTab.report)

            ObservationListSheet(store: store, embedded: true)
                .tabItem { Label("Browse", systemImage: "road.lanes") }
                .tag(DashboardTab.browse)
        }
        .preferredColorScheme(style.isDark ? .dark : .light)
        .onChange(of: store.isLoading) { _, isLoading in
            if isLoading {
                refreshOrbStyle = ThinkingOrbStyles.next(excluding: refreshOrbStyle)
            }
        }
        .task { await store.initialRefresh() }
    }

    private var mapPage: some View {
        GeometryReader { geometry in
            let compact = geometry.size.height < 550
            let selectionHeight = AssessmentCarousel.preferredHeight(availableHeight: geometry.size.height,
                dynamicTypeSize: dynamicTypeSize, groupCount: selection.count)
            ZStack(alignment: .bottom) {
                NativeMapView(rows: store.visibleRows, style: style, focus: focus,
                              bottomInset: selectedRow == nil ? (summaryExpanded ? summaryHeight + 76 : handleHeight + 76) : selectionHeight + 76) { rows in
                    withAnimation(panelMotion) {
                        selection = rows
                        selectionIndex = 0
                        selectionPresentationID = UUID()
                        isSearchOpen = false
                    }
                    searchFocused = false
                }
                .ignoresSafeArea()

                VStack(spacing: 12) {
                    topBar
                    if store.isLoading {
                        ThinkingOrbs(style: refreshOrbStyle, label: "Refreshing live road data")
                            .transition(reduceMotion ? .opacity : .scale(scale: 0.92).combined(with: .opacity))
                    }
                    if isSearchOpen {
                        searchPanel.transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                    }
                    if let message = store.message ?? location.errorMessage {
                        messageBanner(message).transition(.opacity)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .animation(panelMotion, value: isSearchOpen)
                .animation(panelMotion, value: store.isLoading)

                if !searchFocused {
                    VStack(spacing: 12) {
                    HStack {
                        if store.hasFilters {
                            Button { store.clearFilters() } label: {
                                Label("Clear filters", systemImage: "xmark.circle.fill")
                                    .font(.subheadline.weight(.medium)).padding(14)
                            }.buttonStyle(GeoPressStyle()).glass(radius: 22)
                        }
                        Spacer()
                        RoundControl(symbol: "location", label: "Find my location", busy: location.isLocating) {
                            location.locate()
                        }
                    }
                    ZStack(alignment: .bottom) {
                        if selectedRow != nil {
                            AssessmentCarousel(rows: selection, index: $selectionIndex, height: selectionHeight,
                                onOpen: { detail = $0 },
                                onClose: { withAnimation(panelMotion) { selection = [] } })
                                .id(selectionPresentationID)
                                .transition(panelTransition)
                        } else {
                            summaryPanel(compact: compact, availableHeight: geometry.size.height)
                                .transition(panelTransition)
                        }
                    }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 12)
                    .frame(maxWidth: 620)
                    .frame(maxWidth: .infinity)
                    .offset(y: summaryOffset)
                    .animation(panelMotion, value: selectionPresentationID)
                    .animation(panelMotion, value: selectedRow == nil)
                    .animation(panelMotion, value: summaryExpanded)
                    .animation(panelMotion, value: summaryDrag == 0)
                    .transition(.opacity)
                }
            }
        }
        .sheet(item: $sheet) { active in
            switch active {
            case .settings: SettingsSheet(styleName: $mapStyleName, configuration: store.configuration)
            case .about: AboutSheet()
            }
        }
        .sheet(item: $detail) { AssessmentDetailView(row: $0) }
        .onChange(of: searchText) { _, query in places.search(query) }
        .onReceive(location.$coordinate.compactMap { $0 }) { coordinate in
            focus = MapFocus(latitude: coordinate.latitude, longitude: coordinate.longitude)
        }
        .onChange(of: store.visibleRows) { _, rows in
            let updated = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, newer in newer })
            selection = selection.compactMap { updated[$0.id] }
            selectionIndex = min(selectionIndex, max(0, selection.count - 1))
        }
        .onChange(of: selectedTab) { _, _ in
            searchFocused = false
            isSearchOpen = false
            searchText = ""
            places.cancel()
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { sheet = .about } label: {
                BrandMark(size: 35).padding(.horizontal, 19).frame(height: 56)
            }.buttonStyle(GeoPressStyle()).glass(radius: 28).accessibilityHint("About GeoAI")
            Spacer(minLength: 0)
            RoundControl(symbol: isSearchOpen ? "xmark" : "magnifyingglass", label: isSearchOpen ? "Close search" : "Search places") {
                isSearchOpen.toggle()
                searchFocused = isSearchOpen
                if !isSearchOpen { searchText = ""; places.cancel() }
            }
            RoundControl(symbol: "slider.horizontal.3", label: "Map settings") { sheet = .settings }
        }
    }

    private var searchPanel: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search a city or street", text: $searchText)
                    .font(.body).focused($searchFocused)
                    .submitLabel(.search).autocorrectionDisabled()
                if places.isSearching { ThinkingOrb(size: 28) }
                else if !searchText.isEmpty {
                    Button { searchText = "" } label: { Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44) }
                        .foregroundStyle(.secondary).accessibilityLabel("Clear search")
                }
            }.padding(18)
            if !places.results.isEmpty {
                Divider().padding(.horizontal)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(places.results) { place in
                            Button {
                                focus = MapFocus(latitude: place.latitude, longitude: place.longitude, span: 0.025)
                                searchFocused = false
                                isSearchOpen = false
                                searchText = ""
                                places.cancel()
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "mappin.circle").font(.title3)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(place.title).font(.body.weight(.medium))
                                        Text(place.subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                    Spacer()
                                    Image(systemName: "arrow.up.left").font(.caption)
                                }.padding(.horizontal, 18).padding(.vertical, 14).contentShape(Rectangle())
                            }.buttonStyle(GeoPressStyle())
                        }
                    }
                }.frame(maxHeight: 250)
            } else if let error = places.errorMessage {
                Text(error).font(.subheadline).foregroundStyle(.secondary).padding([.horizontal, .bottom])
            }
        }.glass(radius: 24)
    }

    private func summaryPanel(compact: Bool, availableHeight: CGFloat) -> some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(panelMotion) { summaryExpanded.toggle() }
            } label: {
                VStack(spacing: 9) {
                    Capsule().fill(.secondary.opacity(0.35)).frame(width: 38, height: 5)
                    HStack {
                        RoadDistressIcon(type: "Road", size: 24).foregroundStyle(.secondary)
                        Text("Road overview").font(.headline).lineLimit(2)
                        Spacer()
                        Image(systemName: "chevron.up")
                            .font(.caption.weight(.semibold))
                            .rotationEffect(.degrees(summaryExpanded ? 180 : 0))
                    }
                }
                .padding(.horizontal, 22)
                .frame(height: handleHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summaryExpanded ? "Collapse road overview" : "Expand road overview")
            .accessibilityValue(summaryExpanded ? "Expanded" : "Collapsed")
            .accessibilityHint("You can also swipe up or down on this header")
            .simultaneousGesture(summaryGesture)

            ScrollView {
                overview(compact: compact)
            }
                .frame(maxHeight: max(100, availableHeight * 0.52 - handleHeight))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHidden(!summaryExpanded)
                .allowsHitTesting(summaryExpanded)
        }
        .glass(radius: 28)
        .background {
            GeometryReader { proxy in
                Color.clear.preference(key: SummaryHeightKey.self, value: proxy.size.height)
            }
        }
        .onPreferenceChange(SummaryHeightKey.self) { height in
            if abs(summaryHeight - height) > 0.5 { summaryHeight = height }
        }
    }

    private var summaryGesture: some Gesture {
        DragGesture(minimumDistance: 8)
                .updating($summaryDrag) { value, state, transaction in
                    guard abs(value.translation.height) > abs(value.translation.width) else { return }
                    transaction.animation = nil
                    state = value.translation.height
                }
                .onEnded { value in
                    guard abs(value.translation.height) > abs(value.translation.width) else { return }
                    let projected = (summaryExpanded ? 0 : summaryTravel) + value.predictedEndTranslation.height
                    withAnimation(panelMotion) { summaryExpanded = projected < summaryTravel / 2 }
                }
    }

    private func overview(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                if !compact {
                VStack(alignment: .leading, spacing: 5) {
                    Text("A clearer way ahead.")
                        .font(.system(.title2, design: .rounded, weight: .semibold)).tracking(-0.5)
                        .fixedSize(horizontal: false, vertical: true)
                }
                }
                Spacer(minLength: 4)
                Button { Task { await store.refresh() } } label: {
                    Group {
                        if store.isLoading { ThinkingOrb(style: refreshOrbStyle, size: 30) }
                        else { Image(systemName: "arrow.clockwise").font(.body.weight(.medium)) }
                    }.frame(width: 48, height: 48)
                        .background(Color.primary.opacity(0.05), in: Circle())
                }.buttonStyle(GeoPressStyle()).disabled(store.isLoading).accessibilityLabel("Refresh observations")
            }
            HStack(spacing: 0) {
                statistic("Visible", value: store.visibleRows.count, color: .primary)
                Divider().frame(height: 32)
                statistic("Red alerts", value: store.highCount, color: GeoPalette.severity(.high))
            }
            if store.visibleRows.isEmpty {
                Text("No observations match these filters.").font(.subheadline).foregroundStyle(.secondary)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    sourceStatus
                    Spacer(minLength: 0)
                    browseButton
                }
                VStack(alignment: .leading, spacing: 8) {
                    sourceStatus
                    browseButton
                }
            }
        }.padding(.horizontal, 22).padding(.bottom, 22)
    }

    private var sourceStatus: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                Circle().fill(store.source.isLive ? GeoPalette.green : GeoPalette.amber).frame(width: 7, height: 7)
                Text(store.source.label).font(.caption.weight(.semibold)).tracking(0.7)
            }
            if let date = store.source.date {
                Text(date, format: .dateTime.day().month(.abbreviated).year()).font(.footnote)
            }
        }.foregroundStyle(.secondary)
    }

    private var browseButton: some View {
        Button { selectedTab = .browse } label: {
            Label("View list", systemImage: "arrow.up.right")
                .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
        }.buttonStyle(GeoPressStyle())
    }

    private func statistic(_ label: String, value: Int, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value, format: .number).font(.system(.largeTitle, design: .rounded, weight: .semibold))
                .monospacedDigit().foregroundStyle(color)
                .contentTransition(.numericText())
                .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: value)
            Text(label).font(.subheadline).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.leading, label == "Visible" ? 0 : 16)
            .accessibilityElement(children: .combine)
    }

    private func messageBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle").padding(.top, 2)
            Text(message).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            Button { store.message = nil; location.errorMessage = nil } label: {
                Image(systemName: "xmark").frame(width: 44, height: 44)
            }.buttonStyle(GeoPressStyle()).accessibilityLabel("Dismiss message")
        }.foregroundStyle(.primary).padding(14).glass(radius: 20)
    }
}

private enum DashboardSheet: String, Identifiable {
    case settings, about
    var id: String { rawValue }
}

private enum DashboardTab: Hashable {
    case map, filters, report, browse
}

private struct SummaryHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 250
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
