import SwiftUI
import MapKit
import GeoAICore

enum GeoMapStyle: String, CaseIterable, Identifiable {
    case light, dark, voyager, satellite, minimal, hybrid

    var id: String { rawValue }

    var title: String {
        switch self {
        case .light: return "Light"
        case .dark: return "Dark"
        case .voyager: return "Explore"
        case .satellite: return "Satellite"
        case .minimal: return "Minimal"
        case .hybrid: return "Hybrid"
        }
    }

    var isDark: Bool {
        switch self {
        case .dark, .satellite, .hybrid: return true
        case .light, .voyager, .minimal: return false
        }
    }
}

struct MapFocus: Equatable {
    let id: UUID
    let latitude: Double
    let longitude: Double
    let span: Double

    init(latitude: Double, longitude: Double, span: Double = 0.012) {
        self.id = UUID()
        self.latitude = latitude
        self.longitude = longitude
        self.span = span
    }
}

/// Native MapKit rendering keeps map gestures, attribution, and clustering in UIKit.
/// Only an explicit new focus ID moves the camera after the initial region is set.
struct NativeMapView: UIViewRepresentable {
    var rows: [RoadAssessment]
    var style: GeoMapStyle
    var focus: MapFocus?
    var bottomInset: CGFloat = 220
    var onSelect: ([RoadAssessment]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onSelect: onSelect) }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView(frame: .zero)
        map.delegate = context.coordinator
        map.register(AssessmentAnnotationView.self,
                     forAnnotationViewWithReuseIdentifier: AssessmentAnnotationView.reuseID)
        map.showsUserLocation = false
        map.showsCompass = true
        map.showsScale = true
        map.isRotateEnabled = true
        map.isPitchEnabled = true
        map.accessibilityLabel = "Road assessment map"
        map.layoutMargins = UIEdgeInsets(top: 130, left: 16, bottom: bottomInset, right: 16)
        map.setRegion(
            MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: 12.9716, longitude: 77.5946),
                span: MKCoordinateSpan(latitudeDelta: 0.14, longitudeDelta: 0.14)
            ),
            animated: false
        )
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onSelect = onSelect
        let margins = UIEdgeInsets(top: 130, left: 16, bottom: max(0, bottomInset), right: 16)
        if map.layoutMargins != margins { map.layoutMargins = margins }
        coordinator.apply(style: style, to: map)
        coordinator.update(rows: rows, on: map)

        if let focus, focus.id != coordinator.lastFocusID {
            coordinator.lastFocusID = focus.id
            let coordinate = CLLocationCoordinate2D(latitude: focus.latitude, longitude: focus.longitude)
            guard CLLocationCoordinate2DIsValid(coordinate), focus.span.isFinite else { return }
            let delta = min(90, max(0.0005, focus.span))
            map.setRegion(
                MKCoordinateRegion(
                    center: coordinate,
                    span: MKCoordinateSpan(latitudeDelta: delta, longitudeDelta: delta)
                ),
                animated: !UIAccessibility.isReduceMotionEnabled
            )
        }
    }

    static func dismantleUIView(_ map: MKMapView, coordinator: Coordinator) {
        map.delegate = nil
        map.removeAnnotations(Array(coordinator.annotationsByID.values))
        coordinator.annotationsByID.removeAll()
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        var onSelect: ([RoadAssessment]) -> Void
        var lastFocusID: UUID?
        fileprivate var annotationsByID: [String: AssessmentAnnotation] = [:]
        private var appliedStyle: GeoMapStyle?
        private var displayedRows: [RoadAssessment] = []
        private let annotationViews = NSHashTable<AssessmentAnnotationView>.weakObjects()

        init(onSelect: @escaping ([RoadAssessment]) -> Void) {
            self.onSelect = onSelect
        }

        func apply(style: GeoMapStyle, to map: MKMapView) {
            guard appliedStyle != style else { return }
            appliedStyle = style
            map.overrideUserInterfaceStyle = style.isDark ? .dark : .light
            map.showsBuildings = style == .voyager || style == .hybrid

            switch style {
            case .satellite:
                map.preferredConfiguration = MKImageryMapConfiguration(elevationStyle: .realistic)
            case .hybrid:
                map.preferredConfiguration = MKHybridMapConfiguration(elevationStyle: .realistic)
            case .light, .dark, .minimal, .voyager:
                let configuration = MKStandardMapConfiguration(
                    elevationStyle: style == .voyager ? .realistic : .flat,
                    emphasisStyle: style == .voyager ? .default : .muted
                )
                configuration.pointOfInterestFilter = style == .minimal ? .excludingAll : .includingAll
                configuration.showsTraffic = style == .voyager
                map.preferredConfiguration = configuration
            }
        }

        func update(rows: [RoadAssessment], on map: MKMapView) {
            guard rows != displayedRows else { return }
            displayedRows = rows
            // Dictionary assignment tolerates duplicate IDs from a refreshed data source.
            var incoming: [String: RoadAssessment] = [:]
            for row in rows {
                let coordinate = CLLocationCoordinate2D(latitude: row.latitude, longitude: row.longitude)
                guard CLLocationCoordinate2DIsValid(coordinate) else { continue }
                incoming[row.id] = row
            }

            let removedIDs = annotationsByID.keys.filter { incoming[$0] == nil }
            let removed = removedIDs.compactMap { annotationsByID.removeValue(forKey: $0) }
            if !removed.isEmpty { map.removeAnnotations(removed) }

            var additions: [AssessmentAnnotation] = []
            var changedPresentation = false
            for (id, row) in incoming {
                if let annotation = annotationsByID[id] {
                    let changed = annotation.update(row: row)
                    if changed {
                        changedPresentation = true
                        (map.view(for: annotation) as? AssessmentAnnotationView)?.refresh()
                    }
                } else {
                    let annotation = AssessmentAnnotation(row: row)
                    annotationsByID[id] = annotation
                    additions.append(annotation)
                }
            }
            if !additions.isEmpty { map.addAnnotations(additions) }

            // Existing cluster objects retain their member annotations when metadata changes.
            if changedPresentation {
                for view in annotationViews.allObjects where view.annotation is MKClusterAnnotation {
                    view.refresh()
                }
            }
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            guard annotation is AssessmentAnnotation || annotation is MKClusterAnnotation else { return nil }
            let view = mapView.dequeueReusableAnnotationView(
                withIdentifier: AssessmentAnnotationView.reuseID,
                for: annotation
            ) as! AssessmentAnnotationView
            view.clusteringIdentifier = annotation is AssessmentAnnotation ? "road-assessments" : nil
            view.displayPriority = annotation is MKClusterAnnotation ? .defaultHigh : .defaultLow
            annotationViews.add(view)
            view.refresh()
            return view
        }

        func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
            guard let annotation = view.annotation else { return }
            let selected = assessmentRows(in: annotation).sorted {
                let left = AssessmentAppearance.rank($0.severity)
                let right = AssessmentAppearance.rank($1.severity)
                return left == right ? $0.id < $1.id : left > right
            }
            guard !selected.isEmpty else { return }
            // Deselect immediately so tapping the same marker can reopen its card.
            mapView.deselectAnnotation(annotation, animated: false)
            UISelectionFeedbackGenerator().selectionChanged()
            (view as? AssessmentAnnotationView)?.animateSelection()
            onSelect(selected)
        }
    }
}

