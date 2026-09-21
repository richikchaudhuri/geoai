import SwiftUI
import MapKit
import GeoAICore

struct AssessmentCarousel: View {
    let rows: [RoadAssessment]
    @Binding var index: Int
    var height: CGFloat = 300
    let onOpen: (RoadAssessment) -> Void
    let onClose: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Share the actual card height with the map so selected pins remain visible.
    static func preferredHeight(availableHeight: CGFloat, dynamicTypeSize: DynamicTypeSize, groupCount: Int) -> CGFloat {
        let contentHeight: CGFloat = dynamicTypeSize.isAccessibilitySize ? 410 : 300
        let desiredHeight = contentHeight + (groupCount > 1 ? 60 : 0)
        return min(desiredHeight, max(180, availableHeight * 0.62))
    }

    var body: some View {
        // Keep the pager's identity stable while changing pages. Only a new map
        // selection should trigger the dashboard's upward entrance transition.
        TabView(selection: $index) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { position, row in
                AssessmentPreview(row: row, groupCount: rows.count, index: position,
                    onPrevious: { turnPage(to: position - 1) },
                    onNext: { turnPage(to: position + 1) },
                    onOpen: { onOpen(row) }, onClose: onClose)
                    .tag(position)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .glass(radius: 28)
    }

    private func turnPage(to next: Int) {
        guard rows.indices.contains(next) else { return }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) {
            index = next
        }
    }
}

struct AssessmentPreview: View {
    let row: RoadAssessment
    let groupCount: Int
    let index: Int
    let onPrevious: () -> Void
    let onNext: () -> Void
    let onOpen: () -> Void
    let onClose: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    SeverityBadge(row: row).padding(.top, 8)
                    Spacer(minLength: 0)
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.headline.weight(.semibold))
                            .frame(width: 44, height: 44)
                            .background(Color.primary.opacity(0.05), in: Circle())
                    }
                    .accessibilityLabel("Close observation")
                }

                if dynamicTypeSize.isAccessibilitySize {
                    RoadImage(url: row.imageURL, pixelWidth: 720)
                        .frame(height: 112)
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                        .accessibilityHidden(true)
                    observationText
                } else {
                    HStack(alignment: .top, spacing: 16) {
                        RoadImage(url: row.imageURL, pixelWidth: 360)
                            .frame(width: 96, height: 116)
                            .clipShape(RoundedRectangle(cornerRadius: 18))
                            .accessibilityHidden(true)
                        observationText
                    }
                }

                Button(action: onOpen) {
                    HStack(spacing: 10) {
                        Text("View assessment")
                        Spacer(minLength: 4)
                        Image(systemName: "arrow.up.right")
                    }
                    .font(.body.weight(.semibold))
                    .frame(minHeight: 48)
                    .padding(.horizontal, 16)
                    .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
                }
                .accessibilityLabel("View full assessment")

                if groupCount > 1 {
                    Divider()
                    HStack(spacing: 10) {
                        Text("\(index + 1) of \(groupCount)")
                            .font(.subheadline).foregroundStyle(.secondary)
                            .accessibilityLabel("Observation \(index + 1) of \(groupCount) at this location")
                        Spacer(minLength: 0)
                        pageButton("chevron.left", label: "Previous observation", disabled: index == 0, action: onPrevious)
                        pageButton("chevron.right", label: "Next observation", disabled: index + 1 >= groupCount, action: onNext)
                    }
                }
            }
            .padding(16)
        }
        .scrollBounceBehavior(.basedOnSize)
        .buttonStyle(GeoPressStyle())
    }

    private var observationText: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                RoadDistressIcon(type: row.primaryType, size: 22)
                    .foregroundStyle(GeoPalette.severity(row.severity))
                Text(row.primaryType)
                    .font(.system(.title3, design: .rounded, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(row.address.isEmpty ? "Road observation" : row.address)
                .font(.subheadline).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func pageButton(_ symbol: String, label: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.headline.weight(.semibold))
                .frame(width: 44, height: 44)
                .background(Color.primary.opacity(0.05), in: Circle())
        }
        .disabled(disabled)
        .opacity(disabled ? 0.35 : 1)
        .accessibilityLabel(label)
    }
}

struct AssessmentDetailView: View {
    let row: RoadAssessment
    var embedded = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var appeared = false

    @ViewBuilder
    var body: some View {
        if embedded {
            content
        } else {
            NavigationStack {
                content.toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            }.presentationDragIndicator(.visible)
        }
    }

