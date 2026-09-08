import Foundation

struct GalleryItem: Codable, Sendable, Equatable {
    let key: String
    let provider: String
    let id: String
    let title: String
    let pages: Int
    let ready: Bool
}

struct Catalog: Decodable, Sendable {
    let version: Int
    let items: [GalleryItem]
}

struct MediaPage: Codable, Sendable {
    let name: String
    let size: Int64
    let offset: Int64
    let url: String
    let width: Double?
    let height: Double?
}

struct ThumbnailManifest: Codable, Sendable {
    let revision: String
    let pages: [MediaPage]
    let bytes: Int64
}

struct GalleryMetadata: Codable, Sendable {
    let title: String?
    let title_jpn: String?
    let artists: [String]?
    let groups: [String]?
    let tags: [String]?
    let language: String?
    let type: String?
}

struct GalleryManifest: Codable, Sendable {
    let key: String
    let title: String
    let revision: String
    let pages: [MediaPage]
    let bytes: Int64
    let thumbnails: ThumbnailManifest?
    let metadata: GalleryMetadata?

    func validate(for item: GalleryItem) throws {
        guard key == item.key, key == "\(item.provider)-\(item.id)",
              ["hitomi", "imhentai"].contains(item.provider),
              item.id.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil,
              pages.count == item.pages else { throw ReaderError.invalidManifest }
        try Self.validatePages(pages, revision: revision, bytes: bytes, item: item, kind: "pages")
        if let thumbnails {
            guard thumbnails.pages.count == pages.count else { throw ReaderError.invalidManifest }
            try Self.validatePages(thumbnails.pages, revision: thumbnails.revision,
                                   bytes: thumbnails.bytes, item: item, kind: "thumbnails")
        }
    }

    private static func validatePages(_ pages: [MediaPage], revision: String, bytes: Int64,
                                      item: GalleryItem, kind: String) throws {
        guard !pages.isEmpty, revision.range(of: "^[a-f0-9]{24}$", options: .regularExpression) != nil
        else { throw ReaderError.invalidManifest }
        var offset: Int64 = 0
        var names = Set<String>()
        let prefix = "\(item.provider)_\(item.id)_" + (kind == "thumbnails" ? "thumb_" : "")
        let namesPattern = try NSRegularExpression(pattern: "^\(prefix)[0-9]+\\.(avif|gif|jpe?g|png|webp)$", options: [.caseInsensitive])
        for page in pages {
            guard namesPattern.firstMatch(in: page.name, range: NSRange(page.name.startIndex..., in: page.name)) != nil,
                  names.insert(page.name).inserted, page.size > 0, page.size <= 512 * 1024 * 1024,
                  page.offset == offset,
                  page.url == "/offline-api/\(item.provider)/\(item.id)/\(kind)/\(page.name)"
            else { throw ReaderError.invalidManifest }
            offset += page.size
        }
        guard offset == bytes else { throw ReaderError.invalidManifest }
    }
}

struct SavedGallery: Codable, Sendable {
    let item: GalleryItem
    let manifest: GalleryManifest
    var originalCount = 0
    var thumbnailCount = 0

    var complete: Bool { originalCount == manifest.pages.count }
}

struct LibrarySnapshot: Codable, Sendable {
    var version = 1
    var galleries: [SavedGallery] = []
}

enum ReaderError: LocalizedError {
    case invalidManifest, invalidCatalog, badResponse(Int), missingImage, wrongSize
    var errorDescription: String? {
        switch self {
        case .invalidManifest: return "The PC returned an invalid gallery manifest."
        case .invalidCatalog: return "The PC returned an invalid favorites catalog."
        case .badResponse(let code): return "The PC returned HTTP \(code)."
        case .missingImage: return "This page isn't saved yet."
        case .wrongSize: return "An image download was incomplete. It will retry automatically."
        }
    }
}

enum CatalogSelection {
    static func completed(_ catalog: Catalog) throws -> [GalleryItem] {
        guard catalog.version == 1 else { throw ReaderError.invalidCatalog }
        var seen = Set<String>()
        return catalog.items.filter { $0.ready && $0.pages > 0 && seen.insert($0.key).inserted }
    }

    static func ordered(remote: [GalleryItem], saved: [GalleryItem]) -> [GalleryItem] {
        let currentKeys = Set(remote.map(\.key))
        // Mirror the source list. Retain offline-only entries after current
        // favorites; ordinary sync never deletes the user's saved galleries.
        return remote + saved.filter { !currentKeys.contains($0.key) }
    }
}

// The launch index has one small record per gallery, no individual image records.
struct GalleryHeader: Codable, Sendable {
    let item: GalleryItem
    let revision: String
    let thumbnailRevision: String?
    let bytes: Int64
    let thumbnailBytes: Int64
    let originalCount: Int
    let thumbnailCount: Int
    let originalSavedBytes: Int64
    let thumbnailSavedBytes: Int64

    init(_ saved: SavedGallery) {
        item = saved.item; revision = saved.manifest.revision
        thumbnailRevision = saved.manifest.thumbnails?.revision
        bytes = saved.manifest.bytes; thumbnailBytes = saved.manifest.thumbnails?.bytes ?? 0
        originalCount = saved.originalCount; thumbnailCount = saved.thumbnailCount
        originalSavedBytes = Self.prefixBytes(saved.manifest.pages, count: originalCount)
        thumbnailSavedBytes = Self.prefixBytes(saved.manifest.thumbnails?.pages ?? [], count: thumbnailCount)
    }
    static func prefixBytes(_ pages: [MediaPage], count: Int) -> Int64 {
        count > 0 && count <= pages.count ? pages[count - 1].offset + pages[count - 1].size : 0
    }
    func validate() throws {
        guard item.key == "\(item.provider)-\(item.id)", ["hitomi", "imhentai"].contains(item.provider),
              item.id.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil,
              revision.range(of: "^[a-f0-9]{24}$", options: .regularExpression) != nil,
              thumbnailRevision == nil || thumbnailRevision!.range(of: "^[a-f0-9]{24}$", options: .regularExpression) != nil,
              item.pages > 0, originalCount >= 0, originalCount <= item.pages,
              thumbnailCount >= 0, thumbnailCount <= (thumbnailRevision == nil ? 0 : item.pages)
        else { throw ReaderError.invalidManifest }
    }
}
