import SwiftUI
import MapKit
import AVFoundation
import UIKit

@MainActor
struct CaptureFlow: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .largeTitle) private var heroFontSize = 38.0
    @ScaledMetric(relativeTo: .headline) private var stepBadgeSize = 40.0
    @StateObject private var model: CaptureViewModel
    @StateObject private var location = CaptureLocationManager()
    @State private var showCamera = false
    @State private var cameraPermissionInFlight = false
    @State private var cameraOpenPending = false
    @State private var isReportVisible = false
    @State private var showCameraPermissionAlert = false
    @State private var showDiscardConfirmation = false
    @State private var showRetryConfirmation = false
    @State private var hasAppeared = false
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
            VStack(alignment: .leading, spacing: 26) {
                if model.isSubmitted {
                    successContent
                        .transition(contentTransition)
                } else {
                    introduction
                    if model.isLoading {
                        ThinkingOrbs(label: "Opening your capture workspace…")
                            .transition(.opacity)
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
            .padding(.horizontal, 24)
            .padding(.top, 28)
            .padding(.bottom, 40)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
            .opacity(hasAppeared ? 1 : 0)
            .offset(y: hasAppeared || reduceMotion ? 0 : 12)
            .animation(contentAnimation, value: model.isSubmitted)
            .animation(contentAnimation, value: model.isPreparing)
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
        .onAppear {
            isReportVisible = true
            withAnimation(contentAnimation) { hasAppeared = true }
        }
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

    private var contentAnimation: Animation {
        reduceMotion ? .easeOut(duration: 0.18) : .spring(response: 0.48, dampingFraction: 0.88)
    }

    private var contentTransition: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom))
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 7) {
                Circle().fill(CapturePalette.green).frame(width: 7, height: 7)
                Text("ROAD SURFACE CAPTURE")
                    .font(.subheadline.weight(.semibold))
                    .tracking(1)
            }
            Text("Better roads.\nOne report at a time.")
                .font(.system(size: heroFontSize, weight: .semibold, design: .rounded))
                .tracking(-0.9)
                .fixedSize(horizontal: false, vertical: true)
            Text("Photograph the road, review its location, then send it for assessment.")
                .font(.body)
                .foregroundStyle(CapturePalette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var photoSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeading("01", title: "Road photo", detail: "Show the damage and its surroundings.")
            photoCanvas
                .overlay {
                    if model.isPreparing {
                        VStack(spacing: 18) {
                            ThinkingOrb(size: 64)
                            Text("Preparing your photo…")
                                .font(.headline)
                                .multilineTextAlignment(.center)
                        }
                        .padding(24)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(CapturePalette.surface.opacity(0.97))
                        .transition(.opacity)
                        .accessibilityElement(children: .combine)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 27, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 27).strokeBorder(CapturePalette.ink.opacity(0.07), lineWidth: 1))
                .shadow(color: .black.opacity(0.06), radius: 22, y: 9)

            if model.draft != nil && !model.isPreparing {
                Label(model.draft?.cloudImageURL == nil ? "Saved on this device" : "Photo uploaded", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(CapturePalette.green)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button { requestCamera() } label: {
                Label(model.preview == nil ? "Take photo" : "Retake photo", systemImage: "camera")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(CaptureActionStyle(prominent: true))
            .disabled(model.imageSelectionLocked || cameraPermissionInFlight || cameraOpenPending || showCamera)
            if model.draft?.cloudImageURL != nil {
                Text("The uploaded photo is kept for retry. Finish or discard this draft before taking another.")
                    .font(.subheadline).foregroundStyle(CapturePalette.muted)
            } else {
                Text("Photos are optimized for a clear, quick upload. Your original stays unchanged.")
                    .font(.subheadline)
                    .foregroundStyle(CapturePalette.muted)
            }
            if model.draft != nil {
                Label(model.photoTimestampText, systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(CapturePalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Time and location are saved with your report, keeping the photo clear.")
                    .font(.subheadline).foregroundStyle(CapturePalette.muted)
            } else {
                Text("Location is added when you take a photo. You can review or enter it before sending.")
                    .font(.subheadline).foregroundStyle(CapturePalette.muted)
            }
        }
    }

    @ViewBuilder
    private var photoCanvas: some View {
        if let image = model.preview {
            GeometryReader { geometry in
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: geometry.size.width, height: geometry.size.height)
            }
            .aspectRatio(1.12, contentMode: .fit)
            .background(Color(red: 0.10, green: 0.11, blue: 0.12))
            .accessibilityLabel("Selected road photo")
        } else {
            VStack(spacing: 18) {
                RoadCaptureIllustration()
                    .frame(width: 176, height: 110)
                    .accessibilityHidden(true)
                Text("Spot road damage")
                    .font(.title2.weight(.semibold))
                Text("Capture the damage and a little of the surrounding road.")
                    .font(.body)
                    .foregroundStyle(CapturePalette.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 145 : 88), spacing: 12)], spacing: 16) {
                    ForEach(["Potholes", "Cracks", "Surface wear"], id: \.self) { type in
                        VStack(spacing: 7) {
                            RoadDistressIcon(type: type, size: 28)
                                .accessibilityHidden(true)
                            Text(type)
                                .font(.subheadline.weight(.medium))
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .foregroundStyle(CapturePalette.muted)
                .padding(.top, 4)
            }
            .padding(24)
            .frame(maxWidth: .infinity)
            .background(CapturePalette.surface)
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
                        if location.isLocating { ThinkingOrb(size: 28) }
                        else { Image(systemName: "location") }
                        Text(location.isLocating ? "Finding a fresh location…" : "Use current location")
                            .font(.headline)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Image(systemName: "arrow.up.right").font(.body.weight(.semibold))
                    }
                    .frame(minHeight: 48)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.metadataLocked || location.isLocating || model.isBusy)
                Text("For an older photo, enter its original location below. Your current location may be different.")
                    .font(.subheadline).foregroundStyle(CapturePalette.muted)
                Divider().overlay(Color.black.opacity(0.03))
                coordinateLayout {
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
                    .frame(height: 190)
                    .clipShape(RoundedRectangle(cornerRadius: 17))
                    .allowsHitTesting(false)
                    .accessibilityLabel("Map preview of the entered report coordinates")
                }
                VStack(alignment: .leading, spacing: 7) {
                    Text("Place or address · Optional")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(CapturePalette.muted)
                    TextField("Road, landmark or neighbourhood", text: $model.address, axis: .vertical)
                        .font(.body)
                        .lineLimit(1...3)
                        .focused($focusedField, equals: .address)
                        .disabled(model.metadataLocked)
                        .padding(16)
                        .background(Color.black.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
                }
                Text(model.locationDescription).font(.subheadline).foregroundStyle(CapturePalette.muted)
                if !model.needsReconciliation {
                    Toggle(isOn: $model.locationReviewed) {
                        Text("I've checked that this is where the photo was taken.")
                            .font(.body.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .tint(CapturePalette.green)
                    .disabled(model.coordinate == nil || model.isSubmitting)
                } else {
                    Label("Saved coordinates are locked while receipt is checked.", systemImage: "lock")
                        .font(.subheadline).foregroundStyle(CapturePalette.muted)
                }
            }
            .padding(20)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 25))
            .overlay(RoundedRectangle(cornerRadius: 25).strokeBorder(Color.white, lineWidth: 1))
        }
    }

    private var coordinateLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
    }

    private var actions: some View {
        VStack(spacing: 13) {
            if model.isSubmitting {
                submissionIndicator
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
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
                .font(.headline)
                .padding(.horizontal, 4)
            }
            .buttonStyle(CaptureActionStyle(prominent: true))
            .disabled(model.isBusy || model.draft == nil)

            Text(model.statusMessage)
                .font(.subheadline)
                .foregroundStyle(CapturePalette.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if model.configuration.isConfigured && model.draft != nil {
                Text("Keep the app open while sending. Your photo and reviewed location are shared only when you tap Submit.")
                    .font(.subheadline)
                    .foregroundStyle(CapturePalette.muted)
                    .multilineTextAlignment(.center)
            }
            if model.hasDraft {
                secondaryActionLayout {
                    if model.configuration.isConfigured && model.draft != nil {
                        Button("Save draft") { Task { await model.saveDraft() } }
                            .frame(minHeight: 48)
                            .disabled(model.isBusy)
                    }
                    Button("Discard draft", role: .destructive) { showDiscardConfirmation = true }
                        .frame(minHeight: 48)
                        .disabled(model.isBusy)
                }
                .font(.body.weight(.medium))
                .tint(CapturePalette.ink)
                .padding(.top, 5)
            }
        }
    }

    private var submissionIndicator: some View {
        ThinkingOrbs(label: model.submissionStage.label)
    }

    private var secondaryActionLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 8))
            : AnyLayout(HStackLayout(spacing: 24))
    }

    private var retrySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("A response was interrupted.")
                .font(.headline)
            Text("Check submission first. It looks for this exact uploaded photo and will not send a second report.")
                .font(.subheadline).foregroundStyle(CapturePalette.muted)
            Button("Retry sending report") { showRetryConfirmation = true }
                .font(.body.weight(.semibold))
                .frame(minHeight: 48)
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
                .font(.system(size: heroFontSize * 1.5, weight: .light))
                .foregroundStyle(CapturePalette.green)
                .padding(.top, 30)
                .accessibilityHidden(true)
            Text("On the road\nto a better city.")
                .font(.system(size: heroFontSize, weight: .semibold, design: .rounded))
                .tracking(-0.9)
                .fixedSize(horizontal: false, vertical: true)
            Text(model.statusMessage)
                .font(.body).foregroundStyle(CapturePalette.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let image = model.preview {
                Image(uiImage: image).resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 25))
                    .accessibilityLabel("Submitted road photo")
            }
            Label("Receipt confirmed", systemImage: "checkmark.shield")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(CapturePalette.green)
            Button { close() } label: {
                Text("Back to the map").frame(maxWidth: .infinity)
            }
            .buttonStyle(CaptureActionStyle(prominent: true))
            Button { model.prepareNextReport() } label: {
                Text("Create another report").frame(maxWidth: .infinity)
            }
            .buttonStyle(CaptureActionStyle(prominent: false))
        }
    }

    private func sectionHeading(_ number: String, title: String, detail: String) -> some View {
        HStack(alignment: .center, spacing: 11) {
            Text(number).font(.subheadline.monospaced().weight(.semibold))
                .frame(width: stepBadgeSize, height: stepBadgeSize)
                .background(CapturePalette.surface, in: Circle())
                .overlay(Circle().strokeBorder(Color.black.opacity(0.08), lineWidth: 1))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.title3.weight(.semibold))
                Text(detail).font(.subheadline).foregroundStyle(CapturePalette.muted)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func coordinateField(_ title: String, placeholder: String, text: Binding<String>, field: CaptureField) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(CapturePalette.muted)
            TextField(placeholder, text: text)
                .font(.body.monospaced().weight(.medium))
                .keyboardType(.numbersAndPunctuation)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focusedField, equals: field)
                .disabled(model.metadataLocked)
                .padding(16)
                .background(Color.black.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel(title)
        }
    }

    private func messageCard(title: String, text: String, icon: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(tint).font(.title3.weight(.medium))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.headline)
                Text(text).font(.subheadline).foregroundStyle(CapturePalette.muted)
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 19)
            .padding(.horizontal, 20)
            .frame(minHeight: 60)
            .foregroundStyle(prominent ? Color(uiColor: .systemBackground) : CapturePalette.ink)
            .background(prominent ? CapturePalette.ink : CapturePalette.surface,
                        in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17).strokeBorder(prominent ? Color.clear : Color.black.opacity(0.07), lineWidth: 1))
            .opacity(isEnabled ? (configuration.isPressed ? 0.78 : 1) : 0.38)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.975 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.78), value: configuration.isPressed)
    }
}
