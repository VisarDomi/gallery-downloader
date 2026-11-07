import Foundation
import KitCore

// One owner for the first-frame mirror and ordered actor writes. Screens submit
// positions; navigation joins the latest write at suspension. Neither caller
// needs the file format, task chain or legacy library-page merge rules.
@MainActor
final class ViewPositions: CheckpointStore {
    private let store: GalleryStore
    let legacyRoutes: [Route]
    private var values: [String: ViewPosition]
    private var pending: Task<Void, Never>?

    init(store: GalleryStore) {
        self.store = store
        let file = store.root.appendingPathComponent("view-state.json")
        let state = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(ViewState.self, from: $0) }
        let initial = state?.version == 1 ? state : nil
        values = initial?.positions ?? [:]
        var routes = initial.flatMap { Route(path: $0.libraryPath) }.map { [$0] } ?? []
        if let initial, let route = Route(path: initial.lastPath), case .reader = route { routes.append(route) }
        legacyRoutes = routes
    }

    func position(for route: Route) -> ViewPosition? { values[route.stateKey] }

    var stripOffsets: [String: Double] {
        var result: [String: Double] = [:]
        for (key, position) in values where key.hasPrefix("library:") && key != "library:1" {
            result.merge(position.strips) { $1 }
        }
        result.merge(values["library:1"]?.strips ?? [:]) { $1 }
        return result
    }

    func save(_ position: ViewPosition) {
        guard let key = ViewPosition.route(position.path), values[key] != position else { return }
        values[key] = position
        let previous = pending
        pending = Task { [store] in
            await previous?.value
            do { try await store.saveViewPosition(JSONEncoder().encode(position)) }
            catch { Log.store.error("Position not saved: \(error.localizedDescription, privacy: .public)") }
        }
    }

    // Writes are already queued by save; the lifecycle lease joins them below.
    func flush() {}
    func finishWrites() async { await pending?.value }
}
