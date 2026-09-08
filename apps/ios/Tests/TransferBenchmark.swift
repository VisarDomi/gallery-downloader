import Foundation

@main
struct TransferBenchmark {
    static func main() async throws {
        let library = try JSONDecoder().decode(LibrarySnapshot.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let thumbnails = Array(library.galleries.flatMap { $0.manifest.thumbnails?.pages ?? [] }.prefix(256))
        let originals = Array(library.galleries.flatMap { $0.manifest.pages }.prefix(64))
        for (kind, pages) in [("thumbnails", thumbnails), ("originals", originals)] {
            for width in [1, 4, 8, 12] {
                let api = GalleryAPI(base: URL(string: "https://192.168.1.197:7777")!, certificateURL: URL(fileURLWithPath: "Resources/LocalCA.cer"), connections: width)
                let started = Date()
                try await withThrowingTaskGroup(of: Void.self) { group in
                    var next = 0
                    func add(_ index: Int) {
                        group.addTask {
                            let file = try await api.download(pages[index])
                            try FileManager.default.removeItem(at: file)
                        }
                    }
                    for i in 0..<min(width, pages.count) { add(i); next += 1 }
                    for try await _ in group { if next < pages.count { add(next); next += 1 } }
                }
                let seconds = Date().timeIntervalSince(started)
                let bytes = pages.reduce(Int64(0)) { $0 + $1.size }
                print("\(kind) concurrency=\(width) files=\(pages.count) seconds=\(String(format: "%.2f", seconds)) MB/s=\(String(format: "%.2f", Double(bytes) / seconds / 1_000_000))")
                fflush(stdout)
            }
        }
        let started = Date()
        let encoder = JSONEncoder()
        for _ in 0..<5 { _ = try encoder.encode(library) }
        print("Full catalog JSON encode average ms=\(Date().timeIntervalSince(started) * 1000 / 5)")
    }
}
