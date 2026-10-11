import Foundation
import KitCore

// Galleries keep downloading while the app is away: locked, in the background, or closed by iOS.
// When the app leaves the screen, the unfinished pages (priority galleries first, previews before
// originals) go to a background URLSession, which iOS runs outside the app; each file is committed
// to its gallery folder exactly as GalleryStore commits it (expected size, atomic rename). Back on
// screen the remaining transfers are cancelled and GalleryStore's own downloads carry on, counting
// the committed files as saved. Transfers are handed over while the app is still active: iOS
// defers ones started from the background at its discretion. Only the PC may be asked, with the
// app's bundled local CA (LocalTrust).
final class BackgroundDownloads: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    struct Item: Sendable { let path: String; let file: String; let size: Int64 }
    private let root: URL
    private let base: URL
    private let trust: LocalTrust
    private let lock = NSLock()
    private struct Completion: @unchecked Sendable { let call: () -> Void }
    private var finishEvents: Completion?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: (Bundle.main.bundleIdentifier ?? "gallery") + ".pages")
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.httpMaximumConnectionsPerHost = GalleryAPI.transferLimit
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    init(root: URL, base: URL, certificateURL: URL?) {
        self.root = root
        self.base = base
        trust = LocalTrust(host: base.host ?? "", certificateURL: certificateURL)
        super.init()
        _ = session // Reconnects to transfers that ran while the app was closed.
    }

    // iOS relaunched the app to deliver finished transfers; it waits for this handler.
    func handleEvents(_ completion: @escaping () -> Void) {
        lock.withLock { finishEvents = Completion(call: completion) }
        _ = session
    }

    func handOff(_ items: [Item]) async {
        let running = Set(await session.allTasks.compactMap { $0.taskDescription.flatMap(Self.decode)?.file })
        for item in items where !running.contains(item.file) {
            guard item.path.hasPrefix("/offline-api/"), !item.path.contains(".."),
                  let url = URL(string: item.path, relativeTo: base)?.absoluteURL, url.host == base.host else { continue }
            let task = session.downloadTask(with: url)
            task.taskDescription = [item.file, String(item.size)].joined(separator: "\n")
            task.resume()
        }
    }

    func reclaim() async {
        for task in await session.allTasks { task.cancel() }
    }

    private static func decode(_ description: String) -> (file: String, size: Int64)? {
        let parts = description.components(separatedBy: "\n")
        guard parts.count == 2, let size = Int64(parts[1]), !parts[0].hasPrefix("/"),
              !parts[0].split(separator: "/").contains("..") else { return nil }
        return (parts[0], size)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        trust.urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let item = downloadTask.taskDescription.flatMap(Self.decode),
              let http = downloadTask.response as? HTTPURLResponse, http.statusCode == 200,
              http.mimeType?.hasPrefix("image/") == true else { return }
        do { try DurableFile.commit(location, to: root.appendingPathComponent(item.file), expectedSize: item.size) }
        catch { print("Background page:", error.localizedDescription) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error as? URLError, error.code != .cancelled { print("Background page failed:", error.localizedDescription) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = lock.withLock { () -> Completion? in
            defer { finishEvents = nil }
            return finishEvents
        }
        if let completion { DispatchQueue.main.async { completion.call() } }
    }
}
