import SwiftUI
import Foundation
import WebKit
import SafariServices
import GeoAICore

/// Video shares the deployed dashboard so the same filters, route geometry,
/// evidence, exports and map cache are used on web, Android and iOS.
@MainActor
struct SurveyDashboardView: View {
    @StateObject private var model: SurveyWebStore
    @State private var editingConnection = false
    @Environment(\.scenePhase) private var scenePhase

    init(configuration: AppConfiguration) {
        _model = StateObject(wrappedValue: SurveyWebStore(configuredURL: configuration.surveyDashboardURL))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                if let webView = model.webView {
                    SurveyWebContainer(webView: webView)
                        .accessibilityLabel("Video survey map")
                } else {
                    ContentUnavailableView {
                        Label("Connect video surveys", systemImage: "video")
                    } description: {
                        Text("Connect your deployed GeoAI dashboard to explore drive paths, street distress and kilometres travelled. Your existing map and camera reports stay available.")
                    } actions: {
                        Button("Set dashboard address") { editingConnection = true }
                            .buttonStyle(.borderedProminent)
                    }
                }
                if let error = model.errorMessage {
                    VStack(spacing: 14) {
                        Image(systemName: "wifi.exclamationmark").font(.title)
                        Text(error).font(.body).multilineTextAlignment(.center)
                        HStack {
                            Button("Retry") { model.retry() }.buttonStyle(.borderedProminent)
                            Button("Connection") { editingConnection = true }.buttonStyle(.bordered)
                        }
                        if model.endpoint != nil {
                            Button("Open in browser") { model.openInBrowser() }
                        }
                    }
                    .padding(24).frame(maxWidth: 420).glass(radius: 24).padding(20)
                }
                if model.isLoading && model.errorMessage == nil {
                    VStack {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Opening survey map").font(.subheadline)
                        }.padding(14).glass(radius: 22)
                        Spacer()
                    }.padding(.top, 12)
                }
            }
            .navigationTitle("Video")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { editingConnection = true } label: { Image(systemName: "network") }
                        .accessibilityLabel("Survey connection")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if model.isExporting { ProgressView().accessibilityLabel("Preparing export") }
                    Button { model.retry() } label: { Image(systemName: "arrow.clockwise") }
                        .disabled(model.endpoint == nil).accessibilityLabel("Reload survey")
                    Button { model.shareCurrentView() } label: { Image(systemName: "square.and.arrow.up") }
                        .disabled(model.endpoint == nil).accessibilityLabel("Share current survey view")
                }
            }
        }
        .task { model.startIfNeeded() }
        .onDisappear { model.pauseReplay() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { model.pauseReplay() }
        }
        .onChange(of: editingConnection) { _, editing in
            if editing { model.pauseReplay() }
        }
        .sheet(isPresented: $editingConnection) { SurveyConnectionSheet(model: model) }
        .sheet(item: $model.shareItem, onDismiss: { model.cleanExport() }) { item in
            SurveyShareSheet(items: item.items)
        }
        .sheet(item: $model.browserDestination) { destination in
            SurveyBrowser(url: destination.url).ignoresSafeArea()
        }
        .alert("Survey action", isPresented: Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })) {
            Button("OK", role: .cancel) { model.actionError = nil }
        } message: { Text(model.actionError ?? "") }
    }
}

@MainActor
private struct SurveyConnectionSheet: View {
    @ObservedObject var model: SurveyWebStore
    @State private var address = ""
    @State private var validationMessage: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Survey dashboard") {
                    TextField("https://your-server/gis/app/", text: $address)
                        .keyboardType(.URL).textContentType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("Survey dashboard address")
                    if let validationMessage { Text(validationMessage).foregroundStyle(.red) }
                    Text("Use the deployed website that serves the read-only GIS API. This address is stored on this device; no account or database password is needed.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Text("Video includes every drive route, zoomable observation clusters and captured frames. Select a drive to inspect photos or replay its route without closing the card. Shared links and CSV exports use the iOS share sheet. The map loads the version deployed at this address.")
                        .font(.subheadline)
                }
                if model.endpoint != nil {
                    Section {
                        Button("Disconnect survey dashboard", role: .destructive) {
                            model.disconnect(); dismiss()
                        }
                    }
                }
            }
            .navigationTitle("Survey connection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") {
                        do { try model.connect(address); dismiss() }
                        catch { validationMessage = error.localizedDescription }
                    }
                }
            }
        }
        .onAppear { address = model.savedAddress }
    }
}

