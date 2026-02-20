# SIP-Trunk (fonial) → Asterisk (PJSIP) → Node.js (RTP + WebSocket) → zurück

Ziel: Eingehende Calls über einen fonial SIP-Trunk in Asterisk annehmen, Call-Audio per **ARI External Media** als **RTP** an einen **Node.js**-Service senden und von Node wieder Audio (Test-Beep / später TTS) in den Call einspeisen.

Architektur:

`fonial ↔ Asterisk (PJSIP) ↔ Node.js (RTP UDP) ↔ WebSocket (intern) ↔ TODO: Vosk STT / TODO: TTS / TODO: Business logic ↔ zurück`

Warum RTP zu Asterisk?

- Asterisk External Media ist in der Praxis ein stabiler Weg, Media aus einem Call herauszuleiten.
- Dein Wunsch „am besten WebSocket“ wird erfüllt, indem Node **zusätzlich** eine WebSocket-Schnittstelle bereitstellt (für STT/TTS/Business), während die Asterisk-Anbindung **RTP** ist.

---

## Projektstruktur

- `docker-compose.yml` (Asterisk + Node)
- `asterisk/` (Asterisk Image + Konfig-Templates)
- `node/` (TypeScript Service: ARI Controller + RTP Handler + WS)
- `.env.example` (fonial placeholders + Ports)

---

## Quickstart (Docker Compose, empfohlen)

### 1) Voraussetzungen

- Docker Desktop
- Ein fonial SIP-Trunk (Credentials)

### 2) Konfiguration

1. `.env.example` nach `.env` kopieren und Werte setzen:
   - `FONIAL_USER`, `FONIAL_PASS`
   - `FONIAL_DOMAIN` (z.B. `example.fonial.de`)
   - `FONIAL_REGISTRAR` (typisch `sip.fonial.de`)
   - `INBOUND_DID` (optional – aktuell nur Logging/Platzhalter)

2. Optional (NAT/One-way Audio):
   - `EXTERNAL_ADDRESS` = öffentliche IP/DNS des Hosts
   - `LOCAL_NET` = dein internes Netz (z.B. `192.168.0.0/16`)

Hinweis: Wenn `FONIAL_*` leer bleiben, startet Asterisk trotzdem mit einem lokalen Test-Endpoint:

- User/Pass: `1001` / `1001`
- Context: `from-fonial` (geht ebenfalls in `Stasis(sipws,inbound)`)

### 3) Start

```bash
docker compose up --build
```

Du solltest sehen:

- Node: „WebSocket server listening …“, „RTP listening …“, „Connected to ARI …“
- Asterisk: startet und lädt PJSIP + ARI

### 4) Testcall

- Ruf die DID an, die auf diesen Trunk geroutet ist.
- Der Call geht in den Dialplan `from-fonial` und wird an die ARI-App `sipws` übergeben.
- Node erstellt eine Mixing-Bridge + ExternalMedia-Channel.
- Du solltest nach Call-Annahme einen **kurzen 440Hz Beep** hören (Default `SEND_TEST_BEEP=1`).

#### Lokaler Test ohne fonial (Fallback Endpoint)

Wenn du noch keinen fonial Trunk konfiguriert hast (FONIAL\_\* leer), kannst du mit einem Softphone testen:

- Registrar/Domain: `localhost`
- SIP User: `1001`
- SIP Password: `1001`
- Transport: UDP

Dann rufe `1001` an (oder wähle je nach Softphone „Call self“). Der Dialplan routet in `Stasis(sipws,inbound)`.

---

## WebSocket (für internes Processing)

Node bietet WebSocket auf `ws://localhost:3004` (Docker Compose Host-Port → Container-Port 3000).

- Node broadcastet eingehendes Call-Audio als **PCM 16kHz mono s16le** an alle WS-Clients.
- Clients können **PCM 16kHz s16le** als Binary zurücksenden; Node downsampled auf 8k und sendet es via RTP (μ-law) zurück in den Call.

### Quick Check: WS erreichbar?

Ohne externe Tools kannst du im Browser DevTools testen:

```js
const ws = new WebSocket('ws://localhost:3004')
ws.binaryType = 'arraybuffer'
ws.onmessage = ev => console.log('msg', typeof ev.data, ev.data)
```

(Als Alternative im Terminal: `npx wscat -c ws://localhost:3004` – optional.)

### Quick Check: Roundtrip ohne Browser (WS Client Script)

Dieses Repo enthält einen kleinen CLI-Client, der

- eingehendes **PCM 16kHz** als WAV mitschreibt und
- optional nach kurzer Verzögerung einen **Test-Beep** (16kHz PCM) zurück sendet (der dann im Call hörbar sein sollte).

Wichtig: Du bekommst nur Binary-Audio, wenn ein Call aktiv ist und Node gerade RTP von Asterisk empfängt.

```bash
cd node
npm i
WS_URL=ws://127.0.0.1:3004 RECORD_SECONDS=10 SEND_BEEP=1 npm run ws:client
```

Output:

- WAV-Datei im aktuellen Ordner (z.B. `ws-capture-...wav`)
- Logs mit Byte-Zählern

