import UIKit
import WebKit
import Network

@MainActor
final class WebController: UIViewController, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    let store: GalleryStore
    private var webView: WKWebView!
    private var loading: Task<Void, Error>?
    private var operation: Task<Void, Never>?
    private var listening: Task<Void, Never>?
    private var updating: Task<Void, Never>?
    private var foreground = true
    private var syncing: Task<Void, Never>?
    private var poller: Task<Void, Never>?
    private var knownGalleryCount = 0
    private let network = NWPathMonitor()


    init() {
        let root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/GalleryReader")
        let base = URL(string: Bundle.main.object(forInfoDictionaryKey: "GalleryServerURL") as? String ?? "https://192.168.1.197:7777")!
        store = GalleryStore(root: root, api: GalleryAPI(base: base, certificateURL: Bundle.main.url(forResource: "LocalCA", withExtension: "cer")))
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(LocalFiles(store: store), forURLScheme: "gallery")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "gallery")
        config.ignoresViewportScaleLimits = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view.backgroundColor = .black
        view.addSubview(webView)
        webView.load(URLRequest(url: URL(string: "gallery://app/")!))
        listening = Task { [weak self, store] in
            for await event in store.events {
                guard let self else { return }
                UIApplication.shared.isIdleTimerDisabled = foreground && event.busy
                scheduleUpdate()
                if event.library.galleries.count > knownGalleryCount {
                    knownGalleryCount = event.library.galleries.count
                    runDownload()
                }
            }
        }
        network.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.startAutomaticWork() }
        }
        network.start(queue: DispatchQueue(label: "GalleryReader.Network"))
        poller = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                self?.startAutomaticWork()
            }
        }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); webView.frame = view.bounds }
    private func ensureLoaded() async throws {
        if loading == nil { loading = Task { [store] in _ = try await store.load() } }
        try await loading?.value
    }
    private func scheduleUpdate() {
        guard updating == nil else { return }
        updating = Task { [weak self, store] in
            try? await Task.sleep(for: .milliseconds(100))
            guard let self else { return }
            let json = try? await store.webSnapshot(full: false)
            updating = nil
            if let json {
                webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('native-library', {detail: JSON.parse(json)}))",
                                            arguments: ["json": json], in: nil, in: .page, completionHandler: nil)
            }
        }
    }
    func pause() {
        foreground = false
        UIApplication.shared.isIdleTimerDisabled = false
        operation?.cancel()
        syncing?.cancel()
        Task { [store] in await store.cancelTransfers() }
    }
    func resume() {
        foreground = true
        startAutomaticWork()
    }
    private func startAutomaticWork() {
        guard foreground, loading != nil else { return }
        if syncing == nil {
            syncing = Task { [weak self, store] in
                do { try await store.refreshCatalog() } catch { /* Saved galleries stay usable offline. */ }
                self?.syncing = nil
                self?.runDownload()
            }
        }
        runDownload()
    }
    private func runDownload() {
        guard foreground, knownGalleryCount > 0, operation == nil else { return }
        operation = Task { [weak self, store] in
            guard let self else { return }
            do {
                try await self.ensureLoaded()
                try await store.downloadAll()
            } catch { /* Store publishes the error and retains completed files. */ }
            self.operation = nil
            if Task.isCancelled, self.foreground { self.runDownload() }
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "gallery",
              message.frameInfo.request.url?.host == "app",
              let body = message.body as? [String: Any], let command = body["command"] as? String else {
            replyHandler(nil, "Invalid native request"); return
        }
        let args = body["args"] as? [String: Any] ?? [:]
        let key = args["key"] as? String ?? ""
        let index = args["index"] as? Int ?? -1
        Task {
            do {
                try await ensureLoaded()
                switch command {
                case "init":
                    replyHandler(try await store.webSnapshot(), nil)
                    knownGalleryCount = await store.snapshot().galleries.count
                    startAutomaticWork()
                case "download": runDownload(); replyHandler("{}", nil)
                case "stop": pause(); replyHandler("{}", nil)
                case "describe", "open", "page", "thumbnail":
                    replyHandler(try await store.webReply(command, key: key, index: index), nil)
                default: replyHandler(nil, "Unknown native request")
                }
            } catch { replyHandler(nil, error.localizedDescription) }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url?.scheme == "gallery" && url?.host == "app" ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

// WebKit decodes/renders images in its web content process. The storage actor
// reads files; the main actor only delivers completed responses.
@MainActor
final class LocalFiles: NSObject, WKURLSchemeHandler {
    let store: GalleryStore
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    init(store: GalleryStore) { self.store = store }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        guard let url = urlSchemeTask.request.url else { return }
        tasks[id] = Task { [store, weak self] in
            do {
                let result = try await store.localResource(url)
                guard !Task.isCancelled else { return }
                let response = URLResponse(url: url, mimeType: result.mime, expectedContentLength: result.data.count, textEncodingName: result.mime.hasPrefix("text/") ? "utf-8" : nil)
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(result.data)
                urlSchemeTask.didFinish()
            } catch {
                if !Task.isCancelled { urlSchemeTask.didFailWithError(error) }
            }
            self?.tasks.removeValue(forKey: id)
        }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        tasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }
}
