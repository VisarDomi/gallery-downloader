import Foundation

@main
struct StartupBenchmark {
    static func main() async throws {
        let source = URL(fileURLWithPath: CommandLine.arguments[1])
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: source, to: root.appendingPathComponent("library.json"))
        if CommandLine.arguments.count > 2 {
            try FileManager.default.copyItem(at: URL(fileURLWithPath: CommandLine.arguments[2]), to: root.appendingPathComponent("catalog.json"))
        }
        var metrics: [String: Double] = [:]
        var start = Date()
        let data = try Data(contentsOf: source)
        metrics["read_ms"] = Date().timeIntervalSince(start) * 1000
        start = Date()
        let library = try JSONDecoder().decode(LibrarySnapshot.self, from: data)
        metrics["decode_ms"] = Date().timeIntervalSince(start) * 1000
        start = Date()
        for saved in library.galleries { try saved.manifest.validate(for: saved.item) }
        metrics["validate_all_ms"] = Date().timeIntervalSince(start) * 1000
        let store = GalleryStore(root: root, api: GalleryAPI(base: URL(string: "https://127.0.0.1:1")!, certificateURL: nil))
        start = Date()
        try await store.load()
        metrics["initial_index_preparation_ms"] = Date().timeIntervalSince(start) * 1000
        let reopened = GalleryStore(root: root, api: GalleryAPI(base: URL(string: "https://127.0.0.1:1")!, certificateURL: nil))
        start = Date()
        try await reopened.load()
        metrics["store_load_ms"] = Date().timeIntervalSince(start) * 1000
        start = Date()
        _ = try await reopened.webSnapshot()
        metrics["web_snapshot_ms"] = Date().timeIntervalSince(start) * 1000
        start = Date()
        let firstItems = CommandLine.arguments.count > 2
            ? try JSONDecoder().decode([GalleryItem].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
            : library.galleries.map(\.item)
        for item in firstItems.prefix(4) { _ = try await reopened.webReply("describe", key: item.key, index: -1) }
        metrics["first_four_galleries_ms"] = Date().timeIntervalSince(start) * 1000
        start = Date()
        await reopened.warmRemaining()
        metrics["remaining_metadata_ms"] = Date().timeIntervalSince(start) * 1000
        metrics["index_bytes"] = Double(try Data(contentsOf: root.appendingPathComponent("index.json")).count)
        metrics["manifest_bytes"] = Double(data.count)
        metrics["galleries"] = Double(library.galleries.count)
        metrics["page_records"] = Double(library.galleries.reduce(0) { $0 + $1.manifest.pages.count + ($1.manifest.thumbnails?.pages.count ?? 0) })
        print(String(decoding: try JSONSerialization.data(withJSONObject: metrics, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
