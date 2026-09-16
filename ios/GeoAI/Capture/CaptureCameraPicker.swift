import SwiftUI
import UIKit
import AVFoundation

struct CaptureCameraPhoto: Sendable {
    let data: Data
    let shutterTimestamp: Date?
    let receivedAt: Date
}

/// Records time in AVCapturePhoto's shutter callback, before any review delay.
struct CaptureCameraPicker: UIViewControllerRepresentable {
    let onPhoto: (CaptureCameraPhoto) -> Void
    let onCancel: () -> Void
    let onFailure: (String) -> Void

    func makeUIViewController(context: Context) -> CaptureCameraController {
        CaptureCameraController(onPhoto: onPhoto, onCancel: onCancel, onFailure: onFailure)
    }
    func updateUIViewController(_ controller: CaptureCameraController, context: Context) {}
    static func dismantleUIViewController(_ controller: CaptureCameraController, coordinator: ()) { controller.shutdown() }
}

private final class CaptureCameraTiming: @unchecked Sendable {
    private let lock = NSLock()
    private var timestamp: Date?
    private var photoData: Data?
    private var processingError: String?
    private var delivered = false
    func reset() { lock.lock(); defer { lock.unlock() }; timestamp = nil; photoData = nil; processingError = nil; delivered = false }
    func record(_ date: Date) { lock.lock(); defer { lock.unlock() }; timestamp = date }
    func processed(data: Data?, error: String?) {
        lock.lock(); defer { lock.unlock() }; photoData = data; processingError = error
    }
    func finish(error: String?) -> (accepted: Bool, timestamp: Date?, data: Data?, error: String?) {
        lock.lock(); defer { lock.unlock() }
        guard !delivered else { return (false, timestamp, nil, nil) }
        delivered = true
        return (true, timestamp, photoData, error ?? processingError)
    }
}

private struct CaptureCameraFailure: Error, Sendable {
    let message: String
    let code: Int

    init(_ message: String, code: Int) { self.message = message; self.code = code }
    init(_ error: NSError) {
        message = "\(error.localizedDescription) (\(error.domain), \(error.code))"
        code = error.code
    }
}

/// Configuration and blocking start/stop calls are serialized off the main thread.
private final class CaptureCameraSession: @unchecked Sendable {
    let session = AVCaptureSession()
    private var device: AVCaptureDevice?
    private let output = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "com.geoai.capture.session")
    private var configured = false
    private var terminated = false

    func configure(completion: @escaping (Result<AVCaptureDevice, CaptureCameraFailure>) -> Void) {
        queue.async {
            guard !self.terminated else { return }
            if self.configured, let device = self.device { completion(.success(device)); return }
            guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
                completion(.failure(CaptureCameraFailure("Allow camera access in Settings, then try again.", code: -11852)))
                return
            }
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                completion(.failure(CaptureCameraFailure("The rear camera is unavailable on this device.", code: -1)))
                return
            }
            let input: AVCaptureDeviceInput
            do { input = try AVCaptureDeviceInput(device: device) }
            catch { completion(.failure(CaptureCameraFailure(error as NSError))); return }

            self.session.beginConfiguration()
            guard self.session.canAddInput(input) else {
                self.session.commitConfiguration()
                completion(.failure(CaptureCameraFailure("The rear camera could not be connected to the capture session.", code: -2)))
                return
            }
            self.session.addInput(input)
            if self.session.canSetSessionPreset(.photo) { self.session.sessionPreset = .photo }
            // Validate the output against the session with its camera input installed.
            guard self.session.canAddOutput(self.output) else {
                self.session.removeInput(input)
                self.session.commitConfiguration()
                completion(.failure(CaptureCameraFailure("Photo capture is unavailable for this camera configuration.", code: -3)))
                return
            }
            self.session.addOutput(self.output)
            self.output.maxPhotoQualityPrioritization = .quality
            self.session.commitConfiguration()
            self.device = device
            self.configured = true
            completion(.success(device))
        }
    }

    func start(completion: @escaping () -> Void) {
        queue.async {
            guard !self.terminated, self.configured else { return }
            if !self.session.isRunning, !self.session.isInterrupted { self.session.startRunning() }
            completion()
        }
    }

    func capture(delegate: AVCapturePhotoCaptureDelegate, rotation: CGFloat, failure: @escaping (String) -> Void) {
        queue.async {
            guard !self.terminated, self.session.isRunning, !self.session.isInterrupted,
                  let connection = self.output.connection(with: .video), connection.isEnabled, connection.isActive else {
                failure("The camera is paused or unavailable. Return to the report and try again.")
                return
            }
            let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            settings.photoQualityPrioritization = .quality
            if connection.isVideoRotationAngleSupported(rotation) {
                connection.videoRotationAngle = rotation
            }
            self.output.capturePhoto(with: settings, delegate: delegate)
        }
    }

    func stop() {
        queue.async {
            guard !self.terminated else { return }
            self.terminated = true
            // Also cancel a preserved start request when the session is interrupted.
            self.session.stopRunning()
        }
    }
}

