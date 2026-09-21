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
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    Text("\(store.visibleRows.count) observations match your filters.").font(.body)
                    Button { store.clearFilters() } label: {
                        Text("Reset filters")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .padding(.horizontal, 16)
                            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 16))
                    }.buttonStyle(GeoPressStyle())
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
                Text(title).font(.body.weight(selected ? .semibold : .regular))
                Spacer()
                Image(systemName: selected ? "checkmark.circle.fill" : "circle").foregroundStyle(selected ? Color.primary : Color.secondary)
            }.frame(minHeight: 28).padding(16)
                .background(Color.primary.opacity(selected ? 0.07 : 0.025), in: RoundedRectangle(cornerRadius: 18))
        }.buttonStyle(GeoPressStyle()).accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct SettingsSheet: View {
    @Binding var styleName: String
    let configuration: AppConfiguration
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var columns: [GridItem] {
        dynamicTypeSize.isAccessibilitySize
            ? [GridItem(.flexible())]
            : [GridItem(.adaptive(minimum: 150), spacing: 14)]
    }
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
                                    MapStyleSwatch(style: style).frame(height: 100).clipShape(RoundedRectangle(cornerRadius: 15))
                                    HStack {
                                        Text(style.title).font(.body.weight(.medium))
                                        Spacer()
                                        if style.rawValue == styleName { Image(systemName: "checkmark.circle.fill") }
                                    }
                                }.padding(12)
                                    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 21))
                                    .overlay { RoundedRectangle(cornerRadius: 21).strokeBorder(style.rawValue == styleName ? Color.primary : .clear, lineWidth: 1.5) }
                            }.buttonStyle(GeoPressStyle()).accessibilityAddTraits(style.rawValue == styleName ? .isSelected : [])
                        }
                    }
                    Text("Maps and place search use Apple Maps. Appearance tiles above are illustrations.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 12) {
                        Eyebrow(text: "Services")
                        connection("Live observations", ready: configuration.hasDatabase)
                        connection("Photo reporting", ready: configuration.capture.isConfigured)
                        Text("Service availability is checked when you refresh the map or send a photo. The map shows whether observations are live, saved, or a demo.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }.padding(18).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 22))
                }.padding(24)
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDragIndicator(.visible)
    }
    private func connection(_ name: String, ready: Bool) -> some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        return layout {
            Text(name).font(.body)
            if !dynamicTypeSize.isAccessibilitySize { Spacer() }
            Text(ready ? "Configured" : "Setup needed").font(.subheadline).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
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
                            rowLayout {
                                RoadImage(url: row.imageURL, pixelWidth: 240)
                                    .frame(width: dynamicTypeSize.isAccessibilitySize ? nil : 84,
                                           height: dynamicTypeSize.isAccessibilitySize ? 140 : 104)
                                    .clipShape(RoundedRectangle(cornerRadius: 18))
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 9) {
                                    SeverityBadge(row: row)
                                    HStack(alignment: .top, spacing: 8) {
                                        RoadDistressIcon(type: row.primaryType, size: 22)
                                            .foregroundStyle(GeoPalette.severity(row.severity))
                                        Text(row.primaryType).font(.body.weight(.semibold))
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    Text(row.address.isEmpty ? "Location recorded on map" : row.address)
                                        .font(.subheadline).foregroundStyle(.secondary)
                                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                                }
                            }.padding(.vertical, 10)
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

    private var rowLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 14))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 16))
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
                    Text("Explore road conditions, understand assessments, and contribute photos from the street. A clearer view of the roads around you.")
                        .font(.body).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 16) {
                        Label("Tap a marker to inspect its photos and assessment.", systemImage: "mappin.and.ellipse")
                        Label("Filter severity and day or night captures.", systemImage: "line.3.horizontal.decrease.circle")
                        Label("Review a photo and its location before submitting.", systemImage: "camera")
                    }.font(.body)
                    Text("Assessments may be automated or awaiting expert review. Use current road conditions and your own judgement when travelling.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Divider()
                    Text("Built from the GeoAI project. Original project © 2026 Suraj B · Richik Chaudhuri · Sushant Deo, MIT License. Map data © Apple and its providers.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }.padding(26)
            }.toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDragIndicator(.visible)
    }
}
