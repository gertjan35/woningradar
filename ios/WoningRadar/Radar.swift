import Foundation
import CoreLocation
import UserNotifications

enum SettingsKey {
    static let radius = "radius"              // meter
    static let cacheHours = "cacheHours"      // straat opnieuw zoeken na x uur
    static let serpApiKey = "serpApiKey"
    static let serverURL = "serverURL"
    static let accessToken = "accessToken"
    static let background = "background"      // ook zoeken als de app op de achtergrond is
    static let circleMax = "circleMax"        // niets gevonden? zoek in een cirkel tot x meter (0 = uit)

    static func registerDefaults() {
        UserDefaults.standard.register(defaults: [radius: 100, cacheHours: 24, background: true, circleMax: 1000])
    }
}

/// Volgt de GPS-positie, zoekt woningen in de buurt en geeft meldingen.
@MainActor
final class Radar: NSObject, ObservableObject {
    @Published var isRunning = false
    @Published var currentStreet: String?
    @Published var status = "Druk op Start om te beginnen."
    @Published var errorMessage: String?
    @Published var listings: [Listing] = []
    @Published var popup: Listing?
    @Published private(set) var searchesThisMonth = 0

    private let manager = CLLocationManager()
    private let defaults = UserDefaults.standard
    private var lastScanLocation: CLLocation?
    private var lastScanTime = Date.distantPast
    private var scanning = false
    private var circleNote: String?
    private var streetCache: [String: CachedStreet] = [:]

    private struct CachedStreet: Codable {
        let t: Date
        let results: [SearchResult]
    }

    private var radius: Int { max(25, defaults.integer(forKey: SettingsKey.radius)) }

    override init() {
        super.init()
        SettingsKey.registerDefaults()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.activityType = .other
        manager.pausesLocationUpdatesAutomatically = false
        listings = load([Listing].self, key: "listings") ?? []
        streetCache = load([String: CachedStreet].self, key: "streetCache") ?? [:]
        refreshQuota()
    }

    // MARK: Start / stop

