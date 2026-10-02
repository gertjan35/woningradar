import Foundation
import CoreLocation

// Kernlogica, gelijk aan web/core.js (daar staan de tests).

struct NearbyAddress: Codable, Hashable {
    let straat: String
    let nummer: Int
    let plaats: String
    let afstand: Double
}

struct Street: Hashable {
    let straat: String
    let plaats: String
}

struct Price: Codable, Hashable {
    let value: Int
    let label: String
}

struct Listing: Codable, Identifiable, Hashable {
    var id: String { "\(straat)|\(nummer)|\(plaats)".lowercased() }
    let straat: String
    let nummer: Int
    let plaats: String
    let prijs: Price
    let link: String
    let bron: String
    var afstand: Int = 0
    var seen: Date = .now
}

struct SearchResult: Codable {
    let title: String?
    let link: String?
    let snippet: String?
    let richSnippet: JSONValue?

    enum CodingKeys: String, CodingKey {
        case title, link, snippet
        case richSnippet = "rich_snippet"
    }
}

/// Willekeurige JSON (voor rich_snippet), zodat we de tekst kunnen doorzoeken.
enum JSONValue: Codable, Hashable {
    case string(String), number(Double), bool(Bool), array([JSONValue]), object([String: JSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }

    var text: String {
        switch self {
        case .string(let v): return v
        case .number(let v): return String(v)
        case .bool(let v): return String(v)
        case .array(let v): return v.map(\.text).joined(separator: " ")
        case .object(let v): return v.values.map(\.text).joined(separator: " ")
        case .null: return ""
        }
    }
}

enum Core {
    static let pdok = "https://api.pdok.nl/bzk/locatieserver/search/v3_1"

    static func searchQuery(_ s: Street) -> String {
        "\"\(s.straat)\" \(s.plaats) koopwoning te koop"
    }

    // MARK: PDOK

    private struct PDOKResponse: Decodable {
        struct Inner: Decodable { let docs: [Doc] }
        struct Doc: Decodable {
            let straatnaam: String?
            let huisnummer: Int?
            let woonplaatsnaam: String?
            let afstand: Double?
            let centroide_ll: String?
        }
        let response: Inner
    }

    /// Adressen binnen `radius` meter, dichtstbijzijnde eerst.
    static func nearbyAddresses(_ c: CLLocationCoordinate2D, radius: Int) async throws -> [NearbyAddress] {
        let url = URL(string: "\(pdok)/reverse?lat=\(c.latitude)&lon=\(c.longitude)&type=adres&distance=\(radius)&rows=100")!
        let (data, _) = try await URLSession.shared.data(from: url)
        let docs = try JSONDecoder().decode(PDOKResponse.self, from: data).response.docs
        return docs.compactMap { d in
            guard let s = d.straatnaam, let n = d.huisnummer, let p = d.woonplaatsnaam else { return nil }
            return NearbyAddress(straat: s, nummer: n, plaats: p, afstand: d.afstand ?? 0)
        }
        .sorted { $0.afstand < $1.afstand }
    }

    static func streets(in addresses: [NearbyAddress]) -> [Street] {
        var seen = Set<Street>()
        var out: [Street] = []
        for a in addresses {
            let s = Street(straat: a.straat, plaats: a.plaats)
            if seen.insert(s).inserted { out.append(s) }
        }
        return out
    }

    static func geocode(straat: String, nummer: Int, plaats: String) async -> CLLocationCoordinate2D? {
        var comps = URLComponents(string: "\(pdok)/free")!
        comps.queryItems = [
            URLQueryItem(name: "q", value: "\(straat) \(nummer) \(plaats)"),
            URLQueryItem(name: "fq", value: "type:adres"),
            URLQueryItem(name: "rows", value: "1"),
        ]
        guard let (data, _) = try? await URLSession.shared.data(from: comps.url!),
              let doc = try? JSONDecoder().decode(PDOKResponse.self, from: data).response.docs.first,
              doc.straatnaam?.lowercased() == straat.lowercased(), doc.huisnummer == nummer,
              let wkt = doc.centroide_ll
        else { return nil }
        return parsePoint(wkt)
    }