@MainActor
private struct SurveyWebContainer: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

private struct SurveyShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

private struct SurveyBrowser: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

@MainActor
private final class SurveyWebStore: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    struct ShareItem: Identifiable { let id = UUID(); let items: [Any] }
    struct BrowserDestination: Identifiable { let id = UUID(); let url: URL }
    @Published private(set) var webView: WKWebView?
    @Published private(set) var endpoint: SurveyEndpoint?
    @Published private(set) var isLoading = false
    @Published private(set) var isExporting = false
    @Published private(set) var errorMessage: String?
    @Published var actionError: String?
    @Published var shareItem: ShareItem?
    @Published var browserDestination: BrowserDestination?
    private(set) var savedAddress: String
    private let preferenceKey = "geoai.surveyDashboardURL"
    private var loadTimeout: Task<Void, Never>?
    private var exportTask: Task<Void, Never>?
    private var exportFile: URL?
    private var generation = UUID()
    private let maximumExportBytes = 10 * 1024 * 1024

    private static var allowLoopbackHTTP: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    init(configuredURL: String) {
        self.savedAddress = UserDefaults.standard.string(forKey: "geoai.surveyDashboardURL") ?? configuredURL
        super.init()
    }

    func startIfNeeded() {
        guard webView == nil, !savedAddress.isEmpty else { return }
        do { try connect(savedAddress, persist: false) }
        catch { errorMessage = error.localizedDescription }
    }

    func connect(_ address: String, persist: Bool = true) throws {
        let destination = try SurveyEndpoint(address, allowLoopbackHTTP: Self.allowLoopbackHTTP)
        stop()
        savedAddress = destination.url.absoluteString
        if persist { UserDefaults.standard.set(savedAddress, forKey: preferenceKey) }
        endpoint = destination
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(WeakSurveyMessageHandler(self), name: "geoaiSurvey")
        configuration.userContentController.addUserScript(WKUserScript(source: Self.bridgeScript,
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        webView = view
        retry()
    }

    func retry() {
        guard let endpoint, let webView else { startIfNeeded(); return }
        generation = UUID()
        exportTask?.cancel(); exportTask = nil; isExporting = false
        errorMessage = nil
        isLoading = true
        let destination = webView.url.flatMap { endpoint.contains($0) ? $0 : nil } ?? endpoint.initialVideoURL
        // Revalidate the HTML when explicitly opening or reloading the survey.
        // Its versioned script/style URLs then pick up a newly deployed UI while
        // retained tabs keep their current map and replay state.
        webView.load(URLRequest(url: destination, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 45))
        beginLoadDeadline()
    }

    func disconnect() {
        stop()
        savedAddress = ""
        // Empty overrides a bundled address too, so a deliberate disconnect survives relaunch.
        UserDefaults.standard.set("", forKey: preferenceKey)
        endpoint = nil
        errorMessage = nil
    }

    private func stop() {
        generation = UUID()
        loadTimeout?.cancel(); loadTimeout = nil
        exportTask?.cancel(); exportTask = nil
        webView?.stopLoading()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "geoaiSurvey")
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView = nil
        isLoading = false
        isExporting = false
        cleanExport()
    }

    private func beginLoadDeadline() {
        loadTimeout?.cancel()
        loadTimeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(50)) } catch { return }
            guard let self, self.isLoading else { return }
            self.webView?.stopLoading()
            self.isLoading = false
            self.errorMessage = "The survey website is taking too long to respond. Your other app features are still available."
        }
    }

    func pauseReplay() {
        guard let endpoint, let webView, let url = webView.url, endpoint.contains(url) else { return }
        webView.evaluateJavaScript("document.dispatchEvent(new Event('geoai:app-pause'))", completionHandler: nil)
    }

    func shareCurrentView() {
        pauseReplay()
        guard let endpoint, let webView, let url = webView.url, endpoint.contains(url) else { return }
        // The current camera and filters live in the shared controller until a
        // link is generated. Reading WKWebView.url alone would share stale state.
        webView.evaluateJavaScript("Boolean(window.geoaiSurvey && (window.geoaiSurvey.share(), true))") { [weak self, weak webView] handled, error in
            guard let self, webView === self.webView else { return }
            if error != nil || (handled as? Bool) != true {
                self.shareItem = ShareItem(items: [url])
            }
        }
    }

    func openInBrowser() {
        guard let endpoint else { return }
        pauseReplay()
        browserDestination = BrowserDestination(url: endpoint.initialVideoURL)
    }

    func cleanExport() {
        if let exportFile { try? FileManager.default.removeItem(at: exportFile.deletingLastPathComponent()) }
        exportFile = nil
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        isLoading = true; errorMessage = nil; beginLoadDeadline()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        isLoading = false
        loadTimeout?.cancel()
        // Check the delivered document contract, not asynchronous map/API
        // readiness. Older pages can have Video but lack frames or clustering.
        webView.evaluateJavaScript(Self.capabilityScript) { [weak self, weak webView] result, error in
            guard let self, webView === self.webView else { return }
            if error != nil || (result as? Bool) != true {
                self.errorMessage = "This server has an older or incomplete survey dashboard. Publish the current GeoAI website at this address, then tap Retry to load the drive, photo and clustering update."
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(webView, error: error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(webView, error: error) }
    private func failed(_ webView: WKWebView, error: Error) {
        guard webView === self.webView, (error as NSError).code != NSURLErrorCancelled else { return }
        loadTimeout?.cancel(); isLoading = false
        errorMessage = "The survey dashboard could not load. Check your connection and dashboard address, then retry."
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        loadTimeout?.cancel(); isLoading = false
        errorMessage = "The survey map was paused by iOS. Reload it to continue."
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let endpoint, let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        // Subframes and scripted navigations cannot escape the configured service.
        if endpoint.contains(url) { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated, endpoint.canOpenInBrowser(url) {
            pauseReplay()
            browserDestination = BrowserDestination(url: url)
        } else if navigationAction.targetFrame?.isMainFrame != false {
            isLoading = false; loadTimeout?.cancel()
            errorMessage = "The dashboard redirected to another server. Check the configured survey address."
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let response = navigationResponse.response as? HTTPURLResponse,
           navigationResponse.isForMainFrame, response.statusCode >= 400 {
            errorMessage = "The server returned an error (\(response.statusCode)). Check the dashboard address or try again later."
            loadTimeout?.cancel(); isLoading = false
            decisionHandler(.cancel); return
        }
        let mime = navigationResponse.response.mimeType?.lowercased() ?? ""
        if mime == "text/csv" || mime == "application/csv" {
            if let url = navigationResponse.response.url { export(url: url, filename: "geoai-survey.csv") }
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let endpoint, let url = navigationAction.request.url, endpoint.canOpenInBrowser(url),
           navigationAction.navigationType == .linkActivated {
            pauseReplay()
            browserDestination = BrowserDestination(url: url)
        }
        return nil
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let endpoint, let origin = message.frameInfo.request.url, endpoint.contains(origin),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "exportTooLarge" {
            actionError = "This export is too large. Narrow the filters and try again."
        } else if type == "share", let raw = body["url"] as? String, let url = endpoint.resourceURL(raw) {
            pauseReplay()
            shareItem = ShareItem(items: [url])
        } else if type == "export" {
            let filename = body["filename"] as? String ?? "geoai-survey.csv"
            if let content = body["content"] as? String {
                let mime = body["mime"] as? String ?? "text/csv"
                guard mime.lowercased().hasPrefix("text/csv"), content.utf8.count <= maximumExportBytes else {
                    actionError = "This export is too large or has an unsupported format. Narrow the filters and try again."
                    return
                }
                presentExport(Data(content.utf8), filename: filename)
            } else if let raw = body["url"] as? String, let url = endpoint.resourceURL(raw) {
                export(url: url, filename: filename)
            } else {
                actionError = "The export address does not belong to the connected survey service."
            }
        }
    }

    private func export(url: URL, filename: String) {
        guard let endpoint, endpoint.contains(url), !isExporting else { return }
        let requestGeneration = generation
        isExporting = true
        exportTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.generation == requestGeneration { self.isExporting = false } }
            do {
                let data = try await SurveyCSVDownload.fetch(url: url, endpoint: endpoint, maximumBytes: self.maximumExportBytes)
                try Task.checkCancellation()
                guard self.generation == requestGeneration else { return }
                self.presentExport(data, filename: filename)
            } catch is CancellationError {} catch {
                if self.generation == requestGeneration {
                    self.actionError = "The CSV export could not be downloaded. Check your connection or use narrower filters, then retry."
                }
            }
        }
    }

    private func presentExport(_ data: Data, filename: String) {
        do {
            cleanExport()
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("geoai-survey-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let base = URL(fileURLWithPath: filename).lastPathComponent
            let safe = String(base.filter { $0.isLetter || $0.isNumber || "._-".contains($0) }.prefix(100))
            let name = safe.lowercased().hasSuffix(".csv") ? safe : "geoai-survey.csv"
            let destination = folder.appendingPathComponent(name)
            try data.write(to: destination, options: [.atomic, .completeFileProtection])
            exportFile = destination
            pauseReplay()
            shareItem = ShareItem(items: [destination])
        } catch { actionError = "The export could not be saved on this device. Please retry." }
    }

    private static let capabilityScript = """
    (() => {
      const revision = Number(document.querySelector('meta[name="geoai-survey-ui-version"]')?.content);
      const scripts = new Set(Array.from(document.scripts, script => {
        try { return new URL(script.src, document.baseURI).pathname.split('/').pop(); }
        catch (_) { return ''; }
      }));
      return Number.isSafeInteger(revision) && revision >= 20261030 &&
        Boolean(document.getElementById('videoToggle')) &&
        ['gis-core.js', 'video.js', 'survey.js', 'drive-player.js', 'drive-inspector.js'].every(name => scripts.has(name));
    })();
    """

    private static let bridgeScript = """
    (() => {
      for (const kind of ['share', 'export']) {
        document.addEventListener('geoai:' + kind, event => {
          const detail = event.detail;
          if (!detail || typeof detail !== 'object') return;
          if (typeof detail.content === 'string' && detail.content.length > 10485760) {
            window.webkit.messageHandlers.geoaiSurvey.postMessage({type: 'exportTooLarge'});
            if (event.cancelable) event.preventDefault();
            return;
          }
          window.webkit.messageHandlers.geoaiSurvey.postMessage({ ...detail, type: kind });
          if (event.cancelable) event.preventDefault();
        });
      }
    })();
    """
}

/// WKUserContentController retains its handlers; keep the store reference weak.
@MainActor
private final class WeakSurveyMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: SurveyWebStore?
    init(_ owner: SurveyWebStore) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.userContentController(userContentController, didReceive: message)
    }
}

private final class SurveyDownloadDelegate: NSObject, URLSessionTaskDelegate {
    let endpoint: SurveyEndpoint
    init(endpoint: SurveyEndpoint) { self.endpoint = endpoint }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url.map(endpoint.contains) == true ? request : nil)
    }
}

/// Runs outside the main actor so a large export cannot block map gestures.
private enum SurveyCSVDownload {
    static func fetch(url: URL, endpoint: SurveyEndpoint, maximumBytes: Int) async throws -> Data {
        let delegate = SurveyDownloadDelegate(endpoint: endpoint)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 90
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.setValue("text/csv", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let finalURL = response.url, endpoint.contains(finalURL),
              ["text/csv", "application/csv"].contains(response.mimeType?.lowercased() ?? ""),
              response.expectedContentLength <= Int64(maximumBytes) else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < maximumBytes else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        return data
    }
}
