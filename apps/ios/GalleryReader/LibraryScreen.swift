import UIKit
import KitCore
import KitImages
import KitLists
import KitNavigation

// A library page: 25 favorites in catalog order, each a row with a sideways strip of every
// page's thumbnail (100×300 covers) and an "i" button, then the page numbers, then the
// count and the store's status line. A thumbnail opens the reader at its page; a page number
// replaces the rows in place and starts at the first row (as in Hitomi and Imhen); "Favs"
// opens page 1 as a new screen. The page remembers the row at the screen's middle, how far
// down it, and every strip's sideways offset.
@MainActor
final class LibraryScreen: UIViewController, LiveScreen, UIScrollViewDelegate, GalleryRowDelegate {
    struct State: Codable {
        var anchor: ScrollAnchor?
        var strips: [String: Double]
    }

    static let pageSize = 25
    private let app: AppController
    private var page: Int
    private let scrollView = UIScrollView()
    private let pagination = PaginationBar()
    private let countLabel = UILabel()
    private let statusLabel = UILabel()
    private var rows: [GalleryRowView] = []
    private var strips: [String: Double] = [:]
    private var pendingAnchor: ScrollAnchor?
    private var restored = false
    private var observer: NSObjectProtocol?
    private var rowsSignature: [String] = []

    init(app: AppController, page: Int, state: Data?) {
        self.app = app
        self.page = max(1, page)
        super.init(nibName: nil, bundle: nil)
        let saved = state.flatMap { try? JSONDecoder().decode(State.self, from: $0) }
        let position = app.position(for: .library(page: self.page))
        pendingAnchor = saved?.anchor ?? position?.anchor.map { ScrollAnchor(key: $0, fraction: position?.fraction ?? 0) }
        strips = saved?.strips ?? position?.strips ?? [:]
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    var route: Data { (try? JSONEncoder().encode(Route.library(page: page))) ?? Data() }

    func savedState() -> Data? { try? JSONEncoder().encode(State(anchor: currentAnchor, strips: currentStrips)) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        scrollView.delegate = self
        scrollView.backgroundColor = .black
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.showsVerticalScrollIndicator = false
        scrollView.alwaysBounceVertical = true
        view.addSubview(scrollView)
        pagination.onPage = { [weak self] page in self?.show(page: page) }
        pagination.onFavorites = { [weak self] in
            guard let self else { return }
            saveNow()
            liveNavigation?.open(LibraryScreen(app: app, page: 1, state: nil))
        }
        scrollView.addSubview(pagination)
        for label in [countLabel, statusLabel] {
            label.textColor = UIColor(white: 0.53, alpha: 1)
            label.numberOfLines = 0
            scrollView.addSubview(label)
        }
        countLabel.font = .systemFont(ofSize: 16)
        statusLabel.font = .systemFont(ofSize: 14)
        statusLabel.textColor = UIColor(white: 0.67, alpha: 1)
        observer = NotificationCenter.default.addObserver(forName: .libraryChanged, object: app, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.libraryChanged() }
        }
        libraryChanged()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let anchor = restored ? currentAnchor : nil
        scrollView.frame = view.bounds
        layoutRows()
        if let anchor { restore(anchor) }
        restoreIfReady()
    }

    // MARK: rows

    private var items: ArraySlice<GalleryItem> {
        let catalog = app.library.catalog
        let pages = max(1, Int(ceil(Double(catalog.count) / Double(Self.pageSize))))
        let current = min(page, pages)
        return catalog[min(catalog.count, (current - 1) * Self.pageSize)..<min(catalog.count, current * Self.pageSize)]
    }

