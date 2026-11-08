# Strassenjäger

Forza-artige Erkundungskarte für den Kanton Zürich: Strassen, die du schon gefahren bist, leuchten –
alle anderen sind grau. Mit Statistiken, „Erkunden“-Vorschlägen und Navigation über Google Maps.

```
iPhone (Overland, Hintergrund-GPS) ──► Cloudflare Worker + D1 ──► Web-App (GitHub Pages)
```

Alles kostenlos: GitHub Pages, Cloudflare (Gratis-Tarif, keine Kreditkarte), OpenStreetMap, OpenFreeMap.

## Einrichtung

### 1. Web-App (GitHub Pages)
1. Repository → **Settings → Pages → Source: „GitHub Actions“**.
2. Tab **Actions** → „Bauen & veröffentlichen“ → **Run workflow** (oder einfach pushen).
   Lädt das Strassennetz aus OpenStreetMap (dauert ein paar Minuten) und veröffentlicht die App.
3. App öffnen: `https://bspec141.github.io/Strassenj-ger/`
4. In Safari: **Teilen → Zum Home-Bildschirm**.

Die Strassendaten werden monatlich automatisch aktualisiert.

### 2. Empfänger (Cloudflare Worker)
1. Konto auf <https://dash.cloudflare.com> erstellen (gratis).
2. **Storage & Databases → D1 → Create** → Name `strassenjaeger`.
3. **Workers & Pages → Create → Worker** („Hello World“) → Name `strassenjaeger` → **Deploy**.
4. **Edit code** → Inhalt von [`worker/worker.js`](worker/worker.js) komplett einfügen → **Deploy**.
5. Worker → **Settings → Bindings → Add → D1 database** → Variablenname `DB`, Datenbank `strassenjaeger`.
6. In der Web-App unter ⚙ Einstellungen bei „Token“ auf **Neu** tippen und den Token kopieren.
7. Worker → **Settings → Variables and Secrets → Add** → Typ *Secret*, Name `TOKEN`, Wert = dein Token.
8. In der Web-App die Worker-URL (`https://strassenjaeger.DEINNAME.workers.dev`) eintragen → **Speichern & testen**.

### 3. Overland (GPS-Aufzeichnung)
1. **Overland GPS Tracker** aus dem App Store installieren (gratis).
2. Die „Adresse für Overland“ aus den Einstellungen der Web-App kopieren und in Overland als
   **Receiver Endpoint** eintragen.
3. Standortzugriff **„Immer“** erlauben, Tracking einschalten.
4. Empfohlen: Desired Accuracy *Best/10 m*, Activity Type *Automotive*,
   Pause Updates Automatically *an*, Resume with Geofence *an*.

Fertig: Overland schickt die Punkte automatisch, die Web-App holt sie beim Öffnen ab.

## Funktionen
- Erkundete Strassen leuchten (cyan, die letzten 7 Tage orange), unerkundete grau
- **Erkunden**: schlägt die nächste unerkundete Strasse vor → „Navigieren mit Google Maps“
- Antippen einer beliebigen Strasse: Status + „Hierhin navigieren“
- Statistik: % des Kantons, neue km pro Woche, nach Strassentyp, Fahrten, Fahrzeit,
  Höchstgeschwindigkeit, Auto/Motorrad (in der Fahrtenliste auf 🚗 tippen zum Umschalten)
- GPX-Import (z. B. alte Aufzeichnungen)

## Wie „erkundet“ berechnet wird
- Strassen werden in ~50 m-Stücke geteilt. Ein Stück gilt als erkundet, wenn die GPS-Spur
  höchstens 20 m daneben und in Fahrtrichtung der Strasse verläuft.
- Nur Bewegung ab ~8 km/h zählt (Spaziergänge nicht). Velofahrten würden mitzählen.
- Gezählt werden befahrbare Strassen (Autobahn bis Quartierstrasse); Feldwege, Parkplätze
  und private Strassen nicht.

## Lokal testen
```bash
cd public && python3 -m http.server 8000
```
`public/data/roads.json` wird von `scripts/build-roads.mjs` erzeugt (braucht Internet).