private final class AssessmentAnnotation: NSObject, MKAnnotation {
    var row: RoadAssessment
    @objc dynamic var coordinate: CLLocationCoordinate2D

    var title: String? { row.address.isEmpty ? row.primaryType : row.address }

    init(row: RoadAssessment) {
        self.row = row
        self.coordinate = CLLocationCoordinate2D(latitude: row.latitude, longitude: row.longitude)
        super.init()
    }

    @discardableResult
    func update(row: RoadAssessment) -> Bool {
        guard self.row != row else { return false }
        let changed = self.row.severity != row.severity || self.row.dayPeriod != row.dayPeriod
            || self.row.address != row.address || self.row.types != row.types
            || self.row.isAssessed != row.isAssessed || self.row.primaryType != row.primaryType
        self.row = row // Selection always receives the latest details, including nonvisual fields.
        if coordinate.latitude != row.latitude || coordinate.longitude != row.longitude {
            coordinate = CLLocationCoordinate2D(latitude: row.latitude, longitude: row.longitude)
            return true
        }
        return changed
    }
}

private func assessmentRows(in annotation: MKAnnotation) -> [RoadAssessment] {
    if let single = annotation as? AssessmentAnnotation { return [single.row] }
    if let cluster = annotation as? MKClusterAnnotation {
        return cluster.memberAnnotations.flatMap { assessmentRows(in: $0) }
    }
    return []
}

private enum AssessmentAppearance {
    static func rank(_ severity: Severity) -> Int {
        switch severity {
        case .high: return 3
        case .moderate: return 2
        case .low: return 1
        case .none, .unknown: return 0
        }
    }

    static func name(_ severity: Severity) -> String {
        switch severity {
        case .high: return "high"
        case .moderate: return "moderate"
        case .low: return "low"
        case .none: return "none"
        case .unknown: return "unknown"
        }
    }

    static func color(_ severity: Severity) -> UIColor {
        switch severity {
        case .high: return UIColor(red: 0.85, green: 0.16, blue: 0.18, alpha: 1)
        case .moderate: return UIColor(red: 1, green: 0.5, blue: 0, alpha: 1)
        case .low: return UIColor(red: 0.89, green: 0.67, blue: 0.12, alpha: 1)
        case .none: return UIColor(red: 0.43, green: 0.52, blue: 0.58, alpha: 1)
        case .unknown: return UIColor(red: 0.56, green: 0.59, blue: 0.63, alpha: 1)
        }
    }
}