    // A later catalog keeps the rows it still has (with their loaded thumbnails) and the
    // place on screen.
    private func libraryChanged() {
        let library = app.library
        countLabel.text = "\(library.catalog.count) Favorites"
        statusLabel.text = library.message
        let pages = max(1, Int(ceil(Double(library.catalog.count) / Double(Self.pageSize))))
        pagination.set(page: min(page, pages), of: pages)
        let signature = items.map { "\($0.key)\u{1F}\($0.title)" }
        if signature != rowsSignature {
            let anchor = restored ? currentAnchor : nil
            let previous = Dictionary(rows.map { ($0.item.key, $0) }, uniquingKeysWith: { first, _ in first })
            rows = items.map { item in
                if let row = previous[item.key], row.item.title == item.title { row.item = item; return row }
                let row = GalleryRowView(item: item, app: app)
                row.delegate = self
                return row
            }
            for row in previous.values where !rows.contains(where: { $0 === row }) { row.discard() }
            rows.forEach { if $0.superview !== scrollView { scrollView.addSubview($0) } }
            rowsSignature = signature
            layoutRows()
            if let anchor { restore(anchor) }
            populateRows()
        }
        rows.forEach { $0.libraryChanged() }
        layoutRows()
        restoreIfReady()
    }

    // Rows nearest the screen's middle describe their galleries first.
    private func populateRows() {
        let middle = scrollView.contentOffset.y + scrollView.bounds.height / 2
        for row in rows.sorted(by: { abs($0.frame.midY - middle) < abs($1.frame.midY - middle) }) {
            row.populate(offset: strips[row.item.key].map { CGFloat($0) })
        }
    }

    private func layoutRows() {
        let width = view.bounds.width
        var y: CGFloat = 0
        for row in rows {
            row.frame = CGRect(x: 0, y: y, width: width, height: GalleryRowView.height)
            y += GalleryRowView.height
        }
        let paginationHeight = pagination.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        pagination.frame = CGRect(x: 0, y: y, width: width, height: paginationHeight)
        y += paginationHeight
        let insets = view.safeAreaInsets
        let footerWidth = width - max(4, insets.left) - max(4, insets.right)
        let countHeight = countLabel.sizeThatFits(CGSize(width: footerWidth, height: .greatestFiniteMagnitude)).height
        countLabel.frame = CGRect(x: max(4, insets.left), y: y + 8, width: footerWidth, height: max(44, countHeight))
        y = countLabel.frame.maxY
        let statusHeight = statusLabel.sizeThatFits(CGSize(width: footerWidth, height: .greatestFiniteMagnitude)).height
        statusLabel.frame = CGRect(x: max(4, insets.left), y: y + 4, width: footerWidth, height: statusHeight)
        y = statusLabel.frame.maxY + max(8, insets.bottom)
        scrollView.contentSize = CGSize(width: width, height: y)
    }

    // MARK: position

    private var currentAnchor: ScrollAnchor? {
        ScrollAnchoring.anchor(in: scrollView, items: rows.map { ($0.item.key, $0.frame) })
    }

    private var currentStrips: [String: Double] {
        var result = strips
        for row in rows where row.isPopulated { result[row.item.key] = Double(row.stripOffset) }
        return result
    }

    private func restore(_ anchor: ScrollAnchor) {
        ScrollAnchoring.restore(anchor, in: scrollView, frame: rows.first { $0.item.key == anchor.key }?.frame)
    }

    // The saved place, once its row exists (the catalog may arrive after the screen).
    private func restoreIfReady() {
        guard !restored, view.bounds.width > 0, !rows.isEmpty else { return }
        if let anchor = pendingAnchor {
            guard rows.contains(where: { $0.item.key == anchor.key }) else {
                if !app.library.catalog.isEmpty { restored = true; pendingAnchor = nil }
                return
            }
            restore(anchor)
        }
        pendingAnchor = nil
        restored = true
        populateRows()
    }

