import SwiftUI
import GeoAICore
import ThinkingOrbsKit

typealias ThinkingOrbStyle = ThinkingOrbsKit.OrbState
typealias ThinkingOrbStyles = ThinkingOrbsKit.OrbStylePalette

enum GeoPalette {
    static let ink = Color(red: 0.10, green: 0.10, blue: 0.11)
    static let green = Color(red: 0.12, green: 0.68, blue: 0.39)
    static let amber = Color(red: 0.93, green: 0.68, blue: 0.12)

    static func severity(_ severity: Severity) -> Color {
        switch severity {
        case .low: return Color(red: 0.89, green: 0.67, blue: 0.12)
        case .moderate: return .orange
        case .high: return Color(red: 0.85, green: 0.16, blue: 0.18)
        case .none, .unknown: return .secondary
        }
    }
}

/// Pick once per loading view, never per animation frame or body update.
/// A shared style keeps multiple indicators for the same operation coordinated.
struct ThinkingOrb: View {
    var style: ThinkingOrbStyle? = nil
    var size: CGFloat = 44
    var active = true
    @Environment(\.scenePhase) private var scenePhase
    @State private var isVisible = false
    @State private var selectedStyle: ThinkingOrbStyle?

    var body: some View {
        ThinkingOrbsKit.ThinkingOrb(
            state: style ?? selectedStyle ?? .composing,
            size: size <= 32 ? .px20 : .px64,
            paused: !active || !isVisible || scenePhase != .active,
            displaySize: Double(size)
        )
        .frame(width: size, height: size)
        .fixedSize()
        .accessibilityHidden(true)
        .allowsHitTesting(false)
        .onAppear {
            if selectedStyle == nil { selectedStyle = ThinkingOrbStyles.next() }
            isVisible = true
        }
        .onDisappear { isVisible = false }
        .onChange(of: active) { wasActive, isActive in
            if !wasActive && isActive {
                selectedStyle = ThinkingOrbStyles.next(excluding: selectedStyle)
            }
        }
    }
}

struct ThinkingOrbs: View {
    var style: ThinkingOrbStyle? = nil
    var label: String = "Updating road intelligence"

    var body: some View {
        HStack(spacing: 12) {
            ThinkingOrb(style: style, size: 32)
            Text(label)
                .font(.subheadline.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .glass(radius: 24)
        .accessibilityElement(children: .combine)
    }
}

struct GeoPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.78), value: configuration.isPressed)
    }
}

struct BrandMark: View {
    var size: CGFloat = 39
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text("GEO")
                .font(.custom("Rostex-Outline", fixedSize: size))
            Text("AI").font(.system(size: size * 0.46, weight: .bold, design: .rounded))
        }
        .foregroundStyle(.primary)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("GeoAI")
    }
}

struct GlassSurface: ViewModifier {
    var radius: CGFloat = 26
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        content
            .background {
                let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
                if reduceTransparency {
                    shape.fill(Color(uiColor: .secondarySystemBackground))
                } else {
                    shape.fill(.ultraThinMaterial)
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(.white.opacity(scheme == .dark ? 0.18 : 0.75), lineWidth: 1)
            }
            .shadow(color: .black.opacity(scheme == .dark ? 0.22 : 0.09), radius: 18, x: 0, y: 7)
    }
}

extension View {
    func glass(radius: CGFloat = 26) -> some View { modifier(GlassSurface(radius: radius)) }
}

struct RoundControl: View {
    let symbol: String
    let label: String
    var busy = false
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Group {
                if busy { ThinkingOrb(size: 28) }
                else { Image(systemName: symbol).font(.system(size: 21, weight: .medium)) }
            }
            .frame(width: 54, height: 54)
            .contentShape(Circle())
        }
        .buttonStyle(GeoPressStyle())
        .foregroundStyle(.primary)
        .modifier(RoundControlSurface())
        .disabled(busy)
        .accessibilityLabel(label)
    }
}

