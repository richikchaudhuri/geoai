import SwiftUI
import MapKit
import GeoAICore

struct AssessmentCarousel: View {
    let rows: [RoadAssessment]
    @Binding var index: Int
    let onOpen: (RoadAssessment) -> Void
    let onClose: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var imageHeight: CGFloat = 142
    @ScaledMetric(relativeTo: .caption) private var pagingHeight: CGFloat = 42

    var body: some View {
        // Keep the pager's identity stable while changing pages. Only a new map
        // selection should trigger the dashboard's upward entrance transition.
        TabView(selection: $index) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { position, row in
                AssessmentPreview(imageHeight: imageHeight, pagingHeight: pagingHeight,
                    row: row, groupCount: rows.count, index: position,
                    onPrevious: { turnPage(to: position - 1) },
                    onNext: { turnPage(to: position + 1) },
                    onOpen: { onOpen(row) }, onClose: onClose)
                    .tag(position)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .frame(height: AssessmentPreview.height(imageHeight: imageHeight,
            pagingHeight: pagingHeight, groupCount: rows.count))
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
    private static let cardPadding: CGFloat = 14
    let imageHeight: CGFloat
    let pagingHeight: CGFloat

    static func height(imageHeight: CGFloat, pagingHeight: CGFloat, groupCount: Int) -> CGFloat {
        imageHeight + cardPadding * 2 + (groupCount > 1 ? pagingHeight + 1 : 0)
    }

    let row: RoadAssessment
    let groupCount: Int
    let index: Int
    let onPrevious: () -> Void
    let onNext: () -> Void
    let onOpen: () -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 14) {
                RoadImage(url: row.imageURL, pixelWidth: 360)
                    .frame(width: 94, height: imageHeight)
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        SeverityBadge(row: row)
                        Spacer(minLength: 0)
                        Button(action: onClose) { Image(systemName: "xmark").font(.caption.weight(.semibold)).frame(width: 30, height: 30) }
                            .accessibilityLabel("Close observation")
                    }
                    HStack(alignment: .top, spacing: 6) {
                        RoadDistressIcon(type: row.primaryType, size: 20)
                            .foregroundStyle(GeoPalette.severity(row.severity))
                        Text(row.primaryType).font(.system(.headline, design: .rounded)).lineLimit(2)
                    }
                    Text(row.address.isEmpty ? "Road observation" : row.address)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    Spacer(minLength: 0)
                    Button(action: onOpen) {
                        HStack {
                            Text("View assessment")
                            Image(systemName: "arrow.up.right")
                        }.font(.caption.weight(.semibold))
                    }
                    .accessibilityLabel("View full assessment")
                }
            }
            .frame(height: imageHeight)
            .padding(Self.cardPadding)
            if groupCount > 1 {
                Divider().frame(height: 1).padding(.horizontal, 16)
                HStack {
                    Text("\(index + 1) of \(groupCount) at this location")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button(action: onPrevious) { Image(systemName: "chevron.left").frame(width: 36, height: 36) }
                        .disabled(index == 0)
                        .accessibilityLabel("Previous observation")
                    Button(action: onNext) { Image(systemName: "chevron.right").frame(width: 36, height: 36) }
                        .disabled(index + 1 >= groupCount)
                        .accessibilityLabel("Next observation")
                }.padding(.horizontal, 16).frame(height: pagingHeight)
            }
        }
        .buttonStyle(.plain)
    }
}

struct AssessmentDetailView: View {
    let row: RoadAssessment
    var embedded = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    ZStack(alignment: .bottomLeading) {
                        RoadImage(url: row.imageURL, pixelWidth: 1200).frame(height: 280)
                        LinearGradient(colors: [.clear, .black.opacity(0.5)], startPoint: .center, endPoint: .bottom)
                        HStack {
                            SeverityBadge(row: row)
                            if row.expertReviewed {
                                Label("Reviewed", systemImage: "checkmark.seal.fill")
                                    .font(.caption.weight(.medium)).foregroundStyle(.white)
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
                            .font(.subheadline).foregroundStyle(.secondary)
                    }

                    if row.isAssessed, let confidence = row.confidence {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text("Model confidence").font(.subheadline)
                                Spacer()
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
                        }
                    } else if !row.isAssessed {
                        Label("This observation has no completed assessment. Check its status below.", systemImage: "clock")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }

                    if row.types.count > 1 {
                        VStack(alignment: .leading, spacing: 10) {
                            Eyebrow(text: "Detected types")
                            ForEach(Array(row.types.enumerated()), id: \.offset) { _, type in
                                Label {
                                    Text(type)
                                } icon: {
                                    RoadDistressIcon(type: type, size: 22)
                                }.font(.subheadline)
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
                            .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(18)
                    }
                    .buttonStyle(.plain)
                    .background(Color.primary.opacity(0.08), in: Capsule())
                }
                .padding(22)
                .opacity(appeared ? 1 : 0)
                .offset(y: reduceMotion || appeared ? 0 : 14)
            }
            .navigationTitle("Observation")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                withAnimation(.easeOut(duration: reduceMotion ? 0.14 : 0.3)) { appeared = true }
            }
    }

    private func meta(_ title: String, value: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 18)
            Text(title).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 10)
            Text(value).font(.caption.weight(.medium)).multilineTextAlignment(.trailing)
        }
    }
}