private final class AssessmentAnnotationView: MKAnnotationView {
    static let reuseID = "GeoAI.Assessment"
    private static let selectionAnimationKey = "GeoAI.selectionPulse"
    private let markerContent = UIView()
    private let halo = CAShapeLayer()
    private let circle = CAShapeLayer()
    private let countLabel = UILabel()

    override var annotation: MKAnnotation? {
        didSet { resetSelectionAnimation() }
    }

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        bounds = CGRect(x: 0, y: 0, width: 54, height: 54)
        backgroundColor = .clear
        collisionMode = .circle
        canShowCallout = false
        isAccessibilityElement = true
        accessibilityTraits = .button
        markerContent.frame = bounds
        markerContent.isUserInteractionEnabled = false
        markerContent.isAccessibilityElement = false
        addSubview(markerContent)
        markerContent.layer.addSublayer(halo)
        markerContent.layer.addSublayer(circle)
        countLabel.textAlignment = .center
        countLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .bold)
        countLabel.isAccessibilityElement = false
        countLabel.adjustsFontSizeToFitWidth = true
        countLabel.minimumScaleFactor = 0.7
        countLabel.isUserInteractionEnabled = false
        markerContent.addSubview(countLabel)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func prepareForDisplay() {
        super.prepareForDisplay()
        refresh()
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        resetSelectionAnimation()
        countLabel.text = nil
        accessibilityLabel = nil
        accessibilityHint = nil
    }

    func animateSelection() {
        // Animate only our artwork, leaving MapKit's position/transform untouched.
        // Replacing this finite animation also makes rapid repeated taps predictable.
        resetSelectionAnimation()
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
        pulse.values = [1, 1.18, 0.98, 1]
        pulse.keyTimes = [0, 0.35, 0.72, 1]
        pulse.duration = 0.38
        pulse.timingFunctions = [
            CAMediaTimingFunction(name: .easeOut),
            CAMediaTimingFunction(name: .easeInEaseOut),
            CAMediaTimingFunction(name: .easeOut)
        ]
        pulse.isRemovedOnCompletion = true
        markerContent.layer.add(pulse, forKey: Self.selectionAnimationKey)
    }

    private func resetSelectionAnimation() {
        // The model transform is never changed, so removal restores the exact baseline.
        markerContent.layer.removeAnimation(forKey: Self.selectionAnimationKey)
    }

    func refresh() {
        guard let annotation else { return }
        let rows = assessmentRows(in: annotation)
        guard !rows.isEmpty else { return }
        let severity = rows.max {
            AssessmentAppearance.rank($0.severity) < AssessmentAppearance.rank($1.severity)
        }?.severity ?? .unknown
        let isCluster = annotation is MKClusterAnnotation
        let allNight = rows.allSatisfy { $0.dayPeriod == .night }
        let nightCount = rows.filter { $0.dayPeriod == .night }.count
        let color = rows.contains(where: { $0.isAssessed })
            ? AssessmentAppearance.color(severity) : AssessmentAppearance.color(.unknown)
        let diameter: CGFloat = isCluster ? 40 : CGFloat(22 + AssessmentAppearance.rank(severity) * 4)
        let rect = CGRect(x: (54 - diameter) / 2, y: (54 - diameter) / 2,
                          width: diameter, height: diameter)

        // No implicit Core Animation tweening during live data updates or reduced-motion use.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        circle.path = UIBezierPath(ovalIn: rect).cgPath
        circle.fillColor = color.cgColor
        circle.strokeColor = UIColor.white.cgColor
        circle.lineWidth = 2.5
        circle.lineDashPattern = allNight ? [4, 3] : nil
        halo.path = UIBezierPath(ovalIn: rect.insetBy(dx: -4, dy: -4)).cgPath
        halo.fillColor = UIColor.black.withAlphaComponent(allNight ? 0.25 : 0.08).cgColor
        halo.strokeColor = allNight ? UIColor(white: 0.08, alpha: 0.9).cgColor : UIColor.clear.cgColor
        halo.lineWidth = 1.5
        halo.lineDashPattern = allNight ? [3, 3] : nil
        CATransaction.commit()

        countLabel.frame = rect.insetBy(dx: 4, dy: 4)
        countLabel.text = isCluster ? (rows.count > 999 ? "999+" : String(rows.count)) : nil
        countLabel.textColor = severity == .high ? .white : UIColor(white: 0.05, alpha: 1)

        if isCluster {
            accessibilityLabel = "\(rows.count) road assessments, highest severity \(AssessmentAppearance.name(severity)), \(nightCount) night captures"
            accessibilityHint = "Opens the assessments at this location"
        } else if let row = rows.first {
            let status = row.isAssessed
                ? "\(row.primaryType), severity \(AssessmentAppearance.name(row.severity))"
                : row.primaryType
            let period: String
            switch row.dayPeriod {
            case .day: period = "Day capture"
            case .night: period = "Night capture"
            case .unknown: period = "Capture time unknown"
            }
            accessibilityLabel = "\(status). \(period). \(row.address)"
            accessibilityHint = "Opens assessment details"
        }
    }
}