private struct RoundControlSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(Color(uiColor: .secondarySystemBackground), in: Circle())
                .overlay {
                    Circle().strokeBorder(.primary.opacity(0.15), lineWidth: 1)
                }
        } else if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: Circle())
        } else {
            content
                .background(.regularMaterial, in: Circle())
                .overlay {
                    Circle().strokeBorder(.primary.opacity(0.10), lineWidth: 1)
                }
                .shadow(color: .black.opacity(0.10), radius: 10, x: 0, y: 4)
        }
    }
}

struct Eyebrow: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(.footnote, design: .rounded, weight: .semibold))
            .tracking(1.3)
            .foregroundStyle(.secondary)
    }
}

struct SeverityBadge: View {
    let row: RoadAssessment
    var body: some View {
        Text(row.isAssessed ? row.severity.title.uppercased() : row.state.title.uppercased())
            .font(.system(.caption, design: .rounded, weight: .bold))
            .tracking(0.6)
            .foregroundStyle(row.isAssessed && (row.severity == .low || row.severity == .moderate) ? GeoPalette.ink : .white)
            .padding(.horizontal, 11).padding(.vertical, 6)
            .background(row.isAssessed ? GeoPalette.severity(row.severity) : Color.gray, in: Capsule())
    }
}

/// Small road-condition symbols inherit their accompanying text's foreground style.
struct RoadDistressIcon: View {
    let type: String
    var size: CGFloat = 22

