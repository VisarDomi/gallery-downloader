import Foundation
import Security

// Only this LAN host may use the bundled PUBLIC local CA. TLS hostname and
// certificate validity are still evaluated; no accept-all certificate handler.
final class LocalTrust: NSObject, URLSessionDelegate, @unchecked Sendable {
    let host: String
    let certificateURL: URL?
    init(host: String, certificateURL: URL?) {
        self.host = host
        self.certificateURL = certificateURL
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == host,
              let trust = challenge.protectionSpace.serverTrust,
              let certificateURL, let data = try? Data(contentsOf: certificateURL),
              let certificate = SecCertificateCreateWithData(nil, data as CFData)
        else { completionHandler(.performDefaultHandling, nil); return }
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        if SecTrustEvaluateWithError(trust, nil) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

protocol GallerySource: Sendable {
    func catalog() async throws -> Catalog
    func manifest(_ item: GalleryItem, urgent: Bool) async throws -> GalleryManifest
    func download(_ page: MediaPage, urgent: Bool) async throws -> URL
    func prioritize(_ path: String) async
}

extension GallerySource {
    func prioritize(_ path: String) async {}
}

// Requests already transferring finish; the next free slot goes to interactive
// work. Background requests remain queued and continue afterward.
actor TransferGate {
    private let limit: Int
    private var active = 0
    private var peak = 0
    private var waiting: [(path: String, urgent: Bool, continuation: CheckedContinuation<Void, Never>)] = []
    init(limit: Int) { self.limit = max(1, limit) }
    func acquire(_ path: String, urgent: Bool) async throws {
        if active < limit { active += 1; peak = max(peak, active) }
        else { await withCheckedContinuation { waiting.append((path, urgent, $0)) } }
        do { try Task.checkCancellation() }
        catch { release(); throw error }
    }
    func prioritize(_ path: String) {
        for index in waiting.indices where waiting[index].path == path { waiting[index].urgent = true }
    }
    func release() {
        if waiting.isEmpty { active -= 1 }
        else {
            let index = waiting.firstIndex(where: \.urgent) ?? 0
            waiting.remove(at: index).continuation.resume()
        }
    }
    func statistics() -> (peak: Int, waiting: Int) { (peak, waiting.count) }
}

actor GalleryAPI: GallerySource {
    static let transferLimit = 12
    let base: URL
    private let session: URLSession
    private let gate: TransferGate
    private var imageRequests = 0

    init(base: URL, certificateURL: URL?, connections: Int = GalleryAPI.transferLimit) {
        self.base = base
        gate = TransferGate(limit: connections)
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 25
        config.timeoutIntervalForResource = 90
        config.httpMaximumConnectionsPerHost = max(1, connections)
        let queue = OperationQueue()
        queue.name = "GalleryReader.TLS"
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: config,
                             delegate: LocalTrust(host: base.host ?? "", certificateURL: certificateURL),
                             delegateQueue: queue)
    }

    private func endpoint(_ path: String) throws -> URL {
        guard path.hasPrefix("/offline-api/"), !path.contains(".."),
              let url = URL(string: path, relativeTo: base)?.absoluteURL,
              url.host == base.host, url.scheme == "https", url.port == base.port
        else { throw ReaderError.invalidManifest }
        return url
    }

    private func get<T: Decodable>(_ path: String, as type: T.Type, urgent: Bool = false) async throws -> T {
        try await gate.acquire(path, urgent: urgent)
        do {
            let (data, response) = try await session.data(from: endpoint(path))
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw ReaderError.badResponse((response as? HTTPURLResponse)?.statusCode ?? 0)
            }
            try Task.checkCancellation()
            let result = try JSONDecoder().decode(type, from: data)
            await gate.release()
            return result
        } catch { await gate.release(); throw error }
    }

    func catalog() async throws -> Catalog { try await get("/offline-api/catalog", as: Catalog.self) }

    func manifest(_ item: GalleryItem, urgent: Bool = false) async throws -> GalleryManifest {
        let manifest = try await get("/offline-api/\(item.provider)/\(item.id)/manifest", as: GalleryManifest.self, urgent: urgent)
        try manifest.validate(for: item)
        return manifest
    }

    func prioritize(_ path: String) async { await gate.prioritize(path) }

    func download(_ page: MediaPage, urgent: Bool = false) async throws -> URL {
        try await gate.acquire(page.url, urgent: urgent)
        imageRequests += 1
        var temporaryFile: URL?
        do {
            let (temporary, response) = try await session.download(from: endpoint(page.url))
            temporaryFile = temporary
            try Task.checkCancellation()
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.mimeType?.hasPrefix("image/") == true else {
                throw ReaderError.badResponse((response as? HTTPURLResponse)?.statusCode ?? 0)
            }
            let size = try FileManager.default.attributesOfItem(atPath: temporary.path)[.size] as? NSNumber
            guard size?.int64Value == page.size else { throw ReaderError.wrongSize }
            await gate.release()
            return temporary
        } catch {
            if let temporaryFile { try? FileManager.default.removeItem(at: temporaryFile) }
            await gate.release()
            throw error
        }
    }

    func transferStatistics() async -> (requests: Int, peak: Int) { (imageRequests, await gate.statistics().peak) }
}
