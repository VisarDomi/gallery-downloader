import Network
import UIKit
import KitCore
import KitImages
import KitLifecycle
import KitNavigation
import KitTestHooks

extension Notification.Name {
    static let libraryChanged = Notification.Name("GalleryReader.libraryChanged")
}

// The app: the store and its automatic work (catalog sync, downloads, metadata warm-up),
// the screens' shared image pipeline and saved positions, and what happens when the app
// leaves the screen. Sync and downloads run while the app is in the foreground; a real trip
// to the background hands unfinished files to iOS (BackgroundDownloads) and pauses.
@MainActor
final class AppController {
    let store: GalleryStore
    let background: BackgroundDownloads
    let pipeline = ImagePipeline(memoryLimit: 256 << 20, concurrency: 6)
    private(set) var navigation: LiveNavigationController!
    private(set) var library = LibraryState()
    // Positions by view-state key, mirrored from view-state.json (the store writes it).
    private(set) var positions: [String: ViewPosition] = [:]

    private var loading: Task<Void, Error>?
    private var operation: Task<Void, Never>?
    private var syncing: Task<Void, Never>?
    private var warming: Task<Void, Never>?
    private var poller: Task<Void, Never>?
    private var listening: Task<Void, Never>?
    private var foreground = true
    private var ready = false
    private var knownGalleryCount = 0
    private let network = NWPathMonitor()
    private let launched = CACurrentMediaTime()

    init() {
        let root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/GalleryReader")
        let base = URL(string: Bundle.main.object(forInfoDictionaryKey: "GalleryServerURL") as? String ?? "https://192.168.1.197:7777")!
        let certificate = Bundle.main.url(forResource: "LocalCA", withExtension: "cer")
        store = GalleryStore(root: root, api: GalleryAPI(base: base, certificateURL: certificate))
        background = BackgroundDownloads(root: root, base: base, certificateURL: certificate)
        positions = Self.readViewState(root)?.positions ?? [:]
    }

    func makeNavigation() -> LiveNavigationController {
        let file = store.root.appendingPathComponent("navigation.json")
        migrateViewState(to: file)
        navigation = LiveNavigationController(file: file, factory: { [unowned self] route, state in screen(route, state: state) },
                                              root: LibraryScreen(app: self, page: 1, state: nil))
        observeLifecycle()
        start()
        #if targetEnvironment(simulator)
        TestHooks.shared.back = { [weak self] in _ = self?.navigation.popViewController(animated: true) }
        TestHooks.shared.forward = { [weak self] in self?.navigation.goForward() }
        TestHooks.shared.start()
        #endif
        DebugState.shared.register("pipeline") { [weak self] in self?.pipeline.state ?? [:] }
        DebugState.shared.register("navigation") { [weak self] in
            self?.navigation.screens.compactMap { try? JSONDecoder().decode(Route.self, from: $0.route).path } ?? []
        }
        DebugState.shared.register("library") { [weak self] in
            guard let self else { return [:] }
            return ["galleries": library.catalog.count, "running": library.running, "message": library.message]
        }
        return navigation
    }

    func screen(_ route: Data, state: Data?) -> (any LiveScreen)? {
        guard let route = try? JSONDecoder().decode(Route.self, from: route) else { return nil }
        switch route {
        case .library(let page): return LibraryScreen(app: self, page: page, state: state)
        case .reader(let key, let page): return ReaderScreen(app: self, key: key, page: page, state: state)
        }
    }

    // The first native launch rebuilds the stack the web version left: the saved library page
    // and, if a reader was open, that reader on top of it.
    private func migrateViewState(to file: URL) {
        guard !FileManager.default.fileExists(atPath: file.path), let state = Self.readViewState(store.root) else { return }
        let encoder = JSONEncoder()
        var back: [SavedStack.Entry] = []
        if let library = Route(path: state.libraryPath), let data = try? encoder.encode(library) { back.append(.init(route: data, state: nil)) }
        if let last = Route(path: state.lastPath), case .reader = last, let data = try? encoder.encode(last) { back.append(.init(route: data, state: nil)) }
        guard !back.isEmpty else { return }
        try? DurableFile.writeJSON(SavedStack(back: back), to: file)
    }

