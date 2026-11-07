import UIKit
import KitCore
import KitImages
import KitNavigation
import KitReader

// A gallery's pages, full width on black with half a screen above the first and below the
// last, zoomed and panned as Safari zooms a page. Opened from a thumbnail, the tapped page's
// top sits at the screen's middle; reopened at the page it was left on, it returns exactly
// there. A page not saved yet downloads at once, ahead of everything else.
@MainActor
final class ReaderScreen: UIViewController, LiveScreen, StripReaderDelegate {
    private let app: AppController
    private let key: String
    private var page: Int
    private let strip: StripReaderView
    private let message = UILabel()
    private var initial: StripPosition
    private var observer: NSObjectProtocol?
    private var total = 0

    init(app: AppController, key: String, page: Int, state: Data?) {
        self.app = app
        self.key = key
        self.page = max(1, page)
        strip = StripReaderView(pipeline: app.pipeline)
        // Exact place when this is the page the reader was left on; otherwise the page's top.
        if let saved = state.flatMap({ try? JSONDecoder().decode(StripPosition.self, from: $0) }) {
            initial = saved
        } else if let saved = app.positions.position(for: .reader(key: key, page: page)), saved.path == Route.reader(key: key, page: page).path,
                  let index = saved.page {
            initial = StripPosition(index: index, fraction: saved.fraction, zoom: saved.zoom, aspect: saved.aspect, point: saved.point)
        } else {
            initial = StripPosition(index: page - 1, fraction: 0)
        }
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    var route: Data { (try? JSONEncoder().encode(Route.reader(key: key, page: page))) ?? Data() }
    func savedState() -> Data? { try? JSONEncoder().encode(strip.savedPosition ?? initial) }

    func captureState() {
        guard isViewLoaded, let position = strip.currentPosition else { return }
        savePosition(position)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        strip.delegate = self
        view.addSubview(strip)
        message.textColor = UIColor(white: 0.73, alpha: 1)
        message.font = .systemFont(ofSize: 16)
        message.numberOfLines = 0
        message.text = "Opening saved pages…"
        view.addSubview(message)
        observer = NotificationCenter.default.addObserver(forName: .libraryChanged, object: app.library, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateMessage() }
        }
        DebugState.shared.register("reader") { [weak self] in self?.strip.state ?? [:] }
        open()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        strip.frame = view.bounds
        let insets = view.safeAreaInsets
        let size = message.sizeThatFits(CGSize(width: view.bounds.width - 16 - insets.left - insets.right, height: .greatestFiniteMagnitude))
        message.frame = CGRect(x: 8 + insets.left, y: 8 + insets.top, width: size.width, height: size.height)
    }

    private func open() {
        // The saved manifest at once: a relaunch shows the pages (and how many are saved) in its
        // first frame; the store's answer follows.
        if let manifest = app.library.manifestNow(key) {
            show(manifest)
            show(downloaded: manifest.pages.indices.filter { app.library.savedFile(key, index: $0, thumbnail: false) != nil }.count)
        }
        Task { [weak self, app, key] in
            do {
                let (manifest, state) = try await app.library.gallery(key)
                guard let self else { return }
                if total == 0 { show(manifest) }
                show(downloaded: state.downloaded)
            } catch {
                self?.message.text = error.localizedDescription
                self?.view.setNeedsLayout()
            }
        }
    }

    private func show(_ manifest: GalleryManifest) {
        total = manifest.pages.count
        let pages = manifest.pages.enumerated().map { index, page in
            StripPage(key: "\(key)/page/\(index)",
                      aspect: (page.width ?? 0) > 0 && (page.height ?? 0) > 0 ? CGFloat(page.width! / page.height!) : nil)
        }
        strip.setPages(pages, position: StripPosition(index: min(max(0, initial.index), max(0, pages.count - 1)), fraction: initial.fraction, zoom: initial.zoom, aspect: initial.aspect, point: initial.point))
    }

    private func updateMessage() {
        guard total > 0, let state = app.library.snapshot.originals[key] else { return }
        show(downloaded: state.downloaded)
    }

    private func show(downloaded: Int) {
        message.text = downloaded >= total ? nil : "\(downloaded)/\(total) pages saved"
        message.isHidden = message.text == nil
        view.setNeedsLayout()
    }

    // MARK: strip

    func strip(_ strip: StripReaderView, sourceFor index: Int) -> ImageSource {
        let key = key, app = app
        return .load { try await app.library.mediaFile(key, index: index, thumbnail: false) }
    }

    func strip(_ strip: StripReaderView, localFileFor index: Int) -> URL? { app.library.savedFile(key, index: index, thumbnail: false) }

    #if targetEnvironment(simulator)
    var checkViewportState: [String: Any] { strip.state }
    func checkViewport(y: Double?, scale: Double?, x: Double?) {
        strip.scrollViewWillBeginDragging(strip.testScrollView)
        if let scale { strip.testScrollView.setZoomScale(CGFloat(scale), animated: false) }
        if let x { strip.testScrollView.contentOffset.x = CGFloat(x) }
        if let y { strip.testScrollView.contentOffset.y = CGFloat(y) }
        strip.scrollViewDidScroll(strip.testScrollView)
    }
    #endif

    func strip(_ strip: StripReaderView, settledAt position: StripPosition) {
        savePosition(position)
        stateChanged()
    }

    private func savePosition(_ position: StripPosition) {
        page = position.index + 1
        app.positions.save(ViewPosition(path: Route.reader(key: key, page: page).path, anchor: nil, page: position.index,
                                      fraction: position.fraction, y: 0, strips: [:], zoom: position.zoom, aspect: position.aspect, point: position.point))
    }

    func strip(_ strip: StripReaderView, failureTextFor index: Int, error: Error) -> String? {
        "Page \(index + 1): Saved image could not be loaded."
    }

    // A zoomed page pans to the left edge instead of going back.
    var allowsEdgeBack: Bool { !strip.isZoomed }
}