    static func parsePoint(_ wkt: String) -> CLLocationCoordinate2D? {
        guard let m = wkt.firstMatch(of: #/POINT\(([-\d.]+) ([-\d.]+)\)/#),
              let lon = Double(m.1), let lat = Double(m.2) else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    // MARK: Zoekresultaten uitlezen

    static func extractPrice(_ text: String) -> Price? {
        let re = #/€\s?(\d{1,3}(?:[.\s]\d{3})+|\d{5,})(?:,-)?(\s*(?:k\.k\.|v\.o\.n\.|kosten koper|vrij op naam))?/#
            .ignoresCase()
        for m in text.matches(of: re) {
            let digits = m.1.filter(\.isNumber)
            guard let value = Int(digits) else { continue }
            let after = text[m.range.upperBound...].prefix(20).lowercased()
            if after.firstMatch(of: #/^\s*(per maand|p\/m|\/\s*m|\/mnd|per mnd)/#) != nil { continue }
            guard (25_000...50_000_000).contains(value) else { continue }
            let suffix = m.2.map { " " + $0.trimmingCharacters(in: .whitespaces) } ?? ""
            return Price(value: value, label: "€ \(formatNumber(value))\(suffix)")
        }
        return nil
    }

    static func formatNumber(_ v: Int) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "nl_NL")
        f.numberStyle = .decimal
        return f.string(from: NSNumber(value: v)) ?? String(v)
    }

    static func extractNumbers(_ text: String, straat: String) -> [Int] {
        let escaped = NSRegularExpression.escapedPattern(for: straat)
        guard let re = try? NSRegularExpression(pattern: "\(escaped)\\s+(\\d{1,5})(?!\\d)", options: .caseInsensitive)
        else { return [] }
        let ns = text as NSString
        var out: [Int] = []
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if let n = Int(ns.substring(with: m.range(at: 1))), !out.contains(n) { out.append(n) }
        }
        return out
    }

    static func parseResults(_ results: [SearchResult], street: Street) -> [Listing] {
        var out: [Listing] = []
        for r in results {
            let text = [r.title, r.snippet, r.richSnippet?.text].compactMap { $0 }.joined(separator: " • ")
            let lower = text.lowercased()
            if lower.firstMatch(of: #/\bverkocht\b/#) != nil { continue }
            if lower.firstMatch(of: #/\bte huur\b|\bhuurwoning\b|\bhuurprijs\b/#) != nil { continue }
            let nums = extractNumbers(text, straat: street.straat)
            guard nums.count == 1, let prijs = extractPrice(text), let link = r.link else { continue }
            let host = URL(string: link)?.host()?.replacingOccurrences(of: "www.", with: "") ?? ""
            let l = Listing(straat: street.straat, nummer: nums[0], plaats: street.plaats,
                            prijs: prijs, link: link, bron: host)
            if !out.contains(where: { $0.id == l.id }) { out.append(l) }
        }
        return out
    }

    static func filterByDistance(_ candidates: [Listing], from pos: CLLocationCoordinate2D,
                                 radius: Int, addresses: [NearbyAddress]) async -> [Listing] {
        var kept: [Listing] = []
        for var w in candidates {
            var afstand = addresses.first {
                $0.straat.lowercased() == w.straat.lowercased() && $0.plaats == w.plaats && $0.nummer == w.nummer
            }?.afstand
            if afstand == nil, let p = await geocode(straat: w.straat, nummer: w.nummer, plaats: w.plaats) {
                afstand = CLLocation(latitude: pos.latitude, longitude: pos.longitude)
                    .distance(from: CLLocation(latitude: p.latitude, longitude: p.longitude))
            }
            guard let a = afstand, a <= Double(radius) else { continue }
            w.afstand = Int(a.rounded())
            kept.append(w)
        }
        return kept.sorted { $0.afstand < $1.afstand }
    }
}
