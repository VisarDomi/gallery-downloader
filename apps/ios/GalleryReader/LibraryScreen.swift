import UIKit
import KitCore
import KitImages
import KitLists
import KitNavigation

// The library: every favorite in catalog order, one continuous list (the web version's 25-row
// pages only kept WebKit's documents small), each a row with a sideways strip of every page's
// thumbnail (100×300 covers) and an "i" button; at the end the count and the store's status
// line. Drag the scroll indicator to jump. A thumbnail opens the reader at its page. The list
// remembers the row at the screen's middle, how far down it, and every strip's sideways offset.
@MainActor
final class LibraryScreen: UIViewController, LiveScreen, UITableViewDataSource, UITableViewDelegate,
                           UITableViewDataSourcePrefetching, GalleryRowDelegate {
    struct State: Codable {
        var anchor: ScrollAnchor?
        var strips: [String: Double]
    }

    private let app: AppController
    private let table = UITableView(frame: .zero, style: .plain)
    private let footer = UIView()
    private let countLabel = UILabel()
    private let statusLabel = UILabel()
    private var catalog: [GalleryItem] = []
    private var signature: [String] = []
    // Each gallery's page count once described (a strip has one thumbnail per page).
    private var pages: [String: Int] = [:]
    private var failures: [String: String] = [:]
    private var describing = Set<String>()
    private var strips: [String: Double]
    private var pendingAnchor: ScrollAnchor?
    private var restored = false
    private var observer: NSObjectProtocol?

    // `page`: the web version's library page this screen was saved on (its place carries over).
    init(app: AppController, page: Int = 1, state: Data?) {
        self.app = app
        let saved = state.flatMap { try? JSONDecoder().decode(State.self, from: $0) }
        let position = app.position(for: .library(page: 1)) ?? app.position(for: .library(page: page))
        pendingAnchor = saved?.anchor ?? position?.anchor.map { ScrollAnchor(key: $0, fraction: position?.fraction ?? 0) }
        strips = saved?.strips ?? app.allStripOffsets()
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    var route: Data { (try? JSONEncoder().encode(Route.library(page: 1))) ?? Data() }
    func savedState() -> Data? { try? JSONEncoder().encode(State(anchor: currentAnchor, strips: strips)) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        table.backgroundColor = .black
        table.separatorStyle = .none
        table.rowHeight = GalleryRowCell.height
        table.estimatedRowHeight = GalleryRowCell.height
        table.contentInsetAdjustmentBehavior = .never
        table.showsVerticalScrollIndicator = true
        table.indicatorStyle = .white
        table.dataSource = self
        table.delegate = self
        table.prefetchDataSource = self
        table.register(GalleryRowCell.self, forCellReuseIdentifier: "row")
        view.addSubview(table)
        for label in [countLabel, statusLabel] {
            label.numberOfLines = 0
            footer.addSubview(label)
        }
        countLabel.font = .systemFont(ofSize: 16)
        countLabel.textColor = UIColor(white: 0.53, alpha: 1)
        statusLabel.font = .systemFont(ofSize: 14)
        statusLabel.textColor = UIColor(white: 0.67, alpha: 1)
        observer = NotificationCenter.default.addObserver(forName: .libraryChanged, object: app, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.libraryChanged() }
        }
        DebugState.shared.register("libraryScreen") { [weak self] in
            guard let self else { return [:] }
            return ["rows": catalog.count, "anchor": currentAnchor.map { ["key": $0.key, "fraction": $0.fraction] } ?? [:],
                    "offset": table.contentOffset.y, "described": pages.count]
        }
        libraryChanged()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let anchor = restored ? currentAnchor : nil
        let widthChanged = table.frame.width != view.bounds.width
        table.frame = view.bounds
        layoutFooter()
        if widthChanged, let anchor { restore(anchor) }
        restoreIfReady()
    }

    // MARK: catalog

    // A later catalog keeps the place on screen (the row at the middle stays put).
    private func libraryChanged() {
        let library = app.library
        countLabel.text = "\(library.catalog.count) Favorites"
        statusLabel.text = library.message
        layoutFooter()
        let next = library.catalog.map { "\($0.key)\u{1F}\($0.title)" }
        if next != signature {
            let anchor = restored ? currentAnchor : nil
            catalog = library.catalog
            signature = next
            table.reloadData()
            table.layoutIfNeeded()
            if let anchor { restore(anchor) }
        } else {
            // New downloads: thumbnails that were missing are asked again; failed rows retry.
            for cell in table.visibleCells.compactMap({ $0 as? GalleryRowCell }) { cell.reloadMissing() }
            for key in failures.keys { failures[key] = nil; describe(key) }
        }
        restoreIfReady()
    }

    private func layoutFooter() {
        let width = view.bounds.width, insets = view.safeAreaInsets
        let inner = width - max(4, insets.left) - max(4, insets.right)
        let count = countLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height
        let status = statusLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height
        countLabel.frame = CGRect(x: max(4, insets.left), y: 8, width: inner, height: max(44, count))
        statusLabel.frame = CGRect(x: max(4, insets.left), y: countLabel.frame.maxY + 4, width: inner, height: status)
        let height = statusLabel.frame.maxY + max(8, insets.bottom)
        if footer.frame.size != CGSize(width: width, height: height) {
            footer.frame = CGRect(x: 0, y: 0, width: width, height: height)
            table.tableFooterView = footer
        }
    }

    // A gallery's page count, nearest rows first (the store answers visible requests first).
    private func describe(_ key: String) {
        guard pages[key] == nil, !describing.contains(key) else { return }
        describing.insert(key)
        Task { [weak self, app] in
            do {
                let (manifest, _) = try await app.gallery(key)
                guard let self else { return }
                describing.remove(key)
                pages[key] = manifest.pages.count
                failures[key] = nil
            } catch {
                guard let self else { return }
                describing.remove(key)
                failures[key] = error.localizedDescription
            }
            self?.refreshRow(key)
        }
    }

    private func refreshRow(_ key: String) {
        guard let row = catalog.firstIndex(where: { $0.key == key }),
              let cell = table.cellForRow(at: IndexPath(row: row, section: 0)) as? GalleryRowCell else { return }
        configure(cell, row: row)
    }

    private func configure(_ cell: GalleryRowCell, row: Int) {
        let item = catalog[row]
        cell.configure(item: item, pages: pages[item.key], failure: failures[item.key], offset: CGFloat(strips[item.key] ?? 0),
                       app: app, delegate: self)
        if pages[item.key] == nil && failures[item.key] == nil { describe(item.key) }
    }

    // MARK: table

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { catalog.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath) as! GalleryRowCell
        configure(cell, row: indexPath.row)
        return cell
    }

    func tableView(_ tableView: UITableView, prefetchRowsAt indexPaths: [IndexPath]) {
        for path in indexPaths where catalog.indices.contains(path.row) { describe(catalog[path.row].key) }
    }

    func tableView(_ tableView: UITableView, didEndDisplaying cell: UITableViewCell, forRowAt indexPath: IndexPath) {
        guard let cell = cell as? GalleryRowCell, let key = cell.item?.key, cell.isPopulated else { return }
        strips[key] = Double(cell.stripOffset)
    }

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool { false }

    // MARK: position

    private var currentAnchor: ScrollAnchor? {
        guard let paths = table.indexPathsForVisibleRows, !paths.isEmpty else { return nil }
        return ScrollAnchoring.anchor(in: table, items: paths.filter { catalog.indices.contains($0.row) }
            .map { (catalog[$0.row].key, table.rectForRow(at: $0)) })
    }

    private func restore(_ anchor: ScrollAnchor) {
        guard let row = catalog.firstIndex(where: { $0.key == anchor.key }) else { return }
        ScrollAnchoring.restore(anchor, in: table, frame: table.rectForRow(at: IndexPath(row: row, section: 0)))
    }

    // The saved place, once its row exists (the catalog may arrive after the screen).
    private func restoreIfReady() {
        // Only once the table has its frame (a restore before layout lands too low).
        guard !restored, table.bounds.height > 0, !catalog.isEmpty else { return }
        if let anchor = pendingAnchor {
            guard catalog.contains(where: { $0.key == anchor.key }) else { restored = true; pendingAnchor = nil; return }
            table.layoutIfNeeded()
            restore(anchor)
        }
        pendingAnchor = nil
        restored = true
    }

    private func saveNow() {
        guard restored else { return }
        for cell in table.visibleCells.compactMap({ $0 as? GalleryRowCell }) where cell.isPopulated {
            if let key = cell.item?.key { strips[key] = Double(cell.stripOffset) }
        }
        let anchor = currentAnchor
        app.savePosition(ViewPosition(path: Route.library(page: 1).path, anchor: anchor?.key, page: nil,
                                      fraction: anchor?.fraction ?? 0, y: Double(max(0, table.contentOffset.y)),
                                      strips: strips))
        stateChanged()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { app.pipeline.prioritiesChanged() }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { if !decelerate { saveNow() } }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { saveNow() }

    // MARK: rows' actions

    func row(_ row: GalleryRowCell, didSelectPage index: Int) {
        guard let item = row.item else { return }
        saveNow()
        liveNavigation?.open(ReaderScreen(app: app, key: item.key, page: index + 1, state: nil))
    }

    func rowWantsInfo(_ row: GalleryRowCell) {
        guard let item = row.item else { return }
        present(InfoSheet(app: app, item: item, details: nil), animated: true)
    }

    func rowStripSettled(_ row: GalleryRowCell) { saveNow() }
}

