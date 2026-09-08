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
    var extraOriginals: Set<Int>? = nil
    var originalBytes: Int64? = nil
    var thumbnailBytes: Int64? = nil
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
    private let api: any GallerySource
    private var library = LibrarySnapshot()
    private var busy = false
    private var message = "Opening library…"
    private var originalExtras: [String: Set<Int>] = [:]
    private var headers: [String: GalleryHeader] = [:]
    private var savedProgress: [String: GalleryProgress] = [:]
    private var warming = false
    private var interactive = 0
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
    private var validatedKeys = Set<String>()
    private var savedViewState: ViewState?
    private var startupMetrics: [String: Double] = [:]



    init(root: URL, api: any GallerySource) {
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
        for saved in library.galleries {
            let key = saved.item.key
            var state = GalleryProgress(revision: saved.manifest.revision,
                thumbnailRevision: saved.manifest.thumbnails?.revision,
                originalCount: saved.originalCount, thumbnailCount: saved.thumbnailCount,
                extraThumbnails: extras[key] ?? [])
            state.extraOriginals = originalExtras[key] ?? []
            state.originalBytes = GalleryHeader.prefixBytes(saved.manifest.pages, count: saved.originalCount)
                + (originalExtras[key] ?? []).reduce(Int64(0)) { $0 + saved.manifest.pages[$1].size }
            state.thumbnailBytes = GalleryHeader.prefixBytes(saved.manifest.thumbnails?.pages ?? [], count: saved.thumbnailCount)
                + (extras[key] ?? []).reduce(Int64(0)) { $0 + saved.manifest.thumbnails!.pages[$1].size }
            savedProgress[key] = state
        }
        try DurableFile.write(try JSONEncoder().encode(savedProgress), to: root.appendingPathComponent("progress.json"))
        checkpointChanges = 0
        lastCheckpoint = Date()
    }

    func flushProgress() throws { try checkpoint(force: true) }

    func cancelTransfers() {
        for transfer in transfers.values { transfer.cancel() }
        try? checkpoint(force: true)
    }

    func galleryCount() -> Int { headers.count }
    func loadedGalleryCount() -> Int { library.galleries.count }

    // Diagnostic/test snapshot; the UI uses the small index and never awaits this.
    func snapshot() async throws -> LibrarySnapshot {
        for item in catalogItems { if headers[item.key] != nil { _ = try await ensureManifest(item.key, urgent: false) } }
        return library
    }

    func warmRemaining() async {
        guard !warming, library.galleries.count < headers.count else { return }
        warming = true
        defer { warming = false }
        for item in catalogItems {
            if Task.isCancelled { return }
            while interactive > 0 {
                do { try await Task.sleep(for: .milliseconds(10)) } catch { return }
            }
            if headers[item.key] != nil { _ = try? await ensureManifest(item.key, urgent: false) }
            // One gallery per turn: new reader/thumbnail requests can interrupt
            // the warm-up, which continues until the remaining work is finished.
            await Task.yield()
        }
        publish(summary())
    }

    func webSnapshot(full: Bool = true) throws -> String {
        let includeCatalog = full || catalogChanged
        let keys = includeCatalog ? catalogItems.map(\.key) : Array(changedKeys)
        let states = keys.flatMap { key -> [[String: Any]] in
            if let index = indexByKey[key] {
                let saved = library.galleries[index]
                var result = [webState(saved, thumbnail: false)]
                if saved.manifest.thumbnails != nil { result.append(webState(saved, thumbnail: true)) }
                return result
            }
            guard let header = headers[key] else { return [] }
            let state = savedProgress[key]
            let originalCount = state?.originalCount ?? header.originalCount
            let thumbnailCount = state?.thumbnailCount ?? header.thumbnailCount
            var result: [[String: Any]] = [["key": key, "downloaded": originalCount + (state?.extraOriginals?.count ?? 0),
                "total": header.item.pages, "complete": originalCount == header.item.pages,
                "bytes": state?.originalBytes ?? header.originalSavedBytes]]
            if header.thumbnailRevision != nil {
                result.append(["key": key + ":thumbs", "downloaded": thumbnailCount + (state?.extraThumbnails.count ?? 0),
                    "total": header.item.pages, "complete": thumbnailCount == header.item.pages,
                    "bytes": state?.thumbnailBytes ?? header.thumbnailSavedBytes])
            }
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
        let extra = thumbnail ? (extras[saved.item.key] ?? []) : (originalExtras[saved.item.key] ?? [])
        let bytes = count > 0 ? pages[count - 1].offset + pages[count - 1].size : 0
        return ["key": saved.item.key + (thumbnail ? ":thumbs" : ""), "downloaded": count + extra.count,
                "total": pages.count, "complete": count == pages.count,
                "bytes": bytes + extra.reduce(Int64(0)) { $0 + pages[$1].size }]
    }

    private func webJSON(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    func webReply(_ command: String, key: String, index: Int) async throws -> String {
        interactive += 1
        defer { interactive -= 1 }
        let galleryIndex = try await ensureManifest(key, urgent: true)
        let saved = library.galleries[galleryIndex]
        if command == "describe" || command == "open" {
            let manifest = try JSONSerialization.jsonObject(with: JSONEncoder().encode(saved.manifest))
            return try webJSON(["manifest": manifest, "state": webState(saved, thumbnail: false)])
        }
        let thumbnail = command == "thumbnail"
        let available = thumbnail ? (saved.manifest.thumbnails?.pages.count ?? 0) : saved.manifest.pages.count
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
                  headers[components[1]] != nil else { throw ReaderError.missingImage }
            interactive += 1
            defer { interactive -= 1 }
            let galleryIndex = try await ensureManifest(components[1], urgent: true)
            let saved = library.galleries[galleryIndex]
            let thumbnail = components[2] == "thumbnails"
            guard index < (thumbnail ? (saved.manifest.thumbnails?.pages.count ?? 0) : saved.manifest.pages.count)
            else { throw ReaderError.missingImage }
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

    func load() async throws {
        let start = Date()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var directory = root; try directory.setResourceValues(values)
        let indexURL = root.appendingPathComponent("index.json")
        var orderedHeaders: [GalleryHeader] = []
        if FileManager.default.fileExists(atPath: indexURL.path) {
            orderedHeaders = try JSONDecoder().decode([GalleryHeader].self, from: Data(contentsOf: indexURL))
        } else {
            let oldURL = root.appendingPathComponent("library.json")
            if FileManager.default.fileExists(atPath: oldURL.path) {
                // Read the old aggregate once; future launches only read index.json.
                let old = try await Task.detached(priority: .utility) {
                    try JSONDecoder().decode(LibrarySnapshot.self, from: Data(contentsOf: oldURL))
                }.value
                guard old.version == 1 else { throw ReaderError.invalidCatalog }
                for saved in old.galleries {
                    try saved.manifest.validate(for: saved.item)
                    let header = GalleryHeader(saved); try header.validate()
                    try DurableFile.write(try JSONEncoder().encode(saved.manifest), to: manifestURL(header.item.key))
                    orderedHeaders.append(header)
                    await Task.yield()
                }
                // Index is published only after every referenced manifest is durable.
                try DurableFile.write(try JSONEncoder().encode(orderedHeaders), to: indexURL)
            }
        }
        for header in orderedHeaders {
            try header.validate()
            guard headers[header.item.key] == nil else { throw ReaderError.invalidCatalog }
            headers[header.item.key] = header
        }
        catalogItems = (try? JSONDecoder().decode([GalleryItem].self, from: Data(contentsOf: root.appendingPathComponent("catalog.json")))) ?? orderedHeaders.map(\.item)
        if let data = try? Data(contentsOf: root.appendingPathComponent("progress.json")),
           let progress = try? JSONDecoder().decode([String: GalleryProgress].self, from: data) {
            for (key, state) in progress {
                guard let header = headers[key], state.revision == header.revision,
                      state.originalCount >= 0, state.originalCount <= header.item.pages,
                      (state.extraOriginals ?? []).allSatisfy({ $0 >= state.originalCount && $0 < header.item.pages }) else { continue }
                let total = header.thumbnailRevision == nil ? 0 : header.item.pages
                guard state.thumbnailRevision == header.thumbnailRevision,
                      state.thumbnailCount >= 0, state.thumbnailCount <= total,
                      state.extraThumbnails.allSatisfy({ $0 >= state.thumbnailCount && $0 < total }) else { continue }
                savedProgress[key] = state
            }
        }
        startupMetrics["store_load_ms"] = Date().timeIntervalSince(start) * 1000
        startupMetrics["launch_gallery_records"] = Double(headers.count)
        startupMetrics["launch_image_records"] = 0
        publish(headers.isEmpty ? "Connecting to your favorites…" : "Opening saved favorites…")
    }

    func viewState() -> ViewState {
        if let savedViewState { return savedViewState }
        if let data = try? Data(contentsOf: root.appendingPathComponent("view-state.json")),
           let state = try? JSONDecoder().decode(ViewState.self, from: data), state.version == 1,
           ViewPosition.route(state.lastPath) != nil,
           ViewPosition.route(state.libraryPath)?.hasPrefix("library:") == true {
            savedViewState = state
        } else { savedViewState = ViewState() }
        return savedViewState!
    }

    func saveViewPosition(_ data: Data) throws {
        guard data.count < 100_000 else { throw ReaderError.invalidCatalog }
        let position = try JSONDecoder().decode(ViewPosition.self, from: data)
        try position.validate()
        var state = viewState()
        let route = ViewPosition.route(position.path)!
        state.positions[route] = position
        state.lastPath = position.path
        if route.hasPrefix("library:") { state.libraryPath = position.path }
        try DurableFile.write(try JSONEncoder().encode(state), to: root.appendingPathComponent("view-state.json"))
        savedViewState = state
    }

    func recordStartup(_ marks: Data) throws {
        let web = try JSONSerialization.jsonObject(with: marks)
        let data = try JSONSerialization.data(withJSONObject: ["native": startupMetrics, "web": web], options: [.sortedKeys])
        try DurableFile.write(data, to: root.appendingPathComponent("startup.json"))
    }

    private func manifestURL(_ key: String) -> URL {
        root.appendingPathComponent("manifests").appendingPathComponent(key + ".json")
    }

    private func validateGallery(_ index: Int) throws {
        let saved = library.galleries[index]
        guard !validatedKeys.contains(saved.item.key) else { return }
        try saved.manifest.validate(for: saved.item)
        validatedKeys.insert(saved.item.key)
    }

    private func persistCatalog() throws {
        guard catalogDirty else { return }
        let ordered = catalogItems.compactMap { headers[$0.key] }
        try DurableFile.write(try JSONEncoder().encode(ordered), to: root.appendingPathComponent("index.json"))
        catalogDirty = false
    }

    private func ensureManifest(_ key: String, urgent: Bool) async throws -> Int {
        if let index = indexByKey[key] { try validateGallery(index); return index }
        if let header = headers[key] {
            let manifest = try JSONDecoder().decode(GalleryManifest.self, from: Data(contentsOf: manifestURL(key)))
            try manifest.validate(for: header.item)
            guard manifest.revision == header.revision, manifest.thumbnails?.revision == header.thumbnailRevision else { throw ReaderError.invalidManifest }
            var saved = SavedGallery(item: header.item, manifest: manifest,
                originalCount: header.originalCount, thumbnailCount: header.thumbnailCount)
            if let state = savedProgress[key] {
                saved.originalCount = state.originalCount; saved.thumbnailCount = state.thumbnailCount
                extras[key] = state.extraThumbnails; originalExtras[key] = state.extraOriginals ?? []
            }
            let index = library.galleries.count
            library.galleries.append(saved); indexByKey[key] = index; validatedKeys.insert(key)
            changedKeys.insert(key)
            return index
        }
        guard let item = catalogItems.first(where: { $0.key == key }) else { throw ReaderError.missingImage }
        let task: Task<GalleryManifest, Error>
        if let existing = manifestTasks[key] {
            if urgent { await api.prioritize("/offline-api/\(item.provider)/\(item.id)/manifest") }
            task = existing
        }
        else {
            task = Task { [api] in try await api.manifest(item, urgent: urgent) }
            manifestTasks[key] = task
        }
        defer { manifestTasks.removeValue(forKey: key) }
        let manifest = try await task.value
        // Sources must return validated manifests before any paths are used.
        try manifest.validate(for: item)
        if let index = indexByKey[key] { return index }
        let index = library.galleries.count
        let saved = SavedGallery(item: item, manifest: manifest)
        let header = GalleryHeader(saved); try header.validate()
        try DurableFile.write(try JSONEncoder().encode(manifest), to: manifestURL(key))
        library.galleries.append(saved)
        headers[key] = header
        indexByKey[key] = index
        validatedKeys.insert(key)
        catalogDirty = true
        changedKeys.insert(key)
        publish("\(catalogItems.count) favorites · \(library.galleries.count) ready")
        return index
    }

    func refreshCatalog() async throws {
        guard !syncing else { return }
        syncing = true
        defer { syncing = false; publish(message) }
        do {
            let remote = try CatalogSelection.completed(await api.catalog())
            let ordered = CatalogSelection.ordered(remote: remote, saved: catalogItems)
            if ordered != catalogItems {
                catalogChanged = true
                catalogItems = ordered
                try DurableFile.write(try JSONEncoder().encode(catalogItems), to: root.appendingPathComponent("catalog.json"))
            }
            // Paint the entire entry list from the small catalog immediately.
            // Manifests and visible thumbnails can arrive independently afterward.
            publish("\(catalogItems.count) favorites · loading new gallery details…")
            let missing = catalogItems.filter { headers[$0.key] == nil }
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
        var count = 0, total = 0
        var bytes: Int64 = 0
        for (key, header) in headers {
            count += indexByKey[key].map { library.galleries[$0].originalCount } ?? savedProgress[key]?.originalCount ?? header.originalCount
            total += header.item.pages; bytes += header.bytes + header.thumbnailBytes
        }
        return "\(headers.count) galleries · \(count)/\(total) pages saved · \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)) total"
    }

    func downloadAll() async throws {
        guard !busy else { return }
        if headers.isEmpty { try await refreshCatalog() }
        // Hydrate only unfinished galleries for transfer scheduling. Completed
        // metadata is warmed separately, one gallery at a time.
        for item in catalogItems {
            if let header = headers[item.key] {
                let state = savedProgress[item.key]
                if (state?.originalCount ?? header.originalCount) < item.pages ||
                    (header.thumbnailRevision != nil && (state?.thumbnailCount ?? header.thumbnailCount) < item.pages) {
                    _ = try await ensureManifest(item.key, urgent: false)
                    await Task.yield()
                }
            }
        }
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
                    : "\(failures) downloads waiting for automatic retry. \(lastFailure)")
        } catch {
            try? checkpoint(force: true)
            busy = false
            publish(Task.isCancelled ? "Paused. Downloads continue when the app is active." : error.localizedDescription)
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
        try validateGallery(id.gallery)
        let saved = library.galleries[id.gallery]
        let pages = id.thumbnail ? (saved.manifest.thumbnails?.pages ?? []) : saved.manifest.pages
        guard pages.indices.contains(id.page),
              let destination = Self.file(root: root, saved: saved, page: id.page, thumbnail: id.thumbnail) else { throw ReaderError.missingImage }
        let page = pages[id.page]
        if let existing = transfers[id] {
            if urgent { await api.prioritize(page.url) }
            return try await existing.value
        }
        let committed = id.thumbnail
            ? id.page < saved.thumbnailCount || extras[saved.item.key]?.contains(id.page) == true
            : id.page < saved.originalCount || originalExtras[saved.item.key]?.contains(id.page) == true
        // Viewing a saved image is a read, not download activity. Do not create
        // transfer tasks, checkpoint work, or UI progress events for these reads.
        if committed && DurableFile.matches(destination, size: page.size) { return destination }
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
        } else if id.page >= library.galleries[id.gallery].originalCount {
            originalExtras[saved.item.key, default: []].insert(id.page)
            while originalExtras[saved.item.key]?.remove(library.galleries[id.gallery].originalCount) != nil {
                library.galleries[id.gallery].originalCount += 1
            }
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
