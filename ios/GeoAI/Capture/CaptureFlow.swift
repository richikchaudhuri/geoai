import SwiftUI
import MapKit
import AVFoundation
import UIKit

@MainActor
struct CaptureFlow: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: CaptureViewModel
    @StateObject private var location = CaptureLocationManager()
    @State private var showCamera = false
    @State private var cameraPermissionInFlight = false
    @State private var cameraOpenPending = false
    @State private var isReportVisible = false
    @State private var showCameraPermissionAlert = false
    @State private var showDiscardConfirmation = false
    @State private var showRetryConfirmation = false
    @FocusState private var focusedField: CaptureField?
    private let onSubmitted: () -> Void
    private let embedded: Bool
    private let onClose: (() -> Void)?

    init(configuration: CaptureConfiguration, embedded: Bool = false, onClose: (() -> Void)? = nil,
         onSubmitted: @escaping () -> Void) {
        _model = StateObject(wrappedValue: CaptureViewModel(configuration: configuration))
        self.onSubmitted = onSubmitted
        self.embedded = embedded
        self.onClose = onClose
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if model.isSubmitted {
                    successContent
                } else {
                    introduction
                    if model.isLoading {
                        HStack(spacing: 12) {
                            ProgressView().tint(CapturePalette.ink)
                            Text("Opening your capture workspace…").font(.subheadline)
                        }
                        .padding(22)
                    }
                    photoSection
                    if let issue = model.configuration.setupIssue {
                        messageCard(title: "Save now. Connect when ready.", text: issue,
                                    icon: "network", tint: CapturePalette.cyan)
                    }
                    if model.draft != nil { locationSection }
                    if let error = model.errorMessage {
                        messageCard(title: "Needs your attention", text: error,
                                    icon: "exclamationmark.circle", tint: Color.orange)
                    }
                    if model.needsReconciliation { retrySection }
                    actions
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 34)
            .frame(maxWidth: 680)
            .frame(maxWidth: .infinity)
        }
        .background {
            LinearGradient(colors: [Color(uiColor: .systemBackground), Color(uiColor: .secondarySystemBackground)],
                           startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea()
        }
        .foregroundStyle(CapturePalette.ink)
        .navigationTitle(model.isSubmitted ? "Report received" : "New road report")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(model.isSubmitted ? "Done" : "Close") { close() }
                    .tint(CapturePalette.ink)
                    .disabled(model.isBusy)
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focusedField = nil }.tint(CapturePalette.ink)
            }
        }
        .interactiveDismissDisabled(model.isSubmitting || model.isPreparing)
        .preferredColorScheme(embedded ? nil : .light)
        .onAppear { isReportVisible = true }
        .task { await model.load() }
        .onDisappear {
            isReportVisible = false
            if !showCamera { cameraOpenPending = false }
            if !showCamera { location.cancel() }
            Task { await model.saveDraft(showFeedback: false) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { presentCameraIfReady() }
        }
        .onChange(of: model.latitudeText) { _, _ in model.coordinatesChanged() }
        .onChange(of: model.longitudeText) { _, _ in model.coordinatesChanged() }
        .onChange(of: model.address) { _, _ in model.scheduleSave() }
        .onChange(of: model.isSubmitted) { _, submitted in
            if submitted { onSubmitted() }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CaptureCameraPicker(onPhoto: { photo in
                let tag = location.cameraGeotag(at: photo.shutterTimestamp)
                let note = location.cameraLocationStatus
                location.cancel()
                showCamera = false
                Task { await model.acceptCameraPhoto(photo, geotag: tag, locationNote: note) }
            }, onCancel: { location.cancel(); showCamera = false }, onFailure: { message in
                location.cancel(); showCamera = false; model.errorMessage = message
            })
            .ignoresSafeArea()
            .onAppear { location.beginCameraUpdates() }
        }
        .alert("Camera access is turned off", isPresented: $showCameraPermissionAlert) {
            Button("Open Settings") { openSettings() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Allow camera access in Settings to take a report photo. Nothing is captured or uploaded without your action.")
        }
        .confirmationDialog("Discard this draft?", isPresented: $showDiscardConfirmation, titleVisibility: .visible) {
            Button("Discard from this device", role: .destructive) {
                focusedField = nil
                location.cancel()
                Task { await model.discard() }
            }
            Button("Keep draft", role: .cancel) {}
        } message: {
            Text("This removes the saved photo and draft from this device. Photos or reports already sent to the service will not be deleted.")
        }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 7) {
                Circle().fill(CapturePalette.green).frame(width: 7, height: 7)
                Text("ROAD SURFACE CAPTURE")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .tracking(2)
            }
            Text("Better roads.\nOne report at a time.")
                .font(.system(size: 33, weight: .semibold, design: .rounded))
                .tracking(-1.2)
                .fixedSize(horizontal: false, vertical: true)
            Text("Photograph the road, review its location, then send it for assessment.")
                .font(.subheadline)
                .foregroundStyle(CapturePalette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var photoSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeading("01", title: "Road photo", detail: "Show the damage and its surroundings.")
            ZStack(alignment: .bottomLeading) {
                if let image = model.preview {
                    GeometryReader { geometry in
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(width: geometry.size.width, height: geometry.size.height)
                    }
                    .background(Color(red: 0.10, green: 0.11, blue: 0.12))
                    .accessibilityLabel("Selected road photo")
                } else {
                    VStack(spacing: 12) {
                        RoadCaptureIllustration()
                            .frame(width: 162, height: 102)
                        Text("Spot road damage")
                            .font(.system(size: 19, weight: .medium, design: .rounded))
                        Text("Capture the damage and a little of the surrounding road.")
                            .font(.footnote)
                            .foregroundStyle(CapturePalette.muted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 30)
                        HStack(spacing: 22) {
                            ForEach(["Potholes", "Cracks", "Surface wear"], id: \.self) { type in
                                VStack(spacing: 4) {
                                    RoadDistressIcon(type: type, size: 22)
                                    Text(type).font(.system(size: 10, weight: .medium))
                                }
                            }
                        }
                        .foregroundStyle(CapturePalette.muted)
                    }
                    .padding(.vertical, 18)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(CapturePalette.surface)
                }
                if model.isPreparing {
                    CapturePalette.surface.opacity(0.96)
                    VStack(spacing: 12) {
                        ProgressView().tint(CapturePalette.ink)
                        Text("Preparing a smaller, clear photo…").font(.footnote)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.draft != nil {
                    Label(model.draft?.cloudImageURL == nil ? "SAVED ON DEVICE" : "PHOTO UPLOADED", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .tracking(1)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .foregroundStyle(CapturePalette.ink)
                        .background(.regularMaterial, in: Capsule())
                        .padding(14)
                }
            }
            .aspectRatio(1.12, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 27, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 27).strokeBorder(Color.white, lineWidth: 1.5))
            .shadow(color: .black.opacity(0.06), radius: 22, y: 9)

            Button { requestCamera() } label: {
                Label(model.preview == nil ? "Take photo" : "Retake", systemImage: "camera")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(CaptureActionStyle(prominent: true))
            .disabled(model.imageSelectionLocked || cameraPermissionInFlight || cameraOpenPending || showCamera)
            if model.draft?.cloudImageURL != nil {
                Text("The uploaded photo is kept for retry. Finish or discard this draft before taking another.")
                    .font(.caption).foregroundStyle(CapturePalette.muted)
            } else {
                Text("Up to 1,600 px · JPEG under 2 MB · Original photo stays unchanged")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(CapturePalette.muted)
            }
            if model.draft != nil {
                Label(model.photoTimestampText, systemImage: "clock")
                    .font(.footnote)
                    .foregroundStyle(CapturePalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Timestamp and geotag are report metadata. They are not stamped onto the image.")
                    .font(.caption2).foregroundStyle(CapturePalette.muted)
            } else {
                Text("Taking a photo asks for a fresh GPS fix. If location access is unavailable, you can enter coordinates manually.")
                    .font(.caption).foregroundStyle(CapturePalette.muted)
            }
        }
    }

    private var locationSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            sectionHeading("02", title: "The right place", detail: "Review where this photo was taken.")
            VStack(alignment: .leading, spacing: 16) {
                Button {
                    focusedField = nil
                    location.requestLocation { result in
                        switch result {
                        case .success(let fix): model.useLocation(fix)
                        case .failure(let error): model.errorMessage = error.localizedDescription
                        }
                    }
                } label: {
                    HStack(spacing: 9) {
                        if location.isLocating { ProgressView().tint(CapturePalette.ink) }
                        else { Image(systemName: "location") }
                        Text(location.isLocating ? "Finding a fresh location…" : "Use current location")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Image(systemName: "arrow.up.right").font(.caption.weight(.semibold))
                    }
                    .padding(.vertical, 3)
                }
                .buttonStyle(.plain)
                .disabled(model.metadataLocked || location.isLocating || model.isBusy)
                Text("For an older photo, enter its original location below. Your current location may be different.")
                    .font(.caption).foregroundStyle(CapturePalette.muted)
                Divider().overlay(Color.black.opacity(0.03))
                HStack(alignment: .top, spacing: 12) {
                    coordinateField("Latitude", placeholder: "12.971600", text: $model.latitudeText, field: .latitude)
                    coordinateField("Longitude", placeholder: "77.594600", text: $model.longitudeText, field: .longitude)
                }
                if let coordinate = model.coordinate {
                    Map(initialPosition: .region(MKCoordinateRegion(center: coordinate,
                         span: MKCoordinateSpan(latitudeDelta: 0.004, longitudeDelta: 0.004)))) {
                        Marker("Road damage location", systemImage: "road.lanes", coordinate: coordinate)
                            .tint(CapturePalette.ink)
                    }
                    .id("\(coordinate.latitude),\(coordinate.longitude)")
                    .mapStyle(.standard(elevation: .flat, pointsOfInterest: .excludingAll))
                    .frame(height: 156)
                    .clipShape(RoundedRectangle(cornerRadius: 17))
                    .allowsHitTesting(false)
                    .accessibilityLabel("Map preview of the entered report coordinates")
                }
                VStack(alignment: .leading, spacing: 7) {
                    Text("PLACE OR ADDRESS · OPTIONAL")
                        .font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1)
                        .foregroundStyle(CapturePalette.muted)
                    TextField("Road, landmark or neighbourhood", text: $model.address, axis: .vertical)
                        .font(.subheadline)
                        .lineLimit(1...3)
                        .focused($focusedField, equals: .address)
                        .disabled(model.metadataLocked)
                        .padding(12)
                        .background(Color.black.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
                }
                Text(model.locationDescription).font(.caption2).foregroundStyle(CapturePalette.muted)
                if !model.needsReconciliation {
                    Toggle(isOn: $model.locationReviewed) {
                        Text("I've checked that this is where the photo was taken.")
                            .font(.footnote.weight(.medium))
                    }
                    .tint(CapturePalette.green)
                    .disabled(model.coordinate == nil || model.isSubmitting)
                } else {
                    Label("Saved coordinates are locked while receipt is checked.", systemImage: "lock")
                        .font(.caption).foregroundStyle(CapturePalette.muted)
                }
            }
            .padding(18)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 25))
            .overlay(RoundedRectangle(cornerRadius: 25).strokeBorder(Color.white, lineWidth: 1))
        }
    }

    private var actions: some View {
        VStack(spacing: 13) {
            if model.isSubmitting {
                HStack(spacing: 10) {
                    ProgressView().tint(CapturePalette.cyan)
                    Text(model.submissionStage).font(.subheadline.weight(.medium))
                    Spacer()
                }
                .padding(16)
                .background(CapturePalette.surface, in: RoundedRectangle(cornerRadius: 17))
                .accessibilityElement(children: .combine)
            }
            Button {
                focusedField = nil
                location.cancel()
                Task {
                    if model.configuration.isConfigured { await model.submit() }
                    else { await model.saveDraft() }
                }
            } label: {
                HStack(spacing: 10) {
                    Text(model.needsReconciliation ? "Check submission" : (model.configuration.isConfigured ? "Submit report" : "Save draft"))
                    Spacer()
                    Image(systemName: model.configuration.isConfigured ? "arrow.up.right" : "tray.and.arrow.down")
                }
                .font(.system(size: 17, weight: .semibold))
                .padding(.horizontal, 4)
            }
            .buttonStyle(CaptureActionStyle(prominent: true))
            .disabled(model.isBusy || model.draft == nil)

            Text(model.statusMessage)
                .font(.footnote)
                .foregroundStyle(CapturePalette.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if model.configuration.isConfigured && model.draft != nil {
                Text("Keep the app open while sending. Your photo and reviewed location are shared only when you tap Submit.")
                    .font(.caption2)
                    .foregroundStyle(CapturePalette.muted)
                    .multilineTextAlignment(.center)
            }
            if model.hasDraft {
                HStack(spacing: 24) {
                    if model.configuration.isConfigured && model.draft != nil {
                        Button("Save draft") { Task { await model.saveDraft() } }
                            .disabled(model.isBusy)
                    }
                    Button("Discard draft", role: .destructive) { showDiscardConfirmation = true }
                        .disabled(model.isBusy)
                }
                .font(.footnote.weight(.medium))
                .tint(CapturePalette.ink)
                .padding(.top, 5)
            }
        }
    }

    private var retrySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("A response was interrupted.")
                .font(.subheadline.weight(.semibold))
            Text("Check submission first. It looks for this exact uploaded photo and will not send a second report.")
                .font(.caption).foregroundStyle(CapturePalette.muted)
            Button("Retry sending report") { showRetryConfirmation = true }
                .font(.footnote.weight(.semibold))
                .tint(CapturePalette.ink)
                .disabled(model.isBusy || !model.configuration.isConfigured)
                .alert("Send this saved report again?", isPresented: $showRetryConfirmation) {
                    Button("Check again", role: .cancel) { Task { await model.submit() } }
                    Button("Retry sending") { Task { await model.retryMetadataAfterConfirmation() } }
                } message: {
                    Text("The same photo and saved coordinates will be used. We'll check for an existing report first. If the earlier request is still processing, retrying could create a duplicate.")
                }
        }
        .padding(18)
        .background(CapturePalette.surface, in: RoundedRectangle(cornerRadius: 21))
    }

    private var successContent: some View {
        VStack(alignment: .leading, spacing: 23) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 55, weight: .light))
                .foregroundStyle(CapturePalette.green)
                .padding(.top, 30)
            Text("On the road\nto a better city.")
                .font(.system(size: 36, weight: .semibold, design: .rounded))
                .tracking(-1.3)
            Text(model.statusMessage)
                .font(.body).foregroundStyle(CapturePalette.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let image = model.preview {
                Image(uiImage: image).resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 25))
                    .accessibilityLabel("Submitted road photo")
            }
            Label("RECEIPT CONFIRMED", systemImage: "checkmark.shield")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .tracking(1.5)
            Button("Back to the map") { close() }
                .frame(maxWidth: .infinity)
                .buttonStyle(CaptureActionStyle(prominent: true))
            Button("Create another report") { model.prepareNextReport() }
                .buttonStyle(.bordered)
        }
    }

    private func sectionHeading(_ number: String, title: String, detail: String) -> some View {
        HStack(alignment: .center, spacing: 11) {
            Text(number).font(.system(size: 11, weight: .bold, design: .monospaced))
                .frame(width: 31, height: 31)
                .background(CapturePalette.surface, in: Circle())
                .overlay(Circle().strokeBorder(Color.black.opacity(0.08), lineWidth: 1))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 17, weight: .semibold))
                Text(detail).font(.caption).foregroundStyle(CapturePalette.muted)
            }
        }
    }

    private func coordinateField(_ title: String, placeholder: String, text: Binding<String>, field: CaptureField) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title.uppercased())
                .font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1)
                .foregroundStyle(CapturePalette.muted)
            TextField(placeholder, text: text)
                .font(.system(size: 14, weight: .medium, design: .monospaced))
                .keyboardType(.numbersAndPunctuation)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: field)
                .disabled(model.metadataLocked)
                .padding(12)
                .background(Color.black.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel(title)
        }
    }

    private func messageCard(title: String, text: String, icon: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(tint).font(.system(size: 19, weight: .medium))
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(text).font(.caption).foregroundStyle(CapturePalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CapturePalette.surface.opacity(0.9), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(tint.opacity(0.18), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private func requestCamera() {
        guard !cameraPermissionInFlight, !cameraOpenPending, !showCamera else { return }
        focusedField = nil
        model.errorMessage = nil
        #if targetEnvironment(simulator)
        model.errorMessage = "Use GeoAI on your iPhone to take a road photo. The simulator has no physical camera."
        return
        #else
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            model.errorMessage = "The camera is unavailable on this device. Check Camera restrictions in Screen Time or device management."
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: openCamera()
        case .notDetermined:
            cameraPermissionInFlight = true
            Task {
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                cameraPermissionInFlight = false
                if granted { openCamera() } else { showCameraPermissionAlert = true }
            }
        case .denied, .restricted: showCameraPermissionAlert = true
        @unknown default: model.errorMessage = "The camera isn't available. Check camera access in Settings, then try again."
        }
        #endif
    }

    private func close() {
        focusedField = nil
        location.cancel()
        Task {
            if await model.saveDraft(showFeedback: false) {
                if model.isSubmitted { model.prepareNextReport() }
                if let onClose { onClose() } else { dismiss() }
            }
        }
    }

    private func openCamera() {
        guard isReportVisible else { return }
        cameraOpenPending = true
        presentCameraIfReady()
    }

    private func presentCameraIfReady() {
        guard cameraOpenPending, isReportVisible, scenePhase == .active, !showCamera else { return }
        cameraOpenPending = false
        showCamera = true
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }
}

private enum CaptureField: Hashable { case latitude, longitude, address }

private enum CapturePalette {
    static let ink = Color(uiColor: .label)
    static let muted = Color(uiColor: .secondaryLabel)
    static let surface = Color(uiColor: .secondarySystemBackground)
    static let cyan = Color(red: 0.00, green: 0.57, blue: 0.65)
    static let green = Color(red: 0.12, green: 0.58, blue: 0.38)
}

private struct CaptureActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .padding(.vertical, 17)
            .padding(.horizontal, 16)
            .foregroundStyle(prominent ? Color(uiColor: .systemBackground) : CapturePalette.ink)
            .background(prominent ? CapturePalette.ink : CapturePalette.surface,
                        in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17).strokeBorder(prominent ? Color.clear : Color.black.opacity(0.07), lineWidth: 1))
            .opacity(isEnabled ? (configuration.isPressed ? 0.78 : 1) : 0.38)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}