    func start() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        let background = defaults.bool(forKey: SettingsKey.background)
        if background { manager.requestAlwaysAuthorization() } else { manager.requestWhenInUseAuthorization() }
        manager.allowsBackgroundLocationUpdates = background
        manager.showsBackgroundLocationIndicator = background
        manager.distanceFilter = max(20, Double(radius) / 4)
        manager.startUpdatingLocation()
        isRunning = true
        status = "Locatie bepalen…"
    }

    func stop() {
        manager.stopUpdatingLocation()
        isRunning = false
        status = "Gestopt."
    }

    func settingsChanged() {
        lastScanLocation = nil
        if isRunning { stop(); start() }
    }

    func clearAll() {
        listings = []
        streetCache = [:]
        save(listings, key: "listings")
        save(streetCache, key: "streetCache")
    }

    // MARK: Zoeken

    private func handle(_ location: CLLocation) async {
        guard location.horizontalAccuracy >= 0, location.horizontalAccuracy < 100 else { return }
        let moved = lastScanLocation.map { location.distance(from: $0) } ?? .infinity
        let minMove = max(25, Double(radius) / 2)
        guard !scanning, moved >= minMove, Date.now.timeIntervalSince(lastScanTime) > 20 else { return }

        scanning = true
        lastScanLocation = location
        lastScanTime = .now
        defer { scanning = false }
        do {
            circleNote = nil
            try await scan(location.coordinate, accuracy: location.horizontalAccuracy)
            errorMessage = nil
            status = "Laatst gezocht om \(Date.now.formatted(date: .omitted, time: .shortened)) · ± \(Int(location.horizontalAccuracy)) m"
                + (circleNote.map { " · \($0)" } ?? "")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func scan(_ pos: CLLocationCoordinate2D, accuracy: Double) async throws {
        let radius = radius
        // Bij onnauwkeurige GPS kijken we iets ruimer rond, anders mist de app straten.
        let searchRadius = radius + Int(min(accuracy, 200))
        let addresses = try await Core.nearbyAddresses(pos, radius: searchRadius)
        currentStreet = addresses.first.map { "\($0.straat), \($0.plaats)" } ?? "Geen adres binnen \(searchRadius) m"

        var hits = 0
        for street in Core.streets(in: addresses) {
            let results = try await search(Core.searchQuery(street), label: street.straat)
            let candidates = Core.parseResults(results, street: street)
            let near = await Core.filterByDistance(candidates, from: pos, radius: radius, addresses: addresses)
            hits += near.count
            near.forEach(remember)
        }

        // Niets in de eigen straten: zoek in steeds grotere cirkels, ongeacht straat of plaats.
        let circleMax = defaults.integer(forKey: SettingsKey.circleMax)
        if hits == 0 && circleMax > radius {
            try await circleSearch(pos, radius: radius, circleMax: circleMax)
        }
        // Bewaar woningen van de afgelopen 7 dagen.
        listings = listings.filter { $0.seen > .now.addingTimeInterval(-7 * 86400) }
            .sorted { $0.seen > $1.seen }
        save(listings, key: "listings")
    }

    /// Zoekt op de postcodegebieden binnen de grootste cirkel en meldt de woningen
    /// in de kleinste cirkel (2×, 4×, … de straal) waarin iets te koop staat.
    private func circleSearch(_ pos: CLLocationCoordinate2D, radius: Int, circleMax: Int) async throws {
        status = "Niets binnen \(radius) m, zoeken in een cirkel…"
        var candidates: [AreaCandidate] = []
        for area in await Core.postcodeAreas(around: pos, radius: circleMax) {
            let results = try await search(Core.areaQuery(area), label: "\(area.pc4) \(area.plaats)")
            candidates += Core.parseAreaResults(results)
        }
        let located = await Core.locate(candidates, from: pos, maxDistance: circleMax)
        for ring in Core.circleRings(radius: radius, max: circleMax) {
            let inRing = located.filter { $0.afstand <= ring }
            if !inRing.isEmpty {
                circleNote = "Niets binnen \(radius) m; dit staat te koop binnen \(ring) m."
                inRing.forEach(remember)
                return
            }
        }
        circleNote = "Ook binnen \(circleMax) m niets gevonden."
    }

    private func remember(_ found: Listing) {
        var w = found
        w.seen = .now
        if let i = listings.firstIndex(where: { $0.id == w.id }) {
            let old = listings[i]
            listings[i] = w
            if old.prijs.value != w.prijs.value { announce(w, priceChanged: true) }
        } else {
            listings.insert(w, at: 0)
            announce(w, priceChanged: false)
        }
    }

    private func search(_ query: String, label: String) async throws -> [SearchResult] {
        let key = query // nieuwe zoekopdracht = nieuwe cache
        let maxAge = Double(max(1, defaults.integer(forKey: SettingsKey.cacheHours))) * 3600
        if let c = streetCache[key], Date.now.timeIntervalSince(c.t) < maxAge { return c.results }

        status = "Zoeken: \(label)…"
        let client = SearchClient(
            serpApiKey: defaults.string(forKey: SettingsKey.serpApiKey) ?? "",
            serverURL: defaults.string(forKey: SettingsKey.serverURL) ?? "",
            accessToken: defaults.string(forKey: SettingsKey.accessToken) ?? "")
        let results = try await client.search(query)
        countSearch()

        streetCache[key] = CachedStreet(t: .now, results: results)
        if streetCache.count > 200 {
            let newest = streetCache.sorted { $0.value.t > $1.value.t }.prefix(200)
            streetCache = Dictionary(uniqueKeysWithValues: newest.map { ($0.key, $0.value) })
        }
        save(streetCache, key: "streetCache")
        return results
    }

    // MARK: Meldingen

    private func announce(_ w: Listing, priceChanged: Bool) {
        popup = w
        let content = UNMutableNotificationContent()
        content.title = priceChanged ? "Prijs gewijzigd: \(w.prijs.label)" : w.prijs.label
        content.body = "\(w.straat) \(w.nummer), \(w.plaats) – \(w.afstand) m (\(w.bron))"
        content.sound = .default
        content.userInfo = ["url": w.link]
        let request = UNNotificationRequest(identifier: w.id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: Teller zoekopdrachten (SerpApi-tegoed)

    private var monthKey: String { "searches-" + Date.now.formatted(.iso8601.year().month()) }

    private func countSearch() {
        defaults.set(defaults.integer(forKey: monthKey) + 1, forKey: monthKey)
        refreshQuota()
    }

    private func refreshQuota() { searchesThisMonth = defaults.integer(forKey: monthKey) }

    // MARK: Opslag

    private func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    private func save<T: Encodable>(_ value: T, key: String) {
        if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: key) }
    }
}

extension Radar: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in await self.handle(location) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.errorMessage = "Locatie niet beschikbaar: \(error.localizedDescription)" }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            if status == .denied || status == .restricted {
                self.errorMessage = "Geen toestemming voor locatie. Zet dit aan via Instellingen → WoningRadar → Locatie."
                self.stop()
            }
        }
    }
}
