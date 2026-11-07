#if targetEnvironment(simulator)
import UIKit
import KitCore
import KitLists
import KitNavigation
import KitTestHooks

@MainActor
final class GalleryRestorationChecks: UIViewController {
    private var app: AppController?
    private var nav: LiveNavigationController?
    private weak var host: UIWindow?
    private var started = false
    private var error = ""
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        TestHooks.shared.register("gallery-viewport-state") { [self] _ in state }
        TestHooks.shared.register("gallery-viewport-action") { [self] query in
            guard let nav else { return state }
            let table = find(UITableView.self, in: nav.topViewController!.view)
            switch query["kind"] {
            case "list-move":
                if let y = query["y"].flatMap(Double.init) { table?.contentOffset.y = CGFloat(y); table?.layoutIfNeeded() }
                if let x = query["x"].flatMap(Double.init), let cell = table?.visibleCells.first,
                   let strip = find(ThumbnailStripView.self, in: cell) { strip.collectionView.contentOffset.x = CGFloat(x) }
            case "open":
                if let list = nav.topViewController as? LibraryScreen, let row = table?.visibleCells.compactMap({ $0 as? GalleryRowCell }).first {
                    list.row(row, didSelectPage: 3)
                }
            case "move":
                (nav.topViewController as? ReaderScreen)?.checkViewport(y: query["y"].flatMap(Double.init), scale: query["scale"].flatMap(Double.init), x: query["x"].flatMap(Double.init))
            case "back": _ = nav.popViewController(animated: false)
            case "forward": nav.goForward(animated: false)
            default: break
            }
            return state
        }
        TestHooks.shared.start()
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }; started = true; host = view.window
        Task { do { try await prepare() } catch { self.error = String(describing: error) } }
    }
    private func find<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let found = view as? T { return found }
        return view.subviews.lazy.compactMap { self.find(type, in: $0) }.first
    }
    private var state: [String: Any] {
        guard let nav else { return ["ready": false, "error": error] }
        let top = nav.topViewController!, table = find(UITableView.self, in: top.view)
        let strips = (table?.visibleCells ?? []).compactMap { cell -> [String: Any]? in
            guard let row = cell as? GalleryRowCell, let id = row.item?.key, let strip = find(ThumbnailStripView.self, in: row) else { return nil }
            return ["key": id, "x": strip.collectionView.contentOffset.x]
        }
        return ["ready": nav.view.window != nil, "error": error, "screen": top is ReaderScreen ? "reader" : "list",
                "listY": table?.contentOffset.y ?? 0, "strips": strips,
                "reader": (top as? ReaderScreen)?.checkViewportState ?? [:],
                "saved": top.savedStateJSON, "forward": nav.canGoForward]
    }
    private func prepare() async throws {
        let root = URL.documentsDirectory.appendingPathComponent("gallery-viewport-fixture")
        if ProcessInfo.processInfo.arguments.contains("-reset-viewport-check") { try? FileManager.default.removeItem(at: root) }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 640), format: format).jpegData(withCompressionQuality: 0.9) { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 320, height: 640))
            for y in stride(from: 0, to: 640, by: 40) { UIColor.white.setFill(); context.fill(CGRect(x: 0, y: y, width: 320, height: 2)) }
        }
        let store = GalleryStore(root: root, api: GalleryRestoreSource(jpeg: jpeg))
        try await store.load()
        if !FileManager.default.fileExists(atPath: root.appendingPathComponent("fixture-ready").path) {
            try await store.refreshCatalog(); try await store.downloadAll(); try await store.flushProgress()
            try DurableFile.write(Data(), to: root.appendingPathComponent("fixture-ready"))
        }
        let app = AppController(checkStore: store); self.app = app
        let nav = app.makeNavigation(); self.nav = nav; host?.rootViewController = nav; nav.view.layoutIfNeeded()
    }
}

private extension UIViewController {
    var savedStateJSON: Any {
        guard let screen = self as? any LiveScreen, let data = screen.savedState() else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) ?? [:]
    }
}
private actor GalleryRestoreSource: GallerySource {
    let jpeg: Data
    init(jpeg: Data) { self.jpeg = jpeg }
    func catalog() -> Catalog {
        Catalog(version: 1, items: (1...12).map { GalleryItem(key: "hitomi-\($0)", provider: "hitomi", id: String($0), title: "Gallery \($0)", pages: 20, ready: true) })
    }
    func manifest(_ item: GalleryItem, urgent: Bool) -> GalleryManifest {
        func pages(_ kind: String) -> [MediaPage] {
            (0..<20).map { index in
                let name = "hitomi_\(item.id)_" + (kind == "thumbnails" ? "thumb_" : "") + "\(index+1).jpg"
                return MediaPage(name: name, size: Int64(jpeg.count), offset: Int64(index*jpeg.count),
                                 url: "/offline-api/hitomi/\(item.id)/\(kind)/\(name)", width: 320, height: 640)
            }
        }
        let bytes = Int64(jpeg.count * 20)
        return GalleryManifest(key: item.key, title: item.title, revision: String(repeating: "a", count: 24), pages: pages("pages"), bytes: bytes,
                               thumbnails: ThumbnailManifest(revision: String(repeating: "b", count: 24), pages: pages("thumbnails"), bytes: bytes), metadata: nil)
    }
    func download(_ page: MediaPage, urgent: Bool) throws -> URL {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".jpg")
        try jpeg.write(to: file); return file
    }
}
#endif
