import Foundation

/// Haalt Google-resultaten op via SerpApi: rechtstreeks met je eigen
/// API-sleutel, of via de WoningRadar-server (worker/) als die is ingesteld.
struct SearchClient {
    var serpApiKey: String
    var serverURL: String
    var accessToken: String

    struct SearchError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private struct Response: Decodable {
        let organic_results: [SearchResult]?
        let error: String?
    }

    func search(_ query: String) async throws -> [SearchResult] {
        var request: URLRequest
        let server = serverURL.trimmingCharacters(in: .whitespaces)
        if !server.isEmpty {
            guard var comps = URLComponents(string: server) else { throw SearchError(message: "Ongeldige server-URL") }
            comps.path = "/api/search"
            comps.queryItems = [URLQueryItem(name: "q", value: query)]
            guard let url = comps.url else { throw SearchError(message: "Ongeldige server-URL") }
            request = URLRequest(url: url)
            request.setValue(accessToken, forHTTPHeaderField: "x-access-token")
        } else {
            guard !serpApiKey.isEmpty else { throw SearchError(message: "Vul je SerpApi-sleutel in bij Instellingen") }
            var comps = URLComponents(string: "https://serpapi.com/search.json")!
            comps.queryItems = [
                .init(name: "engine", value: "google"),
                .init(name: "q", value: query),
                .init(name: "google_domain", value: "google.nl"),
                .init(name: "gl", value: "nl"),
                .init(name: "hl", value: "nl"),
                .init(name: "num", value: "20"),
                .init(name: "api_key", value: serpApiKey),
            ]
            request = URLRequest(url: comps.url!)
        }
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let decoded = try? JSONDecoder().decode(Response.self, from: data)
        if let err = decoded?.error {
            // SerpApi meldt "geen resultaten" als fout; dat is gewoon een lege lijst.
            if err.localizedCaseInsensitiveContains("returned any results") { return [] }
            throw SearchError(message: err)
        }
        guard (200..<300).contains(status), let decoded else {
            throw SearchError(message: "Zoeken mislukt (\(status))")
        }
        return decoded.organic_results ?? []
    }
}