/// Overwrites one local state snapshot; never records media, locations or identifiers.
private struct CaptureCameraDiagnostic: Encodable, Sendable {
    let phase: String
    let event: String
    let errorCode: Int?
    let sessionRunning: Bool
    let interrupted: Bool
    let previewReady: Bool
    let layerBounds: [Double]
    let connectionPresent: Bool
    let connectionEnabled: Bool
    let connectionActive: Bool
}

final class CaptureCameraController: UIViewController, AVCapturePhotoCaptureDelegate {
    private let camera = CaptureCameraSession()
    nonisolated private let timing = CaptureCameraTiming()
    private var preview: AVCaptureVideoPreviewLayer?
    private var previewObservation: NSKeyValueObservation?
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
    private var sessionObservers: [NSObjectProtocol] = []
    private let shutter = UIButton(type: .system)
    private let closeButton = UIButton(type: .system)
    private let status = UILabel()
    private var isClosed = false
    private var isVisible = false
    private var isConfiguring = false
    private var isStarting = false
    private var isCapturing = false
    private var configuredDevice: AVCaptureDevice?
    private var mediaResetRestarts = 0
    private var pendingResetRestart = false
    private var phase = "created"
    private var lastErrorCode: Int?
    private var previewDeadline: Task<Void, Never>?
    private let diagnosticsQueue = DispatchQueue(label: "com.geoai.capture.diagnostics", qos: .utility)
    private let onPhoto: (CaptureCameraPhoto) -> Void
    private let onCancel: () -> Void
    private let onFailure: (String) -> Void