    var body: some View {
        RoadDistressShape(kind: RoadDistressKind(type))
            .stroke(.foreground, style: StrokeStyle(lineWidth: max(1, size / 15), lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private enum RoadDistressKind {
    case road, pothole, longitudinal, transverse, alligator, bleeding, wear

    init(_ type: String) {
        let text = type.lowercased()
        if ["unknown", "pending", "unassessed", "normal"].contains(where: { text.contains($0) }) {
            self = .road
        } else if text.contains("pothole") || text.contains("d40") {
            self = .pothole
        } else if text.contains("longitudinal") || text.contains("d00") {
            self = .longitudinal
        } else if text.contains("transverse") || text.contains("d10") {
            self = .transverse
        } else if text.contains("alligator") || text.contains("fatigue") || text.contains("d20") {
            self = .alligator
        } else if text.contains("bleeding") {
            self = .bleeding
        } else if ["ravel", "surface wear", "weathering", "hungry", "stripping", "edge breaking"].contains(where: { text.contains($0) }) {
            self = .wear
        } else if text.contains("crack") {
            self = .longitudinal
        } else {
            self = .road
        }
    }
}

private struct RoadDistressShape: Shape {
    let kind: RoadDistressKind

    func path(in rect: CGRect) -> Path {
        var path = Path()
        func line(_ points: [CGPoint]) { path.addLines(points) }
        line([CGPoint(x: 3, y: 21), CGPoint(x: 7, y: 3)])
        line([CGPoint(x: 21, y: 21), CGPoint(x: 17, y: 3)])
        switch kind {
        case .road:
            let segments: [(CGFloat, CGFloat)] = [(4, 7), (10, 13), (17, 21)]
            for (start, end) in segments {
                line([CGPoint(x: 12, y: start), CGPoint(x: 12, y: end)])
            }
        case .pothole:
            path.move(to: CGPoint(x: 8, y: 10))
            path.addCurve(to: CGPoint(x: 15, y: 9), control1: CGPoint(x: 9, y: 7), control2: CGPoint(x: 12, y: 10))
            path.addCurve(to: CGPoint(x: 18, y: 14), control1: CGPoint(x: 18, y: 9), control2: CGPoint(x: 16, y: 11))
            path.addCurve(to: CGPoint(x: 12, y: 18), control1: CGPoint(x: 20, y: 17), control2: CGPoint(x: 15, y: 17))
            path.addCurve(to: CGPoint(x: 6, y: 14), control1: CGPoint(x: 10, y: 19), control2: CGPoint(x: 5, y: 17))
            path.addCurve(to: CGPoint(x: 8, y: 10), control1: CGPoint(x: 5, y: 12), control2: CGPoint(x: 8, y: 12))
            path.closeSubpath()
            path.move(to: CGPoint(x: 9, y: 14))
            path.addQuadCurve(to: CGPoint(x: 15, y: 15), control: CGPoint(x: 12, y: 17))
        case .longitudinal:
            line([CGPoint(x: 12, y: 4), CGPoint(x: 10, y: 8), CGPoint(x: 13, y: 11), CGPoint(x: 10, y: 15), CGPoint(x: 12, y: 20)])
            line([CGPoint(x: 13, y: 11), CGPoint(x: 16, y: 10)])
        case .transverse:
            line([CGPoint(x: 6, y: 13), CGPoint(x: 9, y: 11), CGPoint(x: 12, y: 14), CGPoint(x: 15, y: 12), CGPoint(x: 18, y: 14)])
            line([CGPoint(x: 12, y: 14), CGPoint(x: 11, y: 17)])
        case .alligator:
            line([CGPoint(x: 10, y: 5), CGPoint(x: 13, y: 8), CGPoint(x: 10, y: 12), CGPoint(x: 14, y: 16), CGPoint(x: 12, y: 21)])
            line([CGPoint(x: 7, y: 8), CGPoint(x: 13, y: 8), CGPoint(x: 17, y: 6)])
            line([CGPoint(x: 6, y: 14), CGPoint(x: 10, y: 12), CGPoint(x: 17, y: 11)])
            line([CGPoint(x: 5, y: 19), CGPoint(x: 10, y: 18), CGPoint(x: 10, y: 12)])
            line([CGPoint(x: 14, y: 16), CGPoint(x: 19, y: 17)])
        case .bleeding:
            path.move(to: CGPoint(x: 8, y: 9))
            path.addCurve(to: CGPoint(x: 16, y: 10), control1: CGPoint(x: 12, y: 5), control2: CGPoint(x: 12, y: 12))
            path.addCurve(to: CGPoint(x: 17, y: 17), control1: CGPoint(x: 20, y: 8), control2: CGPoint(x: 15, y: 13))
            path.addCurve(to: CGPoint(x: 7, y: 16), control1: CGPoint(x: 19, y: 21), control2: CGPoint(x: 4, y: 20))
            path.addCurve(to: CGPoint(x: 8, y: 9), control1: CGPoint(x: 10, y: 13), control2: CGPoint(x: 4, y: 12))
            path.closeSubpath()
            line([CGPoint(x: 10, y: 14), CGPoint(x: 14, y: 13)])
        case .wear:
            for point in [CGPoint(x: 10, y: 7), CGPoint(x: 14, y: 10), CGPoint(x: 8, y: 13), CGPoint(x: 13, y: 15), CGPoint(x: 17, y: 18), CGPoint(x: 9, y: 20)] {
                path.addEllipse(in: CGRect(x: point.x - 0.7, y: point.y - 0.7, width: 1.4, height: 1.4))
            }
        }
        return path.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24)
            .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
    }
}

/// Decorative road artwork for the capture screen; no scanning or face framing cues.
struct RoadCaptureIllustration: View {
    var body: some View {
        ZStack {
            RoadCaptureShape(part: .surface).fill(Color.secondary.opacity(0.07))
            RoadCaptureShape(part: .edges)
                .stroke(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            RoadCaptureShape(part: .lanes)
                .stroke(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            RoadCaptureShape(part: .pothole)
                .fill(Color(red: 0.20, green: 0.23, blue: 0.26))
                .overlay {
                    RoadCaptureShape(part: .pothole)
                        .stroke(GeoPalette.amber, style: StrokeStyle(lineWidth: 2.2, lineJoin: .round))
                }
            RoadCaptureShape(part: .depression)
                .stroke(Color.white.opacity(0.25), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
        }
        .frame(width: 140, height: 100)
        .accessibilityHidden(true)
    }
}

private struct RoadCaptureShape: Shape {
    enum Part { case surface, edges, lanes, pothole, depression }
    let part: Part

    func path(in rect: CGRect) -> Path {
        var path = Path()
        switch part {
        case .surface:
            path.addLines([CGPoint(x: 57, y: 9), CGPoint(x: 83, y: 9), CGPoint(x: 124, y: 94), CGPoint(x: 16, y: 94)])
            path.closeSubpath()
        case .edges:
            path.addLines([CGPoint(x: 16, y: 94), CGPoint(x: 57, y: 9)])
            path.addLines([CGPoint(x: 83, y: 9), CGPoint(x: 124, y: 94)])
        case .lanes:
            let segments: [(CGFloat, CGFloat)] = [(15, 22), (32, 44), (60, 79)]
            for (start, end) in segments {
                path.addLines([CGPoint(x: 70, y: start), CGPoint(x: 70, y: end)])
            }
        case .pothole:
            path.move(to: CGPoint(x: 90, y: 61))
            path.addCurve(to: CGPoint(x: 104, y: 67), control1: CGPoint(x: 94, y: 57), control2: CGPoint(x: 100, y: 65))
            path.addCurve(to: CGPoint(x: 110, y: 78), control1: CGPoint(x: 113, y: 67), control2: CGPoint(x: 104, y: 73))
            path.addCurve(to: CGPoint(x: 94, y: 86), control1: CGPoint(x: 115, y: 85), control2: CGPoint(x: 99, y: 82))
            path.addCurve(to: CGPoint(x: 79, y: 77), control1: CGPoint(x: 88, y: 90), control2: CGPoint(x: 76, y: 81))
            path.addCurve(to: CGPoint(x: 90, y: 61), control1: CGPoint(x: 76, y: 68), control2: CGPoint(x: 90, y: 70))
            path.closeSubpath()
        case .depression:
            path.move(to: CGPoint(x: 85, y: 76))
            path.addQuadCurve(to: CGPoint(x: 101, y: 79), control: CGPoint(x: 90, y: 82))
        }
        return path.applying(CGAffineTransform(scaleX: rect.width / 140, y: rect.height / 100)
            .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
    }
}

struct RoadImage: View {
    let url: URL?
    var pixelWidth = 800
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var imageURL: URL? {
        guard let url, url.scheme?.lowercased() == "https" else { return nil }
        guard url.host?.lowercased() == "res.cloudinary.com", url.path.contains("/upload/") else { return url }
        return URL(string: url.absoluteString.replacingOccurrences(
            of: "/upload/", with: "/upload/f_auto,q_auto,w_\(pixelWidth),c_limit/"
        ))
    }

    var body: some View {
        // The container owns layout. A loaded landscape image must never grow
        // a vertical scroll view to its aspect-fill width; clipping alone only
        // clips drawing and does not constrain the size reported to the parent.
        GeometryReader { bounds in
            AsyncImage(url: imageURL, transaction: Transaction(animation: .easeOut(duration: reduceMotion ? 0.12 : 0.26))) { phase in
                switch phase {
                case .success(let image): image.resizable().scaledToFill().transition(.opacity)
                case .failure:
                    placeholder(text: "Photo unavailable")
                case .empty:
                    ZStack {
                        Color.secondary.opacity(0.08)
                        if imageURL == nil { RoadDistressIcon(type: "Road", size: 28).foregroundStyle(.secondary) }
                        else { ThinkingOrb(size: 28).id(imageURL) }
                    }
                @unknown default:
                    placeholder(text: "Photo unavailable")
                }
            }
            .frame(width: bounds.size.width, height: bounds.size.height)
            .clipped()
        }
        .accessibilityLabel("Road observation photo")
    }

    private func placeholder(text: String) -> some View {
        ZStack {
            Color.secondary.opacity(0.08)
            VStack(spacing: 8) {
                RoadDistressIcon(type: "Road", size: 28)
                Text(text).font(.caption2).multilineTextAlignment(.center)
            }
            .foregroundStyle(.secondary).padding(10)
        }
    }
}

struct SheetHeader: View {
    let eyebrow: String
    let title: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: eyebrow)
            Text(title).font(.system(.largeTitle, design: .rounded, weight: .semibold)).tracking(-1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
