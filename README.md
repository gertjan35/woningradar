# WoningRadar

WoningRadar volgt je GPS-positie en bepaalt in welke straat je bent. Daarna zoekt de app via Google naar koopwoningen in de straten binnen een instelbare straal (standaard 100 m). Vindt hij een woning, dan zie je een pop-up en krijg je een melding met de vraagprijs.

Er zijn twee versies:

| | Web-app (`web/` + `worker/`) | iPhone-app (`ios/`) |
|---|---|---|
| Nodig | Gratis Cloudflare-account | Mac met Xcode |
| Op de achtergrond | Nee, alleen terwijl de pagina open is | Ja, ook met het scherm uit |
| Melding | Pop-up op het scherm, plus een melding als de app op het beginscherm staat | Echte iOS-melding en een pop-up in de app |

## Hoe het werkt

1. **Positie → straten.** De app stuurt je GPS-positie naar de [PDOK Locatieserver](https://www.pdok.nl/introductie/-/article/pdok-locatieserver) (Kadaster, gratis, geen sleutel nodig). Die geeft alle adressen binnen de straal terug, met de afstand tot jou. Daaruit volgen je huidige straat en alle straten in de buurt.
2. **Straat → Google.** Per straat zoekt de app op Google naar `"Julianalaan" Bedum koopwoning te koop`. Dat gaat via [SerpApi](https://serpapi.com), een dienst die Google-resultaten als data teruggeeft. Google zelf blokkeert automatische zoekopdrachten.
3. **Resultaten uitlezen.** De app haalt uit elk zoekresultaat het huisnummer en de vraagprijs, bijvoorbeeld uit "Julianalaan 12 … € 325.000 k.k.". Resultaten die "verkocht" of "te huur" noemen vallen af, net als overzichtspagina's met meerdere huisnummers.
4. **Afstand.** Het gevonden adres wordt vergeleken met de PDOK-adressen uit stap 1. Staat het daar niet tussen, dan zoekt de app de coördinaten van dat adres op. Alleen woningen binnen de straal blijven over.
5. **Melding.** Je krijgt een pop-up en een melding voor elke nieuwe woning, en opnieuw als de vraagprijs verandert.

**Zuinig met je zoektegoed.** Het gratis SerpApi-abonnement geeft 250 zoekopdrachten per maand. Daarom zoekt de app een straat hooguit één keer per 24 uur (instelbaar) en pas opnieuw als je minstens de halve straal bent verplaatst. Het aantal zoekopdrachten van deze maand staat in de app.

## Stap 1: SerpApi-sleutel

Maak een gratis account op [serpapi.com](https://serpapi.com) en kopieer je API-sleutel.

## Stap 2a: Web-app

De web-app draait op een Cloudflare Worker. Die serveert de pagina en stuurt de zoekopdrachten door naar SerpApi. Je sleutel blijft daardoor op de server. SerpApi kun je niet rechtstreeks vanuit de browser aanroepen.

```bash
npm install -g wrangler
wrangler login
wrangler secret put SERPAPI_KEY     # plak je SerpApi-sleutel
wrangler secret put ACCESS_TOKEN    # verzin een toegangscode
wrangler deploy
```

Open daarna de getoonde URL (`https://woningradar.<jouwnaam>.workers.dev`) in Safari op je iPhone:

1. Kies **Deel → Zet op beginscherm** en open de app vanaf het beginscherm.
2. Vul bij **Instellingen** je toegangscode in en tik op **Meldingen toestaan**.
3. Tik op **Start** en sta locatie toe.

Houd de app open terwijl je loopt of rijdt. Het scherm blijft dan vanzelf aan.

## Stap 2b: iPhone-app (Xcode)

1. Installeer [Xcode](https://apps.apple.com/app/xcode/id497799835) en [XcodeGen](https://github.com/yonaskolb/XcodeGen):
   ```bash
   brew install xcodegen
   cd ios && xcodegen
   open WoningRadar.xcodeproj
   ```
2. Kies in Xcode bij **Signing & Capabilities** je Apple-account als *Team*. Pas zo nodig de bundle-ID aan, bijvoorbeeld `nl.jouwnaam.woningradar`.
3. Sluit je iPhone aan, kies hem als doel en druk op ▶︎. Op de iPhone moet *Ontwikkelaarsmodus* aan staan (Instellingen → Privacy en beveiliging).
4. Vul in de app bij ⚙︎ je SerpApi-sleutel in, of de URL en toegangscode van je eigen server uit stap 2a. Tik dan op **Start**.
5. Kies **Altijd toestaan** voor locatie, zodat de app ook op de achtergrond werkt.

Met een gratis Apple-account verloopt de app na 7 dagen. Je zet hem dan opnieuw vanuit Xcode op je iPhone. Met een betaald ontwikkelaarsaccount (€ 99 per jaar) is dat niet nodig.

**Batterij:** de app gebruikt nauwkeurige GPS zolang hij aan staat. Zet hem op **Stop** als je hem niet nodig hebt, of zet *Ook op de achtergrond* uit.

**Zonder XcodeGen:** maak in Xcode een nieuw iOS-project *App* (SwiftUI) met de naam WoningRadar en sleep de `.swift`-bestanden uit `ios/WoningRadar/` erin. Doe daarna dit:
- Voeg onder **Signing & Capabilities → + Capability** de capability **Background Modes** toe en vink *Location updates* aan.
- Voeg onder **Info** de sleutels `Privacy - Location When In Use Usage Description` en `Privacy - Location Always and When In Use Usage Description` toe, elk met een korte uitleg.

## Testen

```bash
cd web && node --test
```

De tests controleren de logica die prijzen, huisnummers en afstanden uitleest (`web/core.js`). `ios/WoningRadar/Core.swift` werkt op dezelfde manier.

## Beperkingen

- De app vindt alleen wat Google over een straat laat zien. Woningen die niet in de zoekresultaten staan, of zonder prijs in het fragment, mist hij.
- Op lange straten met veel resultaten kan een woning in de buurt buiten de eerste 20 resultaten vallen.
- Op drukke plekken met meer dan 100 adressen binnen de straal geeft PDOK alleen de dichtstbijzijnde 100 terug. Een straat die alleen verderop in de straal ligt, kan dan ontbreken.
- Prijzen komen uit de zoekfragmenten van Google en kunnen achterlopen op de site zelf. Tik op de woning voor de actuele informatie.
