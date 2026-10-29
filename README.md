# Craft Office

WordCraft, GridCraft und DeckCraft aus den [ArtCraft Crafting Apps](https://getartcraft.com/apps)
als Web-Office im Stil von Office 365. Die Apps laufen **nativ im Browser** (Rust → WebAssembly,
gerendert mit WebGPU bzw. WebGL2). Es gibt kein VNC und kein Server-Rendering. Der Server liefert
nur die Dateien aus und speichert die Dokumente.

```
Browser ──► Portal (Node.js, :8080)
             ├─ /                  Anmeldung, „Neu erstellen“, Meine Dateien (Hochladen, Umbenennen, Löschen)
             ├─ /edit.html         Editor-Seite: bettet die App per <iframe> ein
             ├─ /apps/word|grid|deck/   Trunk-Builds der drei Apps (WASM, vorkomprimiert br/gz)
             └─ /api/…             Login und Dateien pro Benutzer (/data/files/<benutzer>/)
```

Die Editor-Seite nutzt die `?host=parent`-Schnittstelle der Apps (postMessage, gleiche Origin):
Die App meldet `ready`, die Seite schickt die Datei (`open`), und jedes Speichern in der App
(`save`) landet über `PUT /api/files/…` auf dem Server. Dazu kommen ein Status für ungespeicherte
Änderungen (`dirty`) und ein Schutz beim Verlassen der Seite.

- **Speichern** überschreibt die geöffnete Datei.
- **Speichern unter** und das erste Speichern eines neuen Dokuments legen eine neue Datei an.
  Ist der Name schon vergeben, wird `(2)`, `(3)` … angehängt.
- **Exporte** (PDF, PNG …) werden als zusätzliche Dateien neben dem Dokument abgelegt.

WordCraft und GridCraft bringen diese Schnittstelle von Haus aus mit. Für DeckCraft ergänzt
[`patches/deckcraft-host-bridge.patch`](patches/deckcraft-host-bridge.patch) sie nach demselben
Protokoll. Dort speichert *Speichern* als .pptx.

## Bauen

```bash
docker build -t craft-office .
```

Die Upstream-Commits sind im [`Dockerfile`](Dockerfile) festgelegt (`WORDCRAFT_REF`,
`GRIDCRAFT_REF`, `DECKCRAFT_REF`). Zum Aktualisieren setzt man die Werte neu oder übergibt sie
per `--build-arg`. Der erste Build dauert lange, weil drei Rust-Workspaces im Release-Modus nach
wasm32 kompiliert werden. Spätere Builds nutzen die BuildKit-Caches.

## Starten

```bash
ADMIN_PASSWORD='ein-langes-passwort' docker compose up -d
```

Beim ersten Start legt das Portal den Benutzer `ADMIN_USER` (Standard: `admin`) an. Weitere
Benutzer oder neue Passwörter:

```bash
docker exec -it craft-office node /opt/portal/server.js adduser anna
```

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `8080` | Port im Container |
| `DATA_DIR` | `/data` | Benutzer, Sitzungsschlüssel, Dateien |
| `ADMIN_USER` / `ADMIN_PASSWORD` | – | Erster Benutzer, solange noch keiner existiert |
| `SESSION_DAYS` | `14` | Wie lange eine Anmeldung gilt |
| `MAX_UPLOAD_MB` | `500` | Größte Datei |
| `PUID` / `PGID` | `99` / `100` | Besitzer von `/data` und Benutzer des Servers |

### Unraid

Das Template liegt unter [`unraid/craft-office.xml`](unraid/craft-office.xml). Zum Installieren
gibt es zwei Wege:

- **Als Template-Repository:** Im Docker-Tab ganz unten bei *Template Repositories*
  `https://github.com/gottschalkfelix4-source/craft-office` eintragen und speichern. Danach
  steht *craft-office* unter *Add Container* → *Template* zur Auswahl.
- **Direkt im Webterminal:**

  ```bash
  wget -O /boot/config/plugins/dockerMan/templates-user/my-craft-office.xml https://raw.githubusercontent.com/gottschalkfelix4-source/craft-office/main/unraid/craft-office.xml
  ```

  Danach *Add Container* → *Template* → *craft-office*.

Im Template muss nur noch `ADMIN_PASSWORD` gesetzt werden. Standardwerte: Port `8095`, Daten
unter `/mnt/user/appdata/craft-office`, `PUID`/`PGID` `99`/`100` (`nobody:users`). Der Container
startet als root, setzt den Besitzer von `/data` auf `PUID:PGID` und läuft danach mit diesen IDs.

Für den Zugriff von außen gehört das Portal hinter einen Reverse Proxy mit HTTPS, zum Beispiel
Zoraxy. Das Portal setzt das Cookie mit `Secure`, wenn der Proxy `X-Forwarded-Proto: https`
mitschickt.

## Browser

Die Apps brauchen WebGPU oder WebGL2. Das können alle aktuellen Versionen von Chrome, Edge,
Firefox und Safari. Die Apps sind laut Upstream **Alpha**-Software. Wichtige Dateien sollte man
deshalb zusätzlich sichern. Gespeichert wird alles unter `/data/files/<benutzer>/`.

## Lokal ohne Docker (Portal entwickeln)

```bash
cd portal
ADMIN_USER=dev ADMIN_PASSWORD=devpass123 APPS_DIR=/pfad/zu/apps node server.js
```

`APPS_DIR` muss die Unterordner `word/`, `grid/` und `deck/` enthalten (die `trunk build`-Ausgaben).

## Lizenzen

WordCraft, GridCraft und DeckCraft stammen von [storytold](https://github.com/storytold) und stehen
unter MIT oder Apache-2.0. Der DeckCraft-Patch in `patches/` steht unter denselben Lizenzen.
