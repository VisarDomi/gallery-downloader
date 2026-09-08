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

    var aspect: Double {
        guard let width, let height, width > 0, height > 0 else { return 0.7 }
        return width / height
    }
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
        for page in pages {
            guard page.name.range(of: "^\(prefix)[0-9]+\\.(avif|gif|jpe?g|png|webp)$",
                                  options: [.regularExpression, .caseInsensitive]) != nil,
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

enum ScreenRoute: Codable, Sendable {
    case library(page: Int, offset: Double, rows: [String: Double])
    case reader(key: String, page: Int, fraction: Double)
}

struct NavigationSnapshot: Codable, Sendable {
    var back: [ScreenRoute] = [.library(page: 0, offset: 0, rows: [:])]
    var forward: [ScreenRoute] = []
}

enum ReaderError: LocalizedError {
    case invalidManifest, invalidCatalog, badResponse(Int), missingImage, wrongSize, noGalleries
    var errorDescription: String? {
        switch self {
        case .invalidManifest: return "The PC returned an invalid gallery manifest."
        case .invalidCatalog: return "The PC returned an invalid favorites catalog."
        case .badResponse(let code): return "The PC returned HTTP \(code)."
        case .missingImage: return "This page isn't saved yet. Return to the library and resume downloads."
        case .wrongSize: return "An image download was incomplete. Resume to retry it."
        case .noGalleries: return "No completed galleries are available on the PC."
        }
    }
}

enum CatalogSelection {
    static func completed(_ catalog: Catalog, limit: Int? = nil) throws -> [GalleryItem] {
        guard catalog.version == 1 else { throw ReaderError.invalidCatalog }
        var seen = Set<String>()
        let eligible = catalog.items.filter { $0.ready && $0.pages > 0 && seen.insert($0.key).inserted }
        let result = eligible.prefix(limit ?? eligible.count)
        guard !result.isEmpty else { throw ReaderError.noGalleries }
        return Array(result)
    }

    static func ordered(remote: [GalleryItem], saved: [GalleryItem]) -> [GalleryItem] {
        let currentKeys = Set(remote.map(\.key))
        // Mirror the source list. Retain offline-only entries after current
        // favorites; ordinary sync never deletes the user's saved galleries.
        return remote + saved.filter { !currentKeys.contains($0.key) }
    }
}
