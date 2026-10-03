import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var radar: Radar
    @Environment(\.dismiss) private var dismiss
    @AppStorage(SettingsKey.radius) private var radius = 100
    @AppStorage(SettingsKey.cacheHours) private var cacheHours = 24
    @AppStorage(SettingsKey.circleMax) private var circleMax = 1000
    @AppStorage(SettingsKey.interval) private var interval = 60
    @AppStorage(SettingsKey.minMove) private var minMove = 20
    @AppStorage(SettingsKey.background) private var background = true
    @AppStorage(SettingsKey.serpApiKey) private var serpApiKey = ""
    @AppStorage(SettingsKey.serverURL) private var serverURL = ""
    @AppStorage(SettingsKey.accessToken) private var accessToken = ""
    @State private var confirmClear = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Zoeken") {
                    Stepper("Straal: \(radius) m", value: $radius, in: 25...1000, step: 25)
                    Stepper("Controleer elke \(interval) s", value: $interval, in: 15...600, step: 15)
                    Stepper("Opnieuw zoeken na \(minMove) m verplaatsing", value: $minMove, in: 5...500, step: 5)
                    Stepper(circleMax == 0 ? "Cirkelzoeken: uit" : "Niets gevonden? Cirkel tot \(circleMax) m",
                            value: $circleMax, in: 0...5000, step: 100)
                    Stepper("Straat opnieuw zoeken na \(cacheHours) uur", value: $cacheHours, in: 1...168)
                    Toggle("Ook op de achtergrond", isOn: $background)
                }

                Section {
                    SecureField("SerpApi-sleutel", text: $serpApiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("SerpApi")
                } footer: {
                    Text("Gratis sleutel via serpapi.com (250 zoekopdrachten per maand). Elke straat wordt hooguit één keer per ingestelde periode gezocht.")
                }

                Section {
                    TextField("https://woningradar.jouwnaam.workers.dev", text: $serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Toegangscode", text: $accessToken)
                } header: {
                    Text("Eigen server (optioneel)")
                } footer: {
                    Text("Ingevuld? Dan loopt het zoeken via je eigen server en is de SerpApi-sleutel hierboven niet nodig.")
                }

                Section {
                    Button("Lijst en geheugen wissen", role: .destructive) { confirmClear = true }
                }
            }
            .navigationTitle("Instellingen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Klaar") { dismiss() } }
            .confirmationDialog("Alle gevonden woningen en opgeslagen zoekresultaten wissen?",
                                isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Wissen", role: .destructive) { radar.clearAll() }
            }
        }
    }
}
