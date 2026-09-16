import SwiftUI
import GeoAICore

struct FilterSheet: View {
    @ObservedObject var store: AppStore
    var embedded = false
    var onShowMap: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    SheetHeader(eyebrow: "Refine the map", title: "Focus on what matters.")
                    VStack(alignment: .leading, spacing: 12) {
                        Eyebrow(text: "Severity")
                        choice("All severities", selected: store.filter.severity == nil) { store.filter.severity = nil }
                        ForEach(Severity.allCases, id: \.self) { severity in
                            choice(severity.title, selected: store.filter.severity == severity, color: GeoPalette.severity(severity)) {
                                store.filter.severity = severity
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        Eyebrow(text: "Capture time")
                        choice("Any time", selected: store.filter.dayPeriod == nil) { store.filter.dayPeriod = nil }
                        ForEach(DayPeriod.allCases, id: \.self) { period in
                            choice(period == .day ? "Day" : period == .night ? "Night" : "Unknown time",
                                   selected: store.filter.dayPeriod == period) { store.filter.dayPeriod = period }
                        }
                        Text("Day and night use the photo’s capture time and location. Dashed markers indicate night captures.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Text("\(store.visibleRows.count) observations match your filters.").font(.subheadline)
                    Button("Reset filters") { store.clearFilters() }.font(.subheadline)
                }.padding(24)
            }
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(embedded ? "Show map" : "Done") {
                        if let onShowMap { onShowMap() } else { dismiss() }
                    }
                }
            }
        }
        .presentationDragIndicator(.visible)
    }

    private func choice(_ title: String, selected: Bool, color: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if let color { Circle().fill(color).frame(width: 12, height: 12) }
                Text(title).font(.subheadline.weight(selected ? .semibold : .regular))
                Spacer()
                Image(systemName: selected ? "checkmark.circle.fill" : "circle").foregroundStyle(selected ? Color.primary : Color.secondary)
            }.padding(15).background(Color.primary.opacity(selected ? 0.07 : 0.025), in: RoundedRectangle(cornerRadius: 16))
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct SettingsSheet: View {
    @Binding var styleName: String
    let configuration: AppConfiguration
    @Environment(\.dismiss) private var dismiss
    private let columns = [GridItem(.flexible()), GridItem(.flexible())]
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    SheetHeader(eyebrow: "Make it yours", title: "A different perspective.")
                    Eyebrow(text: "Map appearance")
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(GeoMapStyle.allCases) { style in
                            Button { styleName = style.rawValue } label: {
                                VStack(alignment: .leading, spacing: 12) {
                                    MapStyleSwatch(style: style).frame(height: 85).clipShape(RoundedRectangle(cornerRadius: 13))
                                    HStack {
                                        Text(style.title).font(.subheadline.weight(.medium))
                                        Spacer()
                                        if style.rawValue == styleName { Image(systemName: "checkmark.circle.fill") }
                                    }
                                }.padding(10)
                                    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 21))
                                    .overlay { RoundedRectangle(cornerRadius: 21).strokeBorder(style.rawValue == styleName ? Color.primary : .clear, lineWidth: 1.5) }
                            }.buttonStyle(.plain).accessibilityAddTraits(style.rawValue == styleName ? .isSelected : [])
                        }
                    }
                    Text("Maps and place search use Apple Maps. Appearance tiles above are illustrations.")
                        .font(.caption).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 12) {
                        Eyebrow(text: "Connected services")
                        connection("Live observations", ready: configuration.hasDatabase)
                        connection("Photo reporting", ready: configuration.capture.isConfigured)
                        Text("This build includes a saved demo dataset. To connect your project, add its public configuration in Xcode. Private server keys stay on your backend.")
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(18).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 22))
                }.padding(24)
            }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDragIndicator(.visible)
    }
    private func connection(_ name: String, ready: Bool) -> some View {
        HStack {
            Text(name).font(.subheadline)
            Spacer()
            Text(ready ? "Configured" : "Setup needed").font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct MapStyleSwatch: View {
    let style: GeoMapStyle
    var body: some View {
        Canvas { context, size in
            let dark = style.isDark
            let satellite = style == .satellite || style == .hybrid
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(satellite ? Color(red: 0.20, green: 0.29, blue: 0.23) : dark ? Color(white: 0.15) : Color(red: 0.91, green: 0.92, blue: 0.90)))
            let park = CGRect(x: size.width * 0.58, y: -5, width: size.width * 0.28, height: size.height * 0.8)
            context.fill(Path(roundedRect: park, cornerRadius: 15), with: .color(dark ? .green.opacity(0.14) : .green.opacity(0.13)))
            for index in 0..<5 {
                var road = Path()
                road.move(to: CGPoint(x: CGFloat(index) * size.width / 3 - 20, y: 0))
                road.addLine(to: CGPoint(x: CGFloat(index) * size.width / 3 + 25, y: size.height))
                context.stroke(road, with: .color(dark ? .white.opacity(0.2) : .white), lineWidth: 5)
            }
            var cross = Path()
            cross.move(to: CGPoint(x: 0, y: size.height * 0.7))
            cross.addLine(to: CGPoint(x: size.width, y: size.height * 0.3))
            context.stroke(cross, with: .color(dark ? .white.opacity(0.4) : .white), lineWidth: 7)
            context.fill(Path(ellipseIn: CGRect(x: size.width * 0.4, y: size.height * 0.43, width: 12, height: 12)), with: .color(GeoPalette.severity(.high)))
        }.accessibilityHidden(true)
    }
}

struct ObservationListSheet: View {
    @ObservedObject var store: AppStore
    var embedded = false
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    private var rows: [RoadAssessment] {
        var filter = store.filter
        filter.query = query
        return filter.apply(to: store.rows)
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(rows) { row in
                        NavigationLink { AssessmentDetailView(row: row, embedded: true) } label: {
                            HStack(spacing: 14) {
                                RoadImage(url: row.imageURL, pixelWidth: 240)
                                    .frame(width: 72, height: 82).clipShape(RoundedRectangle(cornerRadius: 15))
                                VStack(alignment: .leading, spacing: 7) {
                                    SeverityBadge(row: row)
                                    HStack(alignment: .top, spacing: 6) {
                                        RoadDistressIcon(type: row.primaryType, size: 18)
                                            .foregroundStyle(GeoPalette.severity(row.severity))
                                        Text(row.primaryType).font(.subheadline.weight(.semibold))
                                    }
                                    Text(row.address).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                            }.padding(.vertical, 5)
                        }
                    }
                } header: { Text("\(rows.count) observations · \(store.source.label.lowercased())") }
            }
            .listStyle(.plain)
            .overlay { if rows.isEmpty { ContentUnavailableView.search(text: query) } }
            .searchable(text: $query, prompt: "Address, damage, or status")
            .navigationTitle("Road observations")
            .toolbar {
                if !embedded {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
            }
            .refreshable { await store.refresh() }
        }.presentationDragIndicator(.visible)
    }
}

struct AboutSheet: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    BrandMark(size: 62).padding(.top, 12)
                    SheetHeader(eyebrow: "Roads, understood", title: "Every observation\nadds perspective.")
                    Text("Explore road conditions, inspect AI assessments, and contribute photos from the street. GeoAI brings the website’s map-first experience to a native iPhone app.")
                        .font(.body).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 16) {
                        Label("Tap a marker to inspect its photos and assessment.", systemImage: "mappin.and.ellipse")
                        Label("Filter severity and day or night captures.", systemImage: "line.3.horizontal.decrease.circle")
                        Label("Review a photo and its location before submitting.", systemImage: "camera")
                    }.font(.subheadline)
                    Text("Assessments may be automated or awaiting expert review. Use current road conditions and your own judgement when travelling.")
                        .font(.caption).foregroundStyle(.secondary)
                    Divider()
                    Text("Built from the GeoAI project. Original project © 2026 Suraj B · Richik Chaudhuri · Sushant Deo, MIT License. Map data © Apple and its providers.")
                        .font(.caption2).foregroundStyle(.secondary)
                }.padding(26)
            }.toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDragIndicator(.visible)
    }
}
