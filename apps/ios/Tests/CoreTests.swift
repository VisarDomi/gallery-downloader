import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NSError(domain: "CoreTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

@main
struct CoreTests {
    static func main() async throws {
        let items = (1...40).map { i in GalleryItem(key: "hitomi-\(i)", provider: "hitomi", id: String(i), title: "Test", pages: i, ready: i != 1) }
        let catalog = Catalog(version: 1, items: items.reversed() + [items[3]])
        let selected = try CatalogSelection.completed(catalog, limit: 30)
        try expect(selected.count == 30 && selected.first?.pages == 40 && selected.last?.pages == 11, "Selection preserves source order while deduplicating and limiting")
        let all = try CatalogSelection.completed(catalog)
        try expect(all.count == 39 && all.last?.pages == 2, "Default import includes every completed gallery beyond the old limit")
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
        _ = try await offlineStore.load()
        try await offlineStore.downloadAll()
        let failedRequests = await brokenAPI.transferStatistics().requests
        try expect(failedRequests <= 8, "An unavailable server stops the batch without trying every gallery")
        print("PASS: unavailable server stops the transfer batch")

        if CommandLine.arguments.contains("--integration") {
            let api = GalleryAPI(base: URL(string: "https://192.168.1.197:7777")!, certificateURL: URL(fileURLWithPath: "Resources/LocalCA.cer"))
            let store = GalleryStore(root: root.appendingPathComponent("library"), api: api)
            _ = try await store.load()
            let download = Task { try await store.downloadAll(limit: 30) }
            for await event in store.events {
                if event.library.galleries.contains(where: { $0.thumbnailCount > 0 }) { download.cancel(); break }
            }
            _ = try? await download.value
            let interrupted = await store.snapshot()
            try expect(interrupted.galleries.count == 30 && interrupted.galleries.contains { $0.thumbnailCount > 0 }, "Automatic download loads favorites and keeps committed previews on cancellation")
            let pageCount = interrupted.galleries.reduce(0) { $0 + $1.manifest.pages.count }
            let restarted = GalleryStore(root: root.appendingPathComponent("library"), api: api)
            _ = try await restarted.load()
            try await restarted.downloadAll()
            let completed = await restarted.snapshot()
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
            try await restarted.refreshCatalog(limit: 31)
            let synced = await restarted.snapshot()
            try expect(synced.galleries.count == 31, "Sync discovers a newly available gallery")
            for saved in synced.galleries where oldKeys.contains(saved.item.key) {
                try expect(saved.complete, "Sync preserves completed original checkpoints")
            }
            let afterSyncRequests = await api.transferStatistics().requests
            try expect(beforeSyncRequests == afterSyncRequests, "Catalog sync does not redownload saved images")
            try await restarted.refreshCatalog(limit: 31)
            let repeated = await restarted.snapshot()
            try expect(repeated.galleries.count == 31, "Repeated sync does not duplicate entries")
            let newest = synced.galleries.first { !oldKeys.contains($0.item.key) }!
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
            let metadata = try Data(contentsOf: root.appendingPathComponent("library/library.json"))
            try expect(progress.count < metadata.count / 10, "Image checkpoints exclude bulky manifests")
            let reopened = GalleryStore(root: root.appendingPathComponent("library"), api: api)
            _ = try await reopened.load()
            _ = try await reopened.localResource(thumbURL)
            let afterReopen = await api.transferStatistics().requests
            try expect(afterReopen == afterPriority, "Out-of-order visible thumbnail survives restart without another transfer")
            try await reopened.downloadAll()
            let requestCount = await api.transferStatistics().requests
            try await reopened.downloadAll()
            let idleCount = await api.transferStatistics().requests
            try expect(idleCount == requestCount, "Completed library performs no image transfers on resume")
            let stats = await api.transferStatistics()
            try expect(stats.peak > 1 && stats.peak <= GalleryAPI.transferLimit, "Transfers overlap within the shared connection budget")
            print("PASS: incremental sync, concurrent transfer deduplication, sparse thumbnail restart, compact checkpoints, peak=\(stats.peak)")
            let fullStore = GalleryStore(root: root.appendingPathComponent("full-library"), api: api)
            _ = try await fullStore.load()
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
            let full = await fullStore.snapshot()
            try expect(full.galleries.count == expected.count && full.galleries.count > 30, "Full sync obtains every gallery manifest")
            print("PASS: immediate full catalog, concurrent metadata, all \(full.galleries.count) galleries")

        }
    }
}