    private func saveNow() {
        guard restored else { return }
        let anchor = currentAnchor
        strips = currentStrips
        app.savePosition(ViewPosition(path: Route.library(page: page).path, anchor: anchor?.key, page: nil,
                                      fraction: anchor?.fraction ?? 0, y: Double(max(0, scrollView.contentOffset.y)),
                                      strips: strips))
        stateChanged()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { app.pipeline.prioritiesChanged() }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { if !decelerate { saveNow() } }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { saveNow() }

    // A page number: the rows change in place (no new screen) and the first row is at the top.
    private func show(page newPage: Int) {
        page = newPage
        rowsSignature = []
        strips = app.position(for: .library(page: newPage))?.strips ?? [:]
        libraryChanged()
        scrollView.contentOffset = .zero
        restored = true
        saveNow()
    }

    // MARK: rows' actions

    func row(_ row: GalleryRowView, didSelectPage index: Int) {
        saveNow()
        liveNavigation?.open(ReaderScreen(app: app, key: row.item.key, page: index + 1, state: nil))
    }

    func rowWantsInfo(_ row: GalleryRowView) {
        present(InfoSheet(app: app, item: row.item, details: row.manifest), animated: true)
    }

    func rowStripSettled(_ row: GalleryRowView) { saveNow() }
}

@MainActor
protocol GalleryRowDelegate: AnyObject {
    func row(_ row: GalleryRowView, didSelectPage index: Int)
    func rowWantsInfo(_ row: GalleryRowView)
    func rowStripSettled(_ row: GalleryRowView)
}

// One favorite: its title (until the strip is ready, or with the error that stopped it),
// the strip of thumbnails, and the "i" button at the bottom right.
@MainActor
final class GalleryRowView: UIView, ThumbnailStripDelegate {
    static let height: CGFloat = 300
    var item: GalleryItem
    weak var delegate: GalleryRowDelegate?
    private(set) var manifest: GalleryManifest?
    private let app: AppController
    private let strip: ThumbnailStripView
    private let message = UILabel()
    private let info = UIButton(type: .system)
    private var populating: Task<Void, Never>?
    private var failed = false

    init(item: GalleryItem, app: AppController) {
        self.item = item
        self.app = app
        strip = ThumbnailStripView(pipeline: app.pipeline)
        super.init(frame: .zero)
        backgroundColor = .black
        strip.delegate = self
        strip.isHidden = true
        addSubview(strip)
        message.textColor = UIColor(white: 0.53, alpha: 1)
        message.numberOfLines = 0
        message.font = .systemFont(ofSize: 16)
        message.text = item.title
        addSubview(message)
        info.setTitle("i", for: .normal)
        info.titleLabel?.font = UIFont(name: "Georgia-Italic", size: 22) ?? .italicSystemFont(ofSize: 22)
        info.tintColor = .white
        info.accessibilityLabel = "Information: \(item.title)"
        info.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            delegate?.rowWantsInfo(self)
        }, for: .touchUpInside)
        addSubview(info)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    var isPopulated: Bool { manifest != nil }
    var stripOffset: CGFloat { strip.offset }

    override func layoutSubviews() {
        super.layoutSubviews()
        strip.frame = CGRect(x: 0, y: 0, width: bounds.width, height: Self.height)
        message.frame = CGRect(x: 8, y: 12, width: bounds.width - 68, height: 0)
        message.sizeToFit()
        info.frame = CGRect(x: bounds.width - 54, y: bounds.height - 54, width: 44, height: 44)
    }

    func populate(offset: CGFloat?) {
        guard manifest == nil, populating == nil else { return }
        failed = false
        let key = item.key
        populating = Task { [weak self, app] in
            do {
                let (manifest, _) = try await app.gallery(key)
                guard let self else { return }
                populating = nil
                self.manifest = manifest
                strip.setKeys((0..<manifest.pages.count).map { "\(key)/thumbnail/\($0)" }, offset: offset ?? 0)
                strip.isHidden = false
                message.isHidden = true
            } catch {
                guard let self else { return }
                populating = nil
                failed = true
                message.text = "\(item.title) · \(error.localizedDescription)"
                setNeedsLayout()
            }
        }
    }

    // New downloads: thumbnails that were missing are asked again; a failed row tries again.
    func libraryChanged() {
        if manifest != nil { strip.reloadMissing() }
        else if failed { populate(offset: nil) }
    }

    func discard() {
        populating?.cancel()
        strip.cancelAll()
        removeFromSuperview()
    }

    func strip(_ strip: ThumbnailStripView, sourceFor index: Int) -> ImageSource {
        let key = item.key, app = app
        return .load { try await app.mediaFile(key, index: index, thumbnail: true) }
    }

    func strip(_ strip: ThumbnailStripView, didSelect index: Int) { delegate?.row(self, didSelectPage: index) }
    func stripDidSettle(_ strip: ThumbnailStripView) { delegate?.rowStripSettled(self) }
}
