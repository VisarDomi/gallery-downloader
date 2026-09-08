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

actor GalleryAPI {
    static let transferLimit = 12
    let base: URL
    private let session: URLSession
    private let limit: Int
    private var active = 0
    private var peak = 0
    private var imageRequests = 0
    private var waiting: [(urgent: Bool, continuation: CheckedContinuation<Void, Never>)] = []

    init(base: URL, certificateURL: URL?, connections: Int = GalleryAPI.transferLimit) {
        self.base = base
        limit = max(1, connections)
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
        try await acquire(urgent: urgent)
        defer { release() }
        let (data, response) = try await session.data(from: endpoint(path))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw ReaderError.badResponse((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        try Task.checkCancellation()
        return try JSONDecoder().decode(type, from: data)
    }

    func catalog() async throws -> Catalog { try await get("/offline-api/catalog", as: Catalog.self) }

    func manifest(_ item: GalleryItem, urgent: Bool = false) async throws -> GalleryManifest {
        let manifest = try await get("/offline-api/\(item.provider)/\(item.id)/manifest", as: GalleryManifest.self, urgent: urgent)
        try manifest.validate(for: item)
        return manifest
    }

    private func acquire(urgent: Bool) async throws {
        if active < limit { active += 1; peak = max(peak, active) }
        else { await withCheckedContinuation { waiting.append((urgent, $0)) } }
        do { try Task.checkCancellation() }
        catch { release(); throw error }
    }

    private func release() {
        if waiting.isEmpty { active -= 1 }
        else {
            let index = waiting.firstIndex(where: \.urgent) ?? 0
            waiting.remove(at: index).continuation.resume()
        }
    }

    func download(_ page: MediaPage, urgent: Bool = false) async throws -> URL {
        try await acquire(urgent: urgent)
        defer { release() }
        imageRequests += 1
        let (temporary, response) = try await session.download(from: endpoint(page.url))
        do {
            try Task.checkCancellation()
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.mimeType?.hasPrefix("image/") == true else {
                throw ReaderError.badResponse((response as? HTTPURLResponse)?.statusCode ?? 0)
            }
            let size = try FileManager.default.attributesOfItem(atPath: temporary.path)[.size] as? NSNumber
            guard size?.int64Value == page.size else { throw ReaderError.wrongSize }
            return temporary
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }

    func transferStatistics() -> (requests: Int, peak: Int) { (imageRequests, peak) }
}
