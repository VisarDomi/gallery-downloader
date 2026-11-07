import UIKit
import KitCore
import KitImages
import KitNavigation
import KitTestHooks

extension Notification.Name {
    static let libraryChanged = Notification.Name("GalleryReader.libraryChanged")
}

// Composition and routes only: the library owns transfers/content; positions and
// navigation own their complete checkpoint workflow.
@MainActor
final class AppController {
    let library: GalleryLibrary
    let positions: ViewPositions
    let pipeline = ImagePipeline(memoryLimit: 256 << 20, concurrency: 6)
    private(set) var navigation: LiveNavigationController!
    private let launched = CACurrentMediaTime()

    init() {
        let root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/GalleryReader")
        let base = URL(string: Bundle.main.object(forInfoDictionaryKey: "GalleryServerURL") as? String ?? "https://192.168.1.197:7777")!
        let certificate = Bundle.main.url(forResource: "LocalCA", withExtension: "cer")
        let store = GalleryStore(root: root, api: GalleryAPI(base: base, certificateURL: certificate))
        positions = ViewPositions(store: store)
        library = GalleryLibrary(store: store, background: BackgroundDownloads(root: root, base: base, certificateURL: certificate), pipeline: pipeline, launched: launched)
    }
    #if targetEnvironment(simulator)
    init(checkStore: GalleryStore) {
        positions = ViewPositions(store: checkStore)
        library = GalleryLibrary(store: checkStore, background: BackgroundDownloads(root: checkStore.root, base: URL(string: "https://127.0.0.1:9")!, certificateURL: nil), pipeline: pipeline, launched: launched)
    }
    #endif

    func makeNavigation() -> LiveNavigationController {
        pipeline.beginRestore()
        let file = library.root.appendingPathComponent("navigation.json")
        migrateViewState(to: file)
        navigation = LiveNavigationController(file: file, factory: { [unowned self] route, state in screen(route, state: state) },
            root: LibraryScreen(app: self, page: 1, state: nil), stateStore: positions)
        library.start()
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
            return ["galleries": library.snapshot.catalog.count, "running": library.snapshot.running, "message": library.snapshot.message]
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
    private func migrateViewState(to file: URL) {
        guard !FileManager.default.fileExists(atPath: file.path) else { return }
        let encoder = JSONEncoder()
        let back = positions.legacyRoutes.compactMap { route -> SavedStack.Entry? in
            guard let data = try? encoder.encode(route) else { return nil }
            return SavedStack.Entry(route: data, state: nil)
        }
        guard !back.isEmpty else { return }
        try? DurableFile.writeJSON(SavedStack(back: back), to: file)
    }
}