    private var content: some View {
        GeometryReader { viewport in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    ZStack(alignment: .bottomLeading) {
                        RoadImage(url: row.imageURL, pixelWidth: 1200).frame(height: 280)
                        LinearGradient(colors: [.clear, .black.opacity(0.5)], startPoint: .center, endPoint: .bottom)
                        adaptiveLayout {
                            SeverityBadge(row: row)
                            if row.expertReviewed {
                                Label("Reviewed", systemImage: "checkmark.seal.fill")
                                    .font(.subheadline.weight(.medium)).foregroundStyle(.white)
                            }
                        }.padding(20)
                    }.clipShape(RoundedRectangle(cornerRadius: 26))

                    VStack(alignment: .leading, spacing: 9) {
                        RoadDistressIcon(type: row.primaryType, size: 32)
                            .foregroundStyle(GeoPalette.severity(row.severity))
                            .padding(12)
                            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 17))
                        Eyebrow(text: "Road intelligence")
                        Text(row.primaryType).font(.system(.largeTitle, design: .rounded, weight: .semibold)).tracking(-1)
                        Text(row.address.isEmpty ? "Location recorded on map" : row.address)
                            .font(.body).foregroundStyle(.secondary)
                    }

                    if row.isAssessed, let confidence = row.confidence {
                        VStack(alignment: .leading, spacing: 10) {
                            adaptiveLayout {
                                Text("Model confidence").font(.body)
                                if !dynamicTypeSize.isAccessibilitySize { Spacer() }
                                Text(confidence.formatted(.percent.precision(.fractionLength(0))))
                                    .font(.system(.title3, design: .rounded, weight: .semibold)).monospacedDigit()
                            }
                            ProgressView(value: min(1, max(0, confidence)))
                                .tint(GeoPalette.severity(row.severity))
                        }.padding(18).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 20))
                    }

                    if !row.description.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Eyebrow(text: "Assessment notes")
                            Text(row.description).font(.body).lineSpacing(5)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else if !row.isAssessed {
                        Label("This observation has no completed assessment. Check its status below.", systemImage: "clock")
                            .font(.body).foregroundStyle(.secondary)
                    }

                    if row.types.count > 1 {
                        VStack(alignment: .leading, spacing: 10) {
                            Eyebrow(text: "Detected types")
                            ForEach(Array(row.types.enumerated()), id: \.offset) { _, type in
                                Label {
                                    Text(type)
                                } icon: {
                                    RoadDistressIcon(type: type, size: 22)
                                }.font(.body)
                            }
                        }
                    }

                    VStack(spacing: 16) {
                        meta("Status", value: row.state.title, symbol: "checklist")
                        if let date = row.capturedAt { meta("Captured", value: date.formatted(date: .abbreviated, time: .shortened), symbol: "camera") }
                        if let date = row.processedAt { meta("Assessed", value: date.formatted(date: .abbreviated, time: .shortened), symbol: "sparkles") }
                        meta("Coordinates", value: String(format: "%.5f, %.5f", row.latitude, row.longitude), symbol: "location")
                        meta("Light conditions", value: row.dayPeriod == .day ? "Daylight" : row.dayPeriod == .night ? "Night capture" : "Unknown", symbol: row.dayPeriod == .night ? "moon" : "sun.max")
                    }
                    .padding(20).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 22))

                    Button {
                        let item = MKMapItem(placemark: MKPlacemark(coordinate: .init(latitude: row.latitude, longitude: row.longitude)))
                        item.name = row.address.isEmpty ? "Road observation" : row.address
                        item.openInMaps()
                    } label: {
                        Label("Open in Apple Maps", systemImage: "arrow.up.right.square")
                            .font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44).padding(12)
                    }
                    .buttonStyle(GeoPressStyle())
                    .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 20))
                }
                .frame(width: max(0, viewport.size.width - 44), alignment: .leading)
                .padding(22)
                .opacity(appeared ? 1 : 0)
                .offset(y: reduceMotion || appeared ? 0 : 14)
            }
        }
            .navigationTitle("Observation")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                withAnimation(.easeOut(duration: reduceMotion ? 0.14 : 0.3)) { appeared = true }
            }
    }

    private func meta(_ title: String, value: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.body).foregroundStyle(.secondary).frame(width: 24)
            adaptiveLayout {
                Text(title).font(.subheadline).foregroundStyle(.secondary)
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 10) }
                Text(value).font(.body.weight(.medium))
                    .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var adaptiveLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
    }
}