@MainActor
protocol GalleryRowDelegate: AnyObject {
    func row(_ row: GalleryRowCell, didSelectPage index: Int)
    func rowWantsInfo(_ row: GalleryRowCell)
    func rowStripSettled(_ row: GalleryRowCell)
}

// One favorite: its title (until the strip is ready, or with the error that stopped it), the
// strip of thumbnails, and the "i" button at the bottom right.
@MainActor
final class GalleryRowCell: UITableViewCell, ThumbnailStripDelegate {
    static let height: CGFloat = 300
    private(set) var item: GalleryItem?
    private weak var delegate: GalleryRowDelegate?
    private var app: AppController?
    private var strip: ThumbnailStripView?
    private let message = UILabel()
    private let info = UIButton(type: .system)

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .black
        contentView.backgroundColor = .black
        selectionStyle = .none
        message.textColor = UIColor(white: 0.53, alpha: 1)
        message.numberOfLines = 0
        message.font = .systemFont(ofSize: 16)
        contentView.addSubview(message)
        info.setTitle("i", for: .normal)
        info.titleLabel?.font = UIFont(name: "Georgia-Italic", size: 22) ?? .italicSystemFont(ofSize: 22)
        info.tintColor = .white
        info.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            delegate?.rowWantsInfo(self)
        }, for: .touchUpInside)
        contentView.addSubview(info)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    var isPopulated: Bool { !(strip?.isHidden ?? true) }
    var stripOffset: CGFloat { strip?.offset ?? 0 }

    override func layoutSubviews() {
        super.layoutSubviews()
        strip?.frame = CGRect(x: 0, y: 0, width: contentView.bounds.width, height: Self.height)
        message.frame = CGRect(x: 8, y: 12, width: contentView.bounds.width - 68, height: 0)
        message.sizeToFit()
        info.frame = CGRect(x: contentView.bounds.width - 54, y: contentView.bounds.height - 54, width: 44, height: 44)
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        strip?.cancelAll()
    }

    func configure(item: GalleryItem, pages: Int?, failure: String?, offset: CGFloat, app: AppController, delegate: GalleryRowDelegate) {
        let sameGallery = self.item?.key == item.key
        self.item = item
        self.app = app
        self.delegate = delegate
        info.accessibilityLabel = "Information: \(item.title)"
        if strip == nil {
            let strip = ThumbnailStripView(pipeline: app.pipeline)
            strip.delegate = self
            contentView.insertSubview(strip, at: 0)
            self.strip = strip
        }
        guard let strip else { return }
        if let pages {
            message.isHidden = true
            if !(sameGallery && strip.keys.count == pages && !strip.isHidden) {
                strip.setKeys((0..<pages).map { "\(item.key)/thumbnail/\($0)" }, offset: offset)
            }
            strip.isHidden = false
        } else {
            strip.isHidden = true
            strip.setKeys([])
            message.isHidden = false
            message.text = failure.map { "\(item.title) · \($0)" } ?? item.title
        }
        setNeedsLayout()
    }

    func reloadMissing() { strip?.reloadMissing() }

    func strip(_ strip: ThumbnailStripView, sourceFor index: Int) -> ImageSource {
        guard let key = item?.key, let app else { return .load { throw CancellationError() } }
        return .load { try await app.mediaFile(key, index: index, thumbnail: true) }
    }

    func strip(_ strip: ThumbnailStripView, didSelect index: Int) { delegate?.row(self, didSelectPage: index) }
    func stripDidSettle(_ strip: ThumbnailStripView) { delegate?.rowStripSettled(self) }
}