---

## Audio / Codecs / Resampling

- fonial: typischerweise **PCMA/PCMU (8 kHz)**.
- ExternalMedia in diesem Projekt: **μ-law (PCMU) 8 kHz** RTP zwischen Asterisk ↔ Node (stabil, einfache Implementierung).
- Node stellt WS-Audio als **PCM 16 kHz** bereit (für Vosk).

Resampling:

- Im Code ist ein **minimaler 8k→16k Upsampler** (linear) implementiert.
- Für produktive Qualität: TODO optional `ffmpeg`-basiertes Resampling.

---

## Ports / Firewall

Öffnen (Host):

- SIP: `5060/udp` (und optional `5060/tcp`)
- RTP: `10000-10100/udp` (Asterisk Medien)
- ARI: `8088/tcp` (nur intern nötig; in Docker für Debug exposed)
- Node WS: `3004/tcp`

Node↔Asterisk intern:

- RTP ExternalMedia: `5004/udp` (Node)

---

## Troubleshooting

### 1) Kein Freiton / Stille (Ringing/Early Media)

Symptome:

- Anrufer hört nichts bis zur Annahme.

Hinweise:

- Dieses Demo beantwortet den Call relativ früh per ARI (`channel.answer()`).
- Für echtes Ringback/Early Media: Dialplan/ARI anpassen (z.B. 180 Ringing/183 Session Progress) – TODO.

### 1b) fonial: "Ziel offline"

Das hat fast immer eine dieser Ursachen:

1. Asterisk ist nicht öffentlich erreichbar

- Wenn du bei fonial eine feste Ziel-IP/Port hinterlegt hast, muss `5060/udp` auf deinem Host **öffentlich erreichbar** sein.
- Lokal am Laptop ohne Port-Forwarding oder hinter CGNAT bleibt das Ziel „offline“.
- Lösung: Asterisk auf einen öffentlich erreichbaren Server/VPS deployen oder Port-Forwarding + `.env` `EXTERNAL_ADDRESS` korrekt setzen.

2. Registrierung/Trunk ist noch nicht aktiv konfiguriert

- In diesem Repo werden die Trunk-Credentials nur aus `.env` gelesen (nicht aus `.env.example`).
- Prüfen in Asterisk:
  ```bash
  docker compose exec -T asterisk asterisk -rx "pjsip show registrations"
  ```
- Wenn dort nichts auftaucht, nutzt Asterisk gerade den lokalen Fallback-Endpoint `1001/1001`.

Wichtig für eingehende Calls: Inbound-INVITEs vom Provider werden oft nur korrekt einem Endpoint zugeordnet, wenn ein `identify`-Objekt existiert.

- Setze dafür `.env`: `FONIAL_MATCH=IP1,IP2,...` (SBC IPs / Netze vom Provider; unterstützt IPs und CIDR)
  - Beispiel: `FONIAL_MATCH=92.197.176.0/21`
- Danach: `docker compose up -d --force-recreate`

### 2) One-way Audio / Kein Audio

Checkliste:

- RTP-Ports offen? (`10000-10100/udp`)
- NAT korrekt? Setze `.env`:
  - `EXTERNAL_ADDRESS` (öffentliche IP/DNS)
  - `LOCAL_NET` (dein internes Netz)
- In Docker: Host-Firewall (macOS pf) kann UDP blocken.

### 3) Silence trotz Call-Verbindung (External Media)

- Prüfe Node Logs: „RTP packets received …“
- Wenn keine RTP ankommt:
  - Asterisk ExternalMedia Host/Port korrekt? (Node Service `node:5004` im Compose)
  - UDP-Port `5004` gemappt (`docker-compose.yml`)

### 4) Codec mismatch / Transcoding

- fonial kann PCMA/PCMU anbieten.
- Asterisk wird ggf. transcodieren.
- Dieses Setup erzwingt **ulaw** für ExternalMedia, Asterisk macht Transcoding intern.

### 5) WebSocket Debug

- Node sollte: „WS client connected“ loggen.
- Wenn WS nicht erreichbar:
  - Port `3004/tcp` gemappt?
  - Anderer Dienst belegt `3000`?

---

## Native Asterisk (ohne Docker) – Alternative

Du kannst Asterisk 20/21 nativ installieren und:

- Asterisk-Konfig aus `asterisk/conf/` nach `/etc/asterisk/` übernehmen.
- In `http.conf` / `ari.conf` ARI aktivieren.
- In `pjsip.conf` die fonial Daten eintragen.
- Node lokal starten:

```bash
cd node
npm i
npm run dev
```

Dann `.env` anpassen:

- `ARI_URL=http://127.0.0.1:8088/ari`

---

## TODOs im Code

- `// TODO: VOSK STT` (PCM16 16k streamen, partial/final results)
- `// TODO: TTS` (Text → Audio PCM)
- `// TODO: Business logic` (Prompting/Antwortlogik)

---

## Sicherheit

- ARI Credentials sind Demo-Defaults. Für produktiv: ändern und ARI nicht öffentlich exponieren.
