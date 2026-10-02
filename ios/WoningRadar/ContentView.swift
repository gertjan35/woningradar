import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var radar: Radar
    @AppStorage(SettingsKey.radius) private var radius = 100
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Je bent in").font(.subheadline).foregroundStyle(.secondary)
                        Text(radar.currentStreet ?? "–").font(.title2.weight(.semibold))
                        Text(radar.status).font(.footnote).foregroundStyle(.secondary)
                        if let error = radar.errorMessage {
                            Text(error).font(.footnote).foregroundStyle(.orange)
                        }
                    }
                    .padding(.vertical, 4)

                    Button {
                        radar.isRunning ? radar.stop() : radar.start()
                    } label: {
                        Text(radar.isRunning ? "Stop" : "Start")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }

                Section {
                    if radar.listings.isEmpty {
                        Text("Nog niets gevonden.").foregroundStyle(.secondary)
                    }
                    ForEach(radar.listings) { w in
                        if let url = URL(string: w.link) {
                            Link(destination: url) { ListingRow(listing: w) }
                        }
                    }
                } header: {
                    Text("Te koop binnen \(radius) m")
                } footer: {
                    Text("\(radar.searchesThisMonth) zoekopdrachten deze maand")
                }
            }
            .navigationTitle("WoningRadar")
            .toolbar {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Instellingen")
            }
            .sheet(isPresented: $showSettings, onDismiss: radar.settingsChanged) {
                SettingsView()
            }
        }
        .overlay(alignment: .top) {
            if let w = radar.popup {
                PopupView(listing: w) { radar.popup = nil }
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: w.id) {
                        try? await Task.sleep(for: .seconds(12))
                        if radar.popup?.id == w.id { radar.popup = nil }
                    }
            }
        }
        .animation(.spring, value: radar.popup)
    }
}

struct ListingRow: View {
    let listing: Listing

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(listing.straat) \(listing.nummer), \(listing.plaats)")
            Text(listing.prijs.label).font(.headline).foregroundStyle(.primary)
            Text("\(listing.afstand) m · \(listing.bron) · \(listing.seen.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct PopupView: View {
    let listing: Listing
    let dismiss: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(listing.prijs.label).font(.title3.bold())
            Text("\(listing.straat) \(listing.nummer), \(listing.plaats) – \(listing.afstand) m (\(listing.bron))")
                .font(.subheadline)
            Button("Bekijk") {
                if let url = URL(string: listing.link) { openURL(url) }
                dismiss()
            }
            .font(.subheadline.bold())
            .foregroundStyle(.white)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.teal.gradient, in: RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 12)
        .onTapGesture(perform: dismiss)
    }
}