    private static func readViewState(_ root: URL) -> ViewState? {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("view-state.json")),
              let state = try? JSONDecoder().decode(ViewState.self, from: data), state.version == 1 else { return nil }
        return state
    }

    func position(for route: Route) -> ViewPosition? { positions[route.stateKey] }

    // Every strip offset any library position saved (the web version kept a set per page;
    // the continuous list keeps one).
    func allStripOffsets() -> [String: Double] {
        var result: [String: Double] = [:]
        for (key, position) in positions where key.hasPrefix("library:") && key != "library:1" { result.merge(position.strips) { $1 } }
        result.merge(positions["library:1"]?.strips ?? [:]) { $1 }
        return result
    }

    func savePosition(_ position: ViewPosition) {
        guard let route = ViewPosition.route(position.path) else { return }
        positions[route] = position
        Task { [store] in
            do { try await store.saveViewPosition(JSONEncoder().encode(position)) }
            catch { Log.store.error("Position not saved: \(error.localizedDescription, privacy: .public)") }
        }
    }

    // MARK: automatic work

    private func start() {
        listening = Task { [weak self, store] in
            for await event in store.events {
                guard let self else { return }
                UIApplication.shared.isIdleTimerDisabled = foreground && event.busy
                await refreshLibrary()
                if event.library.galleries.count > knownGalleryCount {
                    knownGalleryCount = event.library.galleries.count
                    runDownload()
                }
            }
        }
        Task {
            do { try await ensureLoaded() } catch { Log.store.error("Library did not open: \(error.localizedDescription, privacy: .public)") }
            knownGalleryCount = await store.galleryCount()
            await refreshLibrary()
            ready = true
            try? await store.recordStartup(["native_ui_ready_ms": (CACurrentMediaTime() - launched) * 1000])
            startAutomaticWork()
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

    // The store's answers, once it has opened (a screen rebuilt at launch asks right away).
    func gallery(_ key: String) async throws -> (manifest: GalleryManifest, state: DownloadState) {
        try await ensureLoaded()
        return try await store.gallery(key)
    }

    nonisolated func mediaFile(_ key: String, index: Int, thumbnail: Bool) async throws -> URL {
        try await ensureLoaded()
        return try await store.mediaFile(key, index: index, thumbnail: thumbnail)
    }

    func ensureLoaded() async throws {
        if loading == nil { loading = Task { [store] in try await store.load() } }
        try await loading?.value
    }

    private func refreshLibrary() async {
        library = await store.libraryState()
        NotificationCenter.default.post(name: .libraryChanged, object: self)
    }

    private func startAutomaticWork() {
        guard foreground, ready else { return }
        if syncing == nil {
            syncing = Task { [weak self, store] in
                do {
                    guard let self else { return }
                    try await ensureLoaded()
                    try Task.checkCancellation()
                    try await store.refreshCatalog()
                } catch { /* Saved galleries stay usable offline. */ }
                self?.syncing = nil
                self?.runDownload()
            }
        }
        if warming == nil {
            warming = Task(priority: .utility) { [weak self, store] in
                try? await self?.ensureLoaded()
                await store.warmRemaining()
                self?.warming = nil
            }
        }
        runDownload()
    }

    // The simulator syncs from the real PC: it saves only what is viewed, unless launched
    // with -downloads (the whole library would fill the Mac's disk).
    private var downloadsAllowed: Bool {
        #if targetEnvironment(simulator)
        ProcessInfo.processInfo.arguments.contains("-downloads")
        #else
        true
        #endif
    }

    private func runDownload() {
        guard foreground, ready, knownGalleryCount > 0, operation == nil, downloadsAllowed else { return }
        operation = Task { [weak self, store] in
            guard let self else { return }
            do {
                try await ensureLoaded()
                try await store.downloadAll()
            } catch { /* The store publishes the error and keeps completed files. */ }
            operation = nil
            if Task.isCancelled, foreground { runDownload() }
        }
    }

    // MARK: away from the screen

    private func observeLifecycle() {
        let lifecycle = AppLifecycle.shared
        // Leaving the screen at all (or just Control Center): save, and hand the unfinished
        // pages to iOS while still active.
        lifecycle.onResignActive { [weak self] in
            guard let self else { return }
            navigation.flush()
            DebugState.shared.write(to: store.root)
            guard downloadsAllowed else { return }
            let task = UIApplication.shared.beginBackgroundTask(withName: "Hand off downloads")
            Task { [store, background] in
                await background.handOff(await store.backgroundWork())
                UIApplication.shared.endBackgroundTask(task)
            }
        }
        lifecycle.onBackground { [weak self] in
            guard let self else { return }
            foreground = false
            UIApplication.shared.isIdleTimerDisabled = false
            operation?.cancel()
            syncing?.cancel()
            warming?.cancel()
            Task { [store] in await store.cancelTransfers() }
        }
        // Back on screen the app's own downloads take over again. Only a real trip to the
        // background stopped them; Control Center or Face ID leave everything running.
        lifecycle.onActive { [weak self] afterBackground in
            guard let self else { return }
            Task { [background] in await background.reclaim() }
            guard afterBackground, !foreground else { return }
            foreground = true
            startAutomaticWork()
        }
    }
}
