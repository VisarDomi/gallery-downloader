import Network
import UIKit
import KitCore
import KitImages
import KitLifecycle

// The offline library owns startup, snapshots, image access, automatic work and
// foreground/background transfer ownership. Controllers do not drive its tasks.
@MainActor
final class GalleryLibrary {
    private let store: GalleryStore
    private let background: BackgroundDownloads
    private let pipeline: ImagePipeline
    private let launched: CFTimeInterval
    private(set) var snapshot = LibraryState()
    var root: URL { store.root }
    private var operation: Task<Void, Never>?
    private var syncing: Task<Void, Never>?
    private var warming: Task<Void, Never>?
    private var poller: Task<Void, Never>?
    private var listening: Task<Void, Never>?
    private var foreground = true
    private var transferOwnership = TransferOwnership()
    private enum Startup { case waiting, opening, ready }
    private var startup = Startup.waiting
    private var knownGalleryCount = 0
    private let network = NWPathMonitor()
    private var started = false

    init(store: GalleryStore, background: BackgroundDownloads, pipeline: ImagePipeline, launched: CFTimeInterval) {
        self.store = store; self.background = background; self.pipeline = pipeline; self.launched = launched
    }
    func handleBackgroundEvents(_ completion: @escaping () -> Void) { background.handleEvents(completion) }

    // MARK: automatic work

    func start() {
        guard !started else { return }; started = true
        observeLifecycle()
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
        startAutomaticWork()
        network.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.startAutomaticWork() }
        }
        network.start(queue: DispatchQueue(label: "GalleryReader.Network"))
        poller = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { return }
                self.startAutomaticWork()
            }
        }
    }

    // MARK: the phone's files at once (a relaunch's first frame; the store opens meanwhile)

    // The store has answered at least once (until then the screens show the saved catalog).
    private(set) var loaded = false

    private var manifests: [String: GalleryManifest] = [:]

    func catalogNow() -> [GalleryItem]? { store.catalogNow() }

    // Read from disk only while relaunching (the first frame needs it); otherwise only one
    // already in memory, as screens ask the store in the background.
    func manifestNow(_ key: String) -> GalleryManifest? {
        if let known = manifests[key] { return known }
        guard pipeline.isRestoring else { return nil }
        let manifest = store.manifestNow(key)
        if manifests.count > 200 { manifests.removeAll() }
        manifests[key] = manifest
        return manifest
    }

    func savedFile(_ key: String, index: Int, thumbnail: Bool) -> URL? {
        manifestNow(key).flatMap { GalleryStore.savedFile(root: store.root, manifest: $0, page: index, thumbnail: thumbnail) }
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
        try await store.load()
    }

    private func refreshLibrary() async {
        snapshot = await store.libraryState()
        loaded = true
        NotificationCenter.default.post(name: .libraryChanged, object: self)
    }

    private func startAutomaticWork() {
        guard foreground else { return }
        guard startup == .ready else {
            guard startup == .waiting else { return }
            startup = .opening
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await ensureLoaded()
                    knownGalleryCount = await store.galleryCount()
                    await refreshLibrary()
                    startup = .ready
                    try? await store.recordStartup(["native_ui_ready_ms": (CACurrentMediaTime() - launched) * 1000])
                    startAutomaticWork()
                } catch {
                    startup = .waiting
                    Log.store.error("Library did not open: \(error.localizedDescription, privacy: .public)")
                }
            }
            return
        }
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
        guard foreground, startup == .ready, knownGalleryCount > 0, operation == nil, downloadsAllowed else { return }
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
            DebugState.shared.write(to: store.root)
            guard downloadsAllowed else { return }
            let ticket = transferOwnership.handOff()
            let task = UIApplication.shared.beginBackgroundTask(withName: "Hand off downloads")
            Task { [self, store, background] in
                defer { UIApplication.shared.endBackgroundTask(task) }
                let items = await store.backgroundWork()
                guard transferOwnership.ownsHandoff(ticket) else { return }
                await background.handOff(items)
                transferOwnership.handedOff(ticket)
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
            let ticket = transferOwnership.reclaim()
            Task { [self, background] in
                await background.reclaim()
                guard transferOwnership.reclaimed(ticket) else { return }
                if afterBackground || !foreground {
                    foreground = true
                    startAutomaticWork()
                }
            }
        }
    }
}
