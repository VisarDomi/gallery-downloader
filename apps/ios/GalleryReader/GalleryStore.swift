import Foundation

struct StoreEvent: Sendable {
    let library: LibrarySnapshot
    let message: String
    let busy: Bool
}

// All filesystem access, JSON decoding/encoding, and checkpoint commits execute
// on this actor, never on the main actor. Actor reentrancy lets reads proceed
// while a URLSession transfer is suspended awaiting the network.
private struct GalleryProgress: Codable {
    let revision: String
    let thumbnailRevision: String?
    let originalCount: Int
    let thumbnailCount: Int
    let extraThumbnails: Set<Int>
}

private struct MediaID: Hashable, Sendable {
    let gallery: Int
    let page: Int
    let thumbnail: Bool
}

actor GalleryStore {
    nonisolated let root: URL
    nonisolated let events: AsyncStream<StoreEvent>
    private let continuation: AsyncStream<StoreEvent>.Continuation
    private let api: GalleryAPI
    private var library = LibrarySnapshot()
    private var busy = false
    private var message = "Opening library…"
    private var extras: [String: Set<Int>] = [:]
    private var transfers: [MediaID: Task<URL, Error>] = [:]
    private var priorityGalleries = Set<Int>()
    private var checkpointChanges = 0
    private var lastCheckpoint = Date.distantPast
    private var indexByKey: [String: Int] = [:]
    private var catalogItems: [GalleryItem] = []
    private var manifestTasks: [String: Task<GalleryManifest, Error>] = [:]
    private var syncing = false
    private var catalogDirty = false
    private var catalogChanged = true
    private var changedKeys = Set<String>()



    init(root: URL, api: GalleryAPI) {
        self.root = root
        self.api = api
        let pair = AsyncStream<StoreEvent>.makeStream(bufferingPolicy: .bufferingNewest(1))
        events = pair.stream
        continuation = pair.continuation
    }

    private func publish(_ message: String) {
        self.message = message
        continuation.yield(StoreEvent(library: library, message: message, busy: busy || syncing))
    }

    private func checkpoint(force: Bool = false) throws {
        guard checkpointChanges > 0 else { return }
        guard force || checkpointChanges >= 16 || Date().timeIntervalSince(lastCheckpoint) >= 0.25 else { return }
        let progress = Dictionary(uniqueKeysWithValues: library.galleries.map { saved in
            (saved.item.key, GalleryProgress(revision: saved.manifest.revision,
                thumbnailRevision: saved.manifest.thumbnails?.revision,
                originalCount: saved.originalCount, thumbnailCount: saved.thumbnailCount,
                extraThumbnails: extras[saved.item.key] ?? []))
        })
        try DurableFile.write(try JSONEncoder().encode(progress), to: root.appendingPathComponent("progress.json"))
        checkpointChanges = 0
        lastCheckpoint = Date()
    }

    func flushProgress() throws { try checkpoint(force: true) }

    func cancelTransfers() {
        for transfer in transfers.values { transfer.cancel() }
        try? checkpoint(force: true)
    }

    private func rebuildIndex() {
        indexByKey = Dictionary(uniqueKeysWithValues: library.galleries.enumerated().map { ($0.element.item.key, $0.offset) })
    }

    func snapshot() -> LibrarySnapshot { library }

    func webSnapshot(full: Bool = true) throws -> String {
        let includeCatalog = full || catalogChanged
        let galleries = includeCatalog ? library.galleries : library.galleries.filter { changedKeys.contains($0.item.key) }
        let states = galleries.flatMap { saved -> [[String: Any]] in
            var result = [webState(saved, thumbnail: false)]
            if saved.manifest.thumbnails != nil { result.append(webState(saved, thumbnail: true)) }
            return result
        }
        var value: [String: Any] = ["supported": true, "downloads": states, "running": busy || syncing, "message": message]
        if includeCatalog {
            value["catalog"] = ["version": 1, "items": try JSONSerialization.jsonObject(with: JSONEncoder().encode(catalogItems))]
        }
        let json = try webJSON(value)
        catalogChanged = false
        changedKeys.removeAll()
        return json
    }

    private func webState(_ saved: SavedGallery, thumbnail: Bool) -> [String: Any] {
        let count = thumbnail ? saved.thumbnailCount : saved.originalCount
        let pages = thumbnail ? (saved.manifest.thumbnails?.pages ?? []) : saved.manifest.pages
        let extra = thumbnail ? (extras[saved.item.key] ?? []) : []
        let bytes = count > 0 ? pages[count - 1].offset + pages[count - 1].size : 0
        return ["key": saved.item.key + (thumbnail ? ":thumbs" : ""), "downloaded": count + extra.count,
                "total": pages.count, "complete": count == pages.count,
                "bytes": bytes + extra.reduce(Int64(0)) { $0 + pages[$1].size }]
    }

    private func webJSON(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    func webReply(_ command: String, key: String, index: Int) async throws -> String {
        let galleryIndex = try await ensureManifest(key, urgent: true)
        let saved = library.galleries[galleryIndex]
        if command == "describe" || command == "open" {
            let manifest = try JSONSerialization.jsonObject(with: JSONEncoder().encode(saved.manifest))
            return try webJSON(["manifest": manifest, "state": webState(saved, thumbnail: false)])
        }
        let thumbnail = command == "thumbnail"
        let available = thumbnail ? (saved.manifest.thumbnails?.pages.count ?? 0) : saved.originalCount
        guard index >= 0, index < available else { throw ReaderError.missingImage }
        if thumbnail { priorityGalleries.insert(galleryIndex) }
        return try webJSON(["url": "gallery://app/media/\(key)/\(thumbnail ? "thumbnails" : "pages")/\(index)"])
    }

    func localResource(_ url: URL) async throws -> (data: Data, mime: String) {
        try Task.checkCancellation()
        guard url.scheme == "gallery", url.host == "app" else { throw ReaderError.missingImage }
        let components = url.path.split(separator: "/").map(String.init)
        var file: URL
        if components.first == "media" {
            guard components.count == 4, let index = Int(components[3]), index >= 0,
                  ["pages", "thumbnails"].contains(components[2]),
                  let galleryIndex = indexByKey[components[1]] else { throw ReaderError.missingImage }
            let saved = library.galleries[galleryIndex]
            let thumbnail = components[2] == "thumbnails"
            guard index < (thumbnail ? (saved.manifest.thumbnails?.pages.count ?? 0) : saved.originalCount),
                  let found = Self.file(root: root, saved: saved, page: index, thumbnail: thumbnail) else { throw ReaderError.missingImage }
            _ = found
            file = try await ensureMedia(MediaID(gallery: galleryIndex, page: index, thumbnail: thumbnail), urgent: true)
        } else {
            let name = url.path == "/" || url.path.isEmpty ? "index.html" : String(url.path.dropFirst())
            guard ["index.html", "app.js", "style.css", "native.js"].contains(name),
                  let found = Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "Web") else { throw ReaderError.missingImage }
            file = found
        }
        let mime = ["html": "text/html", "js": "text/javascript", "css": "text/css", "jpg": "image/jpeg",
                    "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif"][file.pathExtension.lowercased()] ?? "application/octet-stream"
        return (try Data(contentsOf: file, options: .mappedIfSafe), mime)
    }

    func load() throws -> NavigationSnapshot {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true // Downloaded media remains on the PC.
        var directory = root
        try directory.setResourceValues(values)
        let file = root.appendingPathComponent("library.json")
        if FileManager.default.fileExists(atPath: file.path) {
            library = try JSONDecoder().decode(LibrarySnapshot.self, from: Data(contentsOf: file))
            guard library.version == 1 else { throw ReaderError.invalidCatalog }
            for saved in library.galleries {
                try saved.manifest.validate(for: saved.item)
                guard saved.originalCount >= 0, saved.originalCount <= saved.manifest.pages.count,
                      saved.thumbnailCount >= 0,
                      saved.thumbnailCount <= (saved.manifest.thumbnails?.pages.count ?? 0)
                else { throw ReaderError.invalidManifest }
            }
        }
        rebuildIndex()
        catalogItems = (try? JSONDecoder().decode([GalleryItem].self, from: Data(contentsOf: root.appendingPathComponent("catalog.json")))) ?? library.galleries.map(\.item)
        let progressURL = root.appendingPathComponent("progress.json")
        if let data = try? Data(contentsOf: progressURL),
           let progress = try? JSONDecoder().decode([String: GalleryProgress].self, from: data) {
            for index in library.galleries.indices {
                let saved = library.galleries[index]
                guard let state = progress[saved.item.key], state.revision == saved.manifest.revision,
                      state.originalCount >= 0, state.originalCount <= saved.manifest.pages.count else { continue }
                library.galleries[index].originalCount = state.originalCount
                let thumbnailTotal = saved.manifest.thumbnails?.pages.count ?? 0
                if state.thumbnailRevision == saved.manifest.thumbnails?.revision,
                   state.thumbnailCount >= 0, state.thumbnailCount <= thumbnailTotal,
                   state.extraThumbnails.allSatisfy({ $0 >= state.thumbnailCount && $0 < thumbnailTotal }) {
                    library.galleries[index].thumbnailCount = state.thumbnailCount
                    extras[saved.item.key] = state.extraThumbnails
                }
            }
        }
        publish(library.galleries.isEmpty ? "Connecting to your favorites…" : summary())
        let navigation = root.appendingPathComponent("navigation.json")
        // Corrupt navigation never invalidates the downloaded library.
        return (try? JSONDecoder().decode(NavigationSnapshot.self, from: Data(contentsOf: navigation))) ?? NavigationSnapshot()
    }

    func saveNavigation(_ navigation: NavigationSnapshot) throws {
        try Task.checkCancellation()
        try DurableFile.write(try JSONEncoder().encode(navigation), to: root.appendingPathComponent("navigation.json"))
    }

    private func persistCatalog() throws {
        guard catalogDirty else { return }
        try DurableFile.write(try JSONEncoder().encode(library), to: root.appendingPathComponent("library.json"))
        catalogDirty = false
    }

    private func ensureManifest(_ key: String, urgent: Bool) async throws -> Int {
        if let index = indexByKey[key] { return index }
        guard let item = catalogItems.first(where: { $0.key == key }) else { throw ReaderError.missingImage }
        let task: Task<GalleryManifest, Error>
        if let existing = manifestTasks[key] { task = existing }
        else {
            task = Task { [api] in try await api.manifest(item, urgent: urgent) }
            manifestTasks[key] = task
        }
        defer { manifestTasks.removeValue(forKey: key) }
        let manifest = try await task.value
        if let index = indexByKey[key] { return index }
        let index = library.galleries.count
        library.galleries.append(SavedGallery(item: item, manifest: manifest))
        indexByKey[key] = index
        catalogDirty = true
        changedKeys.insert(key)
        publish("\(catalogItems.count) favorites · \(library.galleries.count) ready")
        return index
    }

    func refreshCatalog(limit: Int? = nil) async throws {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false; publish(message) }
        do {
            let remote = try CatalogSelection.completed(await api.catalog(), limit: limit)
            let ordered = CatalogSelection.ordered(remote: remote, saved: catalogItems)
            if ordered != catalogItems { catalogChanged = true }
            catalogItems = ordered
            try DurableFile.write(try JSONEncoder().encode(catalogItems), to: root.appendingPathComponent("catalog.json"))
            // Paint the entire entry list from the small catalog immediately.
            // Manifests and visible thumbnails can arrive independently afterward.
            publish("\(catalogItems.count) favorites · loading new gallery details…")
            let missing = catalogItems.filter { indexByKey[$0.key] == nil }
            try await withThrowingTaskGroup(of: Void.self) { group in
                var next = 0
                func add(_ index: Int) {
                    group.addTask { _ = try await self.ensureManifest(missing[index].key, urgent: false) }
                }
                for i in 0..<min(6, missing.count) { add(i); next += 1 }
                for try await _ in group {
                    try Task.checkCancellation()
                    if next < missing.count { add(next); next += 1 }
                }
            }
            try persistCatalog()
            try checkpoint(force: true)
            if !busy { publish(summary()) }
        } catch {
            try? persistCatalog()
            publish(library.galleries.isEmpty ? error.localizedDescription : "PC unavailable; keeping saved galleries. " + summary())
            throw error
        }
    }

    func summary() -> String {
        let count = library.galleries.reduce(0) { $0 + $1.originalCount }
        let total = library.galleries.reduce(0) { $0 + $1.manifest.pages.count }
        let bytes = library.galleries.reduce(Int64(0)) { $0 + $1.manifest.bytes + ($1.manifest.thumbnails?.bytes ?? 0) }
        return "\(library.galleries.count) galleries · \(count)/\(total) pages saved · \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)) total"
    }

    func downloadAll(limit: Int? = nil) async throws {
        guard !busy else { return }
        if library.galleries.isEmpty { try await refreshCatalog(limit: limit) }
        try Task.checkCancellation()
        if library.galleries.allSatisfy({ $0.complete && $0.thumbnailCount == ($0.manifest.thumbnails?.pages.count ?? 0) }) {
            try checkpoint(force: true)
            publish("Saved for offline reading. " + summary())
            return
        }
        busy = true
        publish("Saving source thumbnails…")
        var failures = 0
        var lastFailure = ""
        do {
            // Previews first, originals second. Existing source bytes are retained.
            var scheduled = Set<Int>()
            var stalled = false
            await withTaskGroup(of: (String?, Bool).self) { group in
                func add(_ index: Int) {
                    group.addTask {
                        do {
                            try await self.downloadGallery(index, thumbnails: true)
                            try await self.downloadGallery(index, thumbnails: false)
                            return (nil, false)
                        } catch {
                            if Task.isCancelled { return (nil, false) }
                            let failure = error as NSError
                            let network = failure.domain == NSURLErrorDomain && [NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed].contains(failure.code)
                            let fullDisk = failure.domain == NSCocoaErrorDomain && failure.code == CocoaError.fileWriteOutOfSpace.rawValue
                            return (error.localizedDescription, network || fullDisk)
                        }
                    }
                }
                // Eight gallery pipelines share twelve network slots. Originals
                // begin as each gallery's previews finish; visible previews jump ahead.
                for _ in 0..<8 { if let index = nextGallery(excluding: scheduled) { scheduled.insert(index); add(index) } }
                for await (error, shouldStop) in group {
                    if let error { failures += 1; if !stalled { lastFailure = error } }
                    stalled = stalled || shouldStop
                    if Task.isCancelled || stalled { group.cancelAll() }
                    else if let index = nextGallery(excluding: scheduled) { scheduled.insert(index); add(index) }
                }
            }
            try Task.checkCancellation()
            try checkpoint(force: true)
            busy = false
            publish(failures == 0 ? "Saved for offline reading. " + summary()
                    : "\(failures) downloads need retry. \(lastFailure)")
        } catch {
            try? checkpoint(force: true)
            busy = false
            publish(Task.isCancelled ? "Stopped. Resume keeps completed pages." : error.localizedDescription)
            throw error
        }
    }

    private func nextGallery(excluding scheduled: Set<Int>) -> Int? {
        let pending = library.galleries.indices.filter { index in
            let saved = library.galleries[index]
            return !scheduled.contains(index) && (!saved.complete || saved.thumbnailCount < (saved.manifest.thumbnails?.pages.count ?? 0))
        }
        return pending.first(where: { priorityGalleries.contains($0) }) ?? pending.first
    }

    private func downloadGallery(_ index: Int, thumbnails: Bool) async throws {
        let saved = library.galleries[index]
        let pages = thumbnails ? (saved.manifest.thumbnails?.pages ?? []) : saved.manifest.pages
        let start = thumbnails ? saved.thumbnailCount : saved.originalCount
        for number in start..<pages.count {
            try Task.checkCancellation()
            _ = try await ensureMedia(MediaID(gallery: index, page: number, thumbnail: thumbnails), urgent: false)
        }
    }

    private func ensureMedia(_ id: MediaID, urgent: Bool) async throws -> URL {
        try Task.checkCancellation()
        if let existing = transfers[id] { return try await existing.value }
        let saved = library.galleries[id.gallery]
        let pages = id.thumbnail ? (saved.manifest.thumbnails?.pages ?? []) : saved.manifest.pages
        guard pages.indices.contains(id.page),
              let destination = Self.file(root: root, saved: saved, page: id.page, thumbnail: id.thumbnail) else { throw ReaderError.missingImage }
        let page = pages[id.page]
        let transfer = Task { [api] in
            if !DurableFile.matches(destination, size: page.size) {
                let temporary = try await api.download(page, urgent: urgent)
                defer { try? FileManager.default.removeItem(at: temporary) }
                try Task.checkCancellation()
                try DurableFile.commitDownload(temporary, to: destination, expectedSize: page.size)
            }
            return destination
        }
        transfers[id] = transfer
        defer { transfers.removeValue(forKey: id) }
        let result = try await withTaskCancellationHandler(operation: { try await transfer.value }, onCancel: { transfer.cancel() })
        // Completion follows durable media bytes. Out-of-order visible thumbnails
        // are recorded separately until the contiguous prefix catches up.
        if id.thumbnail {
            if id.page >= library.galleries[id.gallery].thumbnailCount {
                extras[saved.item.key, default: []].insert(id.page)
                while extras[saved.item.key]?.remove(library.galleries[id.gallery].thumbnailCount) != nil {
                    library.galleries[id.gallery].thumbnailCount += 1
                }
                checkpointChanges += 1
            }
        } else if id.page == library.galleries[id.gallery].originalCount {
            library.galleries[id.gallery].originalCount += 1
            checkpointChanges += 1
        }
        try checkpoint()
        changedKeys.insert(saved.item.key)
        let kind = id.thumbnail ? "Thumbnails" : "Pages"
        publish("\(kind) · gallery \(id.gallery + 1)/\(library.galleries.count) · \(id.page + 1)/\(pages.count)")
        return result
    }

    nonisolated static func file(root: URL, saved: SavedGallery, page: Int, thumbnail: Bool) -> URL? {
        let pages = thumbnail ? saved.manifest.thumbnails?.pages : saved.manifest.pages
        guard let pages, pages.indices.contains(page) else { return nil }
        let revision = thumbnail ? saved.manifest.thumbnails!.revision : saved.manifest.revision
        return root.appendingPathComponent(saved.item.key).appendingPathComponent(revision)
            .appendingPathComponent(thumbnail ? "thumbnails" : "pages").appendingPathComponent(pages[page].name)
    }
}

enum DurableFile {
    static func matches(_ url: URL, size: Int64) -> Bool {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.type] as? FileAttributeType) == .typeRegular && (attrs?[.size] as? NSNumber)?.int64Value == size
    }

    static func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
    }

    static func commitDownload(_ source: URL, to destination: URL, expectedSize: Int64) throws {
        guard matches(source, size: expectedSize) else { throw ReaderError.wrongSize }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        let handle = try FileHandle(forWritingTo: source)
        try handle.synchronize()
        try handle.close()
        // POSIX rename atomically replaces an incomplete destination on this volume.
        guard rename(source.path, destination.path) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
    }
}