    init(onPhoto: @escaping (CaptureCameraPhoto) -> Void, onCancel: @escaping () -> Void, onFailure: @escaping (String) -> Void) {
        self.onPhoto = onPhoto; self.onCancel = onCancel; self.onFailure = onFailure
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Use the capture initializer") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        // Attach a visible layer before configuration; connect it once the input exists.
        let layer = AVCaptureVideoPreviewLayer()
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
        previewObservation = layer.observe(\.isPreviewing, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.updateReadiness(event: "preview_changed") }
        }
        observeLifecycle()
        var closeStyle = UIButton.Configuration.tinted()
        closeStyle.image = UIImage(systemName: "xmark")
        closeStyle.baseForegroundColor = .white
        closeStyle.baseBackgroundColor = .black
        closeStyle.cornerStyle = .capsule
        closeButton.configuration = closeStyle
        closeButton.accessibilityLabel = "Cancel camera"
        closeButton.addAction(UIAction { [weak self] _ in
            guard let self, !self.isClosed else { return }; self.shutdown(); self.onCancel()
        }, for: .touchUpInside)
        shutter.setImage(UIImage(systemName: "circle.inset.filled",
                                withConfiguration: UIImage.SymbolConfiguration(pointSize: 70, weight: .regular)), for: .normal)
        shutter.tintColor = .white
        shutter.accessibilityLabel = "Take road photo"
        shutter.isEnabled = false
        shutter.addAction(UIAction { [weak self] _ in self?.takePhoto() }, for: .touchUpInside)
        status.text = "Preparing camera…"
        status.textColor = .white
        status.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        status.layer.cornerRadius = 8
        status.clipsToBounds = true
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textAlignment = .center
        status.numberOfLines = 0
        for item in [closeButton, shutter, status] {
            item.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(item)
        }
        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 14),
            closeButton.widthAnchor.constraint(equalToConstant: 46), closeButton.heightAnchor.constraint(equalToConstant: 46),
            shutter.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            shutter.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -22),
            shutter.widthAnchor.constraint(equalToConstant: 88), shutter.heightAnchor.constraint(equalToConstant: 88),
            status.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            status.bottomAnchor.constraint(equalTo: shutter.topAnchor, constant: -18),
            status.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            status.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24)
        ])
        phase = "attached"
        record(event: "view_loaded")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        isVisible = true
        view.layoutIfNeeded()
        preview?.frame = view.bounds
        startWhenReady()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        isVisible = false
        previewDeadline?.cancel(); previewDeadline = nil
        if !isClosed { updateReadiness(event: "view_disappeared") }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let changed = preview?.frame != view.bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        preview?.frame = view.bounds
        CATransaction.commit()
        applyPreviewRotation(rotationCoordinator?.videoRotationAngleForHorizonLevelPreview ?? rotation)
        if changed { record(event: "preview_layout") }
    }

    private var isReady: Bool {
        guard !isClosed, isVisible, UIApplication.shared.applicationState == .active,
              camera.session.isRunning, !camera.session.isInterrupted,
              let preview, preview.isPreviewing, !preview.bounds.isEmpty,
              let connection = preview.connection, connection.isEnabled, connection.isActive else { return false }
        return true
    }

    private func startWhenReady() {
        guard !isClosed, isVisible, view.window != nil else { return }
        guard UIApplication.shared.applicationState == .active else {
            phase = "waiting_for_active_app"
            status.text = "Camera paused. Return to GeoAI to continue."
            shutter.isEnabled = false
            record(event: "start_deferred")
            return
        }
        guard !isConfiguring, !isStarting else { return }
        if configuredDevice == nil {
            isConfiguring = true
            phase = "configuring"
            status.text = "Preparing camera…"
            record(event: "configure_requested")
            camera.configure { [weak self] result in
                Task { @MainActor in
                    guard let self, !self.isClosed else { return }
                    self.isConfiguring = false
                    switch result {
                    case .failure(let error): self.fail(error)
                    case .success(let device):
                        self.configuredDevice = device
                        // The input/output graph is committed before this attachment.
                        self.preview?.session = self.camera.session
                        self.view.layoutIfNeeded()
                        self.preview?.frame = self.view.bounds
                        let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: self.preview)
                        self.rotationCoordinator = coordinator
                        self.rotationObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .new]) { [weak self] _, _ in
                            Task { @MainActor in
                                guard let self, let coordinator = self.rotationCoordinator else { return }
                                self.applyPreviewRotation(coordinator.videoRotationAngleForHorizonLevelPreview)
                            }
                        }
                        self.record(event: "configured_preview_connected")
                        self.startWhenReady()
                    }
                }
            }
            return
        }
        if camera.session.isInterrupted {
            updateReadiness(event: "start_waits_for_interruption")
            return
        }
        if camera.session.isRunning, !pendingResetRestart {
            updateReadiness(event: "session_already_running")
            return
        }
        pendingResetRestart = false
        isStarting = true
        phase = "starting"
        status.text = "Starting camera preview…"
        record(event: "start_requested")
        camera.start { [weak self] in
            Task { @MainActor in
                guard let self, !self.isClosed else { return }
                self.isStarting = false
                self.updateReadiness(event: "start_returned")
                if self.pendingResetRestart { self.startWhenReady() }
            }
        }
    }

    private func updateReadiness(event: String) {
        guard !isClosed else { return }
        shutter.isEnabled = isReady && !isCapturing
        if isCapturing {
            phase = "capturing"
            status.text = "Capturing…"
        } else if isReady {
            phase = "ready"
            previewDeadline?.cancel(); previewDeadline = nil
            status.text = "Frame the road damage.\nTimestamp is recorded at the shutter."
        } else if !isVisible || UIApplication.shared.applicationState != .active || camera.session.isInterrupted {
            phase = "paused"
            previewDeadline?.cancel(); previewDeadline = nil
            status.text = "Camera paused. Keep GeoAI open; the preview will resume when the camera is available."
        } else {
            phase = "waiting_for_preview"
            status.text = "Waiting for camera preview…"
            armPreviewDeadline()
        }
        record(event: event)
    }

    private func armPreviewDeadline() {
        guard previewDeadline == nil, !isClosed, isVisible else { return }
        previewDeadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 12_000_000_000) } catch { return }
            guard let self, !self.isClosed, self.isVisible, !self.isReady,
                  UIApplication.shared.applicationState == .active, !self.camera.session.isInterrupted else { return }
            self.phase = "preview_unavailable"
            self.shutter.isEnabled = false
            self.status.text = "Camera preview is unavailable. Close this screen and try again. Your saved draft is unchanged."
            self.record(event: "preview_timeout")
            // No automatic capture/retry loop. A later readiness event can recover.
        }
    }

    private func observeLifecycle() {
        let names: [Notification.Name] = [
            AVCaptureSession.runtimeErrorNotification, AVCaptureSession.wasInterruptedNotification,
            AVCaptureSession.interruptionEndedNotification, AVCaptureSession.didStartRunningNotification,
            AVCaptureSession.didStopRunningNotification
        ]
        for name in names {
            let observer = NotificationCenter.default.addObserver(forName: name, object: camera.session, queue: .main) { [weak self] notification in
                let error = notification.userInfo?[AVCaptureSessionErrorKey] as? NSError
                let reason = (notification.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber)?.intValue
                Task { @MainActor in self?.handleSessionEvent(name, error: error, reason: reason) }
            }
            sessionObservers.append(observer)
        }
        for name in [UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification] {
            let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, !self.isClosed else { return }
                    if name == UIApplication.didBecomeActiveNotification { self.startWhenReady() }
                    else {
                        self.phase = "paused"
                        self.shutter.isEnabled = false
                        self.previewDeadline?.cancel(); self.previewDeadline = nil
                        self.status.text = "Camera paused. Return to GeoAI to continue."
                        self.record(event: "app_resigning_active")
                    }
                }
            }
            sessionObservers.append(observer)
        }
    }

    private func handleSessionEvent(_ name: Notification.Name, error: NSError?, reason: Int?) {
        guard !isClosed else { return }
        if name == AVCaptureSession.runtimeErrorNotification {
            if let error { lastErrorCode = error.code }
            if error?.domain == AVFoundationErrorDomain,
               error?.code == AVError.Code.mediaServicesWereReset.rawValue, mediaResetRestarts < 1 {
                mediaResetRestarts += 1
                pendingResetRestart = true
                phase = "recovering_media_services"
                shutter.isEnabled = false
                previewDeadline?.cancel(); previewDeadline = nil
                status.text = "Reconnecting to the camera…"
                record(event: "media_services_reset")
                startWhenReady()
            } else if error?.domain == AVFoundationErrorDomain,
                      error?.code == AVError.Code.sessionWasInterrupted.rawValue {
                updateReadiness(event: "runtime_interruption")
            } else {
                fail(error.map(CaptureCameraFailure.init)
                     ?? CaptureCameraFailure("The camera stopped unexpectedly. Close this screen and try again.", code: -4))
            }
        } else if name == AVCaptureSession.wasInterruptedNotification {
            previewDeadline?.cancel(); previewDeadline = nil
            phase = "paused"
            shutter.isEnabled = false
            status.text = "Camera paused. It will resume when available."
            record(event: "interrupted_\(reason ?? 0)")
        } else if name == AVCaptureSession.interruptionEndedNotification {
            record(event: "interruption_ended")
            startWhenReady()
        } else {
            updateReadiness(event: name == AVCaptureSession.didStartRunningNotification ? "session_started" : "session_stopped")
        }
    }

    private func fail(_ error: CaptureCameraFailure) {
        guard !isClosed else { return }
        phase = "failed"
        lastErrorCode = error.code
        record(event: "failure")
        shutdown()
        onFailure(error.message)
    }

    private func record(event: String) {
        let bounds = preview?.bounds ?? .zero
        let connection = preview?.connection
        let snapshot = CaptureCameraDiagnostic(
            phase: phase, event: event, errorCode: lastErrorCode,
            sessionRunning: camera.session.isRunning, interrupted: camera.session.isInterrupted,
            previewReady: preview?.isPreviewing ?? false,
            layerBounds: [Double(bounds.origin.x), Double(bounds.origin.y), Double(bounds.width), Double(bounds.height)],
            connectionPresent: connection != nil, connectionEnabled: connection?.isEnabled ?? false,
            connectionActive: connection?.isActive ?? false
        )
        diagnosticsQueue.async {
            do {
                let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                             appropriateFor: nil, create: true)
                let url = directory.appendingPathComponent("camera-diagnostics.json")
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                try encoder.encode(snapshot).write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
                var excludedURL = url
                var values = URLResourceValues(); values.isExcludedFromBackup = true
                try excludedURL.setResourceValues(values)
            } catch { /* Diagnostics must never prevent a user from taking a photo. */ }
        }
    }

    private func applyPreviewRotation(_ angle: CGFloat) {
        guard !isClosed, let connection = preview?.connection, connection.isVideoRotationAngleSupported(angle) else { return }
        connection.videoRotationAngle = angle
    }
    private var rotation: CGFloat {
        switch view.window?.windowScene?.interfaceOrientation {
        case .landscapeLeft: return 0
        case .landscapeRight: return 180
        case .portraitUpsideDown: return 270
        default: return 90
        }
    }
    private func takePhoto() {
        guard shutter.isEnabled, isReady, !isCapturing else { return }
        isCapturing = true
        phase = "capturing"
        shutter.isEnabled = false; closeButton.isEnabled = false
        status.text = "Capturing…"
        record(event: "user_requested_photo")
        timing.reset()
        camera.capture(delegate: self, rotation: rotationCoordinator?.videoRotationAngleForHorizonLevelCapture ?? rotation) { [weak self] message in
            Task { @MainActor in
                guard let self, !self.isClosed else { return }; self.shutdown(); self.onFailure(message)
            }
        }
    }

    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, willCapturePhotoFor resolvedSettings: AVCaptureResolvedPhotoSettings) {
        timing.record(Date())
    }
    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        timing.processed(data: photo.fileDataRepresentation(), error: error?.localizedDescription)
    }
    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        let finished = timing.finish(error: error?.localizedDescription)
        guard finished.accepted else { return }
        let receivedAt = Date()
        Task { @MainActor in
            guard !self.isClosed else { return }
            self.shutdown()
            if let data = finished.data, finished.error == nil {
                self.onPhoto(CaptureCameraPhoto(data: data, shutterTimestamp: finished.timestamp, receivedAt: receivedAt))
            } else { self.onFailure(finished.error ?? "The photo could not be captured. Please try again.") }
        }
    }
    func shutdown() {
        guard !isClosed else { return }
        isClosed = true
        shutter.isEnabled = false
        previewDeadline?.cancel(); previewDeadline = nil
        previewObservation = nil
        rotationObservation = nil
        if phase != "failed" { phase = "closed" }
        record(event: "terminal_stop")
        sessionObservers.forEach { NotificationCenter.default.removeObserver($0) }
        sessionObservers.removeAll()
        camera.stop()
    }
}
