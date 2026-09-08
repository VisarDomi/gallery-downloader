import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NSError(domain: "CoreTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

// Small catalogs belong to tests, never to the app's selection/sync APIs.
actor TestSource: GallerySource {
    private var items: [GalleryItem]
    private let api: GalleryAPI
    init(items: [GalleryItem], api: GalleryAPI) { self.items = items; self.api = api }
    func setItems(_ items: [GalleryItem]) { self.items = items }
    func catalog() -> Catalog { Catalog(version: 1, items: items) }
    func manifest(_ item: GalleryItem, urgent: Bool) async throws -> GalleryManifest {
        try await api.manifest(item, urgent: urgent)
    }
    func download(_ page: MediaPage, urgent: Bool) async throws -> URL {
        try await api.download(page, urgent: urgent)
    }
}

actor RequestOrder {
    var values: [String] = []
    func append(_ value: String) { values.append(value) }
}

func waitForQueue(_ gate: TransferGate, _ count: Int) async throws {
    for _ in 0..<10000 {
        if await gate.statistics().waiting == count { return }
        await Task.yield()
    }
    throw NSError(domain: "CoreTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "Priority queue did not settle"])
}

@main
struct CoreTests {
    static func main() async throws {
        for promote in [false, true] {
            let gate = TransferGate(limit: 1), order = RequestOrder()
            try await gate.acquire("blocker", urgent: false)
            let first = Task {
                try await gate.acquire("background", urgent: false)
                await order.append("background"); await gate.release()
            }
            try await waitForQueue(gate, 1)
            let next = Task {
                try await gate.acquire("reader", urgent: !promote)
                await order.append("reader"); await gate.release()
            }
            try await waitForQueue(gate, 2)
            if promote { await gate.prioritize("reader") }
            await gate.release()
            try await first.value; try await next.value
            let sequence = await order.values
            try expect(sequence == ["reader", "background"], "Reader takes the next slot; background work still completes, including promoted requests")
        }
        print("PASS: interactive priority, promotion, eventual background completion")
        let items = (1...40).map { i in GalleryItem(key: "hitomi-\(i)", provider: "hitomi", id: String(i), title: "Test", pages: i, ready: i != 1) }
        let catalog = Catalog(version: 1, items: items.reversed() + [items[3]])
        let all = try CatalogSelection.completed(catalog)
        try expect(all.count == 39 && all.first?.pages == 40 && all.last?.pages == 2, "Selection includes all completed galleries in source order, without duplicates or a cap")
        let empty = try CatalogSelection.completed(Catalog(version: 1, items: []))
        try expect(empty.isEmpty, "An empty favorites catalog is valid")
        var rejectedVersion = false
        do { _ = try CatalogSelection.completed(Catalog(version: 2, items: [])) }
        catch { rejectedVersion = true }
        try expect(rejectedVersion, "Unsupported catalog versions are still rejected")
        let sourceOrder = [items[8], items[2], items[6]]
        let previousOrder = [items[6], items[2], items[8], items[10]]
        let reordered = CatalogSelection.ordered(remote: sourceOrder, saved: previousOrder)
        try expect(reordered.map(\.key) == [items[8], items[2], items[6], items[10]].map(\.key), "Sync follows source order and retains offline-only galleries at the end")
        let newestFirst = [items[19]] + sourceOrder
        let refreshed = CatalogSelection.ordered(remote: newestFirst, saved: reordered)
        try expect(refreshed.first?.key == items[19].key && refreshed.count == 5, "A new first favorite appears first without duplicating saved entries")
        try expect(CatalogSelection.ordered(remote: newestFirst, saved: refreshed) == refreshed, "Unchanged source order stays stable across sync")
        let json = #"{"key":"hitomi-1","title":"Test","revision":"aaaaaaaaaaaaaaaaaaaaaaaa","pages":[{"name":"hitomi_1_1.jpg","size":4,"offset":0,"url":"/offline-api/hitomi/1/pages/hitomi_1_1.jpg"}],"bytes":4}"#
        let manifest = try JSONDecoder().decode(GalleryManifest.self, from: Data(json.utf8))
        try manifest.validate(for: items[0])
        for bad in [json.replacingOccurrences(of: "\"offset\":0", with: "\"offset\":1"),
                    json.replacingOccurrences(of: "hitomi_1_1.jpg", with: "../secret.jpg"),
                    json.replacingOccurrences(of: "\"bytes\":4", with: "\"bytes\":5"),
                    json.replacingOccurrences(of: "aaaaaaaaaaaaaaaaaaaaaaaa", with: "../outside")] {
            var rejected = false
            do { try JSONDecoder().decode(GalleryManifest.self, from: Data(bad.utf8)).validate(for: items[0]) }
            catch { rejected = true }
            try expect(rejected, "Reject unsafe or inconsistent manifests")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let destination = root.appendingPathComponent("saved.jpg"), temporary = root.appendingPathComponent("part")
        try DurableFile.write(Data([1, 2, 3, 4]), to: destination)
        try DurableFile.write(Data([9]), to: temporary)
        var rejected = false
        do { try DurableFile.commitDownload(temporary, to: destination, expectedSize: 4) } catch { rejected = true }
        try expect(rejected, "Reject partial download")
        let retained = try Data(contentsOf: destination)
        try expect(retained == Data([1, 2, 3, 4]), "Failed download preserves existing file")
        try DurableFile.write(Data([5, 6, 7, 8]), to: temporary)
        try DurableFile.commitDownload(temporary, to: destination, expectedSize: 4)
        try expect(DurableFile.matches(destination, size: 4), "Committed page can resume without transfer")
        print("PASS: selection, manifest validation, partial-file rejection, atomic replacement")

        let failedRoot = root.appendingPathComponent("offline")
        let brokenAPI = GalleryAPI(base: URL(string: "https://127.0.0.1:1")!, certificateURL: nil)
        let copies = try (1...20).map { id -> SavedGallery in
            let text = json.replacingOccurrences(of: "hitomi-1", with: "hitomi-\(id)")
                .replacingOccurrences(of: "hitomi_1_", with: "hitomi_\(id)_")
                .replacingOccurrences(of: "hitomi/1/", with: "hitomi/\(id)/")
            let item = GalleryItem(key: "hitomi-\(id)", provider: "hitomi", id: String(id), title: "Test", pages: 1, ready: true)
            return SavedGallery(item: item, manifest: try JSONDecoder().decode(GalleryManifest.self, from: Data(text.utf8)))
        }
        try DurableFile.write(try JSONEncoder().encode(LibrarySnapshot(galleries: copies)), to: failedRoot.appendingPathComponent("library.json"))
        let offlineStore = GalleryStore(root: failedRoot, api: brokenAPI)
        try await offlineStore.load()
        try await offlineStore.downloadAll()
        let failedRequests = await brokenAPI.transferStatistics().requests
        try expect(failedRequests <= 8, "An unavailable server stops the batch without trying every gallery")
        print("PASS: unavailable server stops the transfer batch")

        let emptySource = TestSource(items: [], api: brokenAPI)
        let emptyStore = GalleryStore(root: root.appendingPathComponent("empty"), api: emptySource)
        try await emptyStore.load()
        try await emptyStore.downloadAll()
        let emptyPayload = try await emptyStore.webSnapshot()
        let emptyJSON = try JSONSerialization.jsonObject(with: Data(emptyPayload.utf8)) as! [String: Any]
        try expect((emptyJSON["catalog"] as! [String: Any])["items"] as? [String] == [], "Empty library renders an empty catalog")
        let retainedStore = GalleryStore(root: failedRoot, api: emptySource)
        try await retainedStore.load()
        try await retainedStore.refreshCatalog()
        let retainedLibrary = try await retainedStore.snapshot()
        try expect(retainedLibrary.galleries.map(\.item.key) == copies.map(\.item.key), "An empty server catalog preserves saved galleries")
        let retainedPayload = try await retainedStore.webSnapshot()
        let retainedJSON = try JSONSerialization.jsonObject(with: Data(retainedPayload.utf8)) as! [String: Any]
        let retainedItems = (retainedJSON["catalog"] as! [String: Any])["items"] as! [[String: Any]]
        try expect(retainedItems.compactMap { $0["key"] as? String } == copies.map(\.item.key), "Offline-only galleries retain display order")
        print("PASS: empty catalogs and retained offline galleries")
        let libraryPosition = ViewPosition(path: "/?p=2", anchor: "hitomi-34", page: nil, fraction: 0.3, y: 2068, strips: ["hitomi-34": 1337])
        let readerPosition = ViewPosition(path: "/?read=hitomi-34&page=50", anchor: nil, page: 49, fraction: 0.37, y: 54000, strips: [:])
        try await emptyStore.saveViewPosition(JSONEncoder().encode(libraryPosition))
        try await emptyStore.saveViewPosition(JSONEncoder().encode(readerPosition))
        let viewReopened = GalleryStore(root: emptyStore.root, api: emptySource)
        let view = await viewReopened.viewState()
        try expect(view.lastPath == readerPosition.path && view.libraryPath == libraryPosition.path, "Cold restart retains the reader route and its library back destination")
        try expect(view.positions["reader:hitomi-34"]?.fraction == 0.37 && view.positions["library:2"]?.strips["hitomi-34"] == 1337, "Reader fraction and horizontal gallery positions survive disk reload")
        for badPath in ["https://example.com/", "//example.com/", "/?read=../secret", "/?p=-1", "/?p=2&p=3", "/?evil=1"] {
            try expect(ViewPosition.route(badPath) == nil, "Reject invalid restoration routes")
        }
        print("PASS: persistent reader/library state and safe restoration routes")
        let cold = GalleryStore(root: failedRoot, api: emptySource)
        try await cold.load()
        let initiallyLoaded = await cold.loadedGalleryCount()
        try expect(initiallyLoaded == 0, "Cold load reads no per-image metadata")
        _ = try await cold.webSnapshot()
        let afterCatalog = await cold.loadedGalleryCount()
        try expect(afterCatalog == 0, "Rendering the full catalog does not hydrate manifests")
        _ = try await cold.webReply("describe", key: copies[0].item.key, index: -1)
        let afterVisible = await cold.loadedGalleryCount()
        try expect(afterVisible == 1, "Visible gallery loads independently")
        await cold.warmRemaining()
        let afterWarm = await cold.loadedGalleryCount()
        try expect(afterWarm == copies.count, "All remaining metadata eventually finishes")
        print("PASS: small cold-start index, visible gallery first, complete background warm-up")

        if CommandLine.arguments.contains("--integration") {
            let api = GalleryAPI(base: URL(string: "https://192.168.1.197:7777")!, certificateURL: URL(fileURLWithPath: "Resources/LocalCA.cer"))
            let candidates = try CatalogSelection.completed(await api.catalog())
            let sample = Array(candidates.sorted { $0.pages < $1.pages }.prefix(31))
            try expect(sample.count == 31, "LAN fixture has enough completed galleries")
            let source = TestSource(items: Array(sample.prefix(30)), api: api)
            let store = GalleryStore(root: root.appendingPathComponent("library"), api: source)
            try await store.load()
            let download = Task { try await store.downloadAll() }
            for await event in store.events {
                if event.library.galleries.contains(where: { $0.thumbnailCount > 0 }) { download.cancel(); break }
            }
            _ = try? await download.value
            let interrupted = try await store.snapshot()
            try expect(interrupted.galleries.count == 30 && interrupted.galleries.contains { $0.thumbnailCount > 0 }, "Automatic download loads favorites and keeps committed previews on cancellation")
            let pageCount = interrupted.galleries.reduce(0) { $0 + $1.manifest.pages.count }
            let restarted = GalleryStore(root: root.appendingPathComponent("library"), api: source)
            try await restarted.load()
            try await restarted.downloadAll()
            let completed = try await restarted.snapshot()
            try expect(completed.galleries.allSatisfy(\.complete), "Automatic resume completes all original pages")
            for gallery in completed.galleries {
                for (index, page) in gallery.manifest.pages.enumerated() {
                    let url = GalleryStore.file(root: restarted.root, saved: gallery, page: index, thumbnail: false)!
                    try expect(DurableFile.matches(url, size: page.size), "Every completed image has the expected bytes")
                }
            }
            print("PASS: automatic loading, cancellation, restart/resume, all \(pageCount) originals verified")
            let beforeSyncRequests = await api.transferStatistics().requests
            let oldKeys = Set(completed.galleries.map(\.item.key))
            await source.setItems(sample)
            try await restarted.refreshCatalog()
            let synced = try await restarted.snapshot()
            try expect(synced.galleries.count == 31, "Sync discovers a newly available gallery")
            for saved in synced.galleries where oldKeys.contains(saved.item.key) {
                try expect(saved.complete, "Sync preserves completed original checkpoints")
            }
            let afterSyncRequests = await api.transferStatistics().requests
            try expect(beforeSyncRequests == afterSyncRequests, "Catalog sync does not redownload saved images")
            try await restarted.refreshCatalog()
            let repeated = try await restarted.snapshot()
            try expect(repeated.galleries.count == 31, "Repeated sync does not duplicate entries")
            let newest = synced.galleries.first { !oldKeys.contains($0.item.key) }!
            let lastOriginal = newest.manifest.pages.count - 1
            let pageURL = URL(string: "gallery://app/media/\(newest.item.key)/pages/\(lastOriginal)")!
            _ = try await restarted.localResource(pageURL)
            let earlyPage = try await restarted.snapshot().galleries.first { $0.item.key == newest.item.key }!
            try expect(earlyPage.originalCount == 0, "Reading a late page does not falsely mark earlier pages saved")
            let lastThumbnail = newest.manifest.thumbnails!.pages.count - 1
            let thumbURL = URL(string: "gallery://app/media/\(newest.item.key)/thumbnails/\(lastThumbnail)")!
            let beforePriority = await api.transferStatistics().requests
            async let visibleA = restarted.localResource(thumbURL)
            async let visibleB = restarted.localResource(thumbURL)
            _ = try await (visibleA, visibleB)
            let afterPriority = await api.transferStatistics().requests
            try expect(afterPriority - beforePriority == 1, "Concurrent visible thumbnail requests share one transfer")
            try await restarted.flushProgress()
            let progress = try Data(contentsOf: root.appendingPathComponent("library/progress.json"))
            let metadata = try JSONEncoder().encode(synced)
            try expect(progress.count < metadata.count / 10, "Image checkpoints exclude bulky manifests")
            let reopened = GalleryStore(root: root.appendingPathComponent("library"), api: source)
            try await reopened.load()
            _ = try await reopened.localResource(thumbURL)
            _ = try await reopened.localResource(pageURL)
            let afterReopen = await api.transferStatistics().requests
            try expect(afterReopen == afterPriority, "Out-of-order visible thumbnail and original survive restart without another transfer")
            try await reopened.downloadAll()
            let requestCount = await api.transferStatistics().requests
            try await reopened.downloadAll()
            let idleCount = await api.transferStatistics().requests
            try expect(idleCount == requestCount, "Completed library performs no image transfers on resume")
            let stats = await api.transferStatistics()
            try expect(stats.peak > 1 && stats.peak <= GalleryAPI.transferLimit, "Transfers overlap within the shared connection budget")
            print("PASS: incremental sync, concurrent transfer deduplication, sparse thumbnail restart, compact checkpoints, peak=\(stats.peak)")
            let fullStore = GalleryStore(root: root.appendingPathComponent("full-library"), api: api)
            try await fullStore.load()
            let expected = try CatalogSelection.completed(await api.catalog())
            let fullRefresh = Task { try await fullStore.refreshCatalog() }
            for await event in fullStore.events {
                if !event.library.galleries.isEmpty {
                    let payload = try await fullStore.webSnapshot()
                    let json = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as! [String: Any]
                    let entries = (json["catalog"] as! [String: Any])["items"] as! [Any]
                    try expect(entries.count == expected.count, "Entire entry list is available while manifests are still loading")
                    break
                }
            }
            try await fullRefresh.value
            let full = try await fullStore.snapshot()
            try expect(full.galleries.count == expected.count && full.galleries.count > 30, "Full sync obtains every gallery manifest")
            print("PASS: immediate full catalog, concurrent metadata, all \(full.galleries.count) galleries")

        }
    }
}
