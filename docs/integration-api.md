# NetSeer integration API (design)

**Status:** Draft · **Audience:** NetSeer and companion-app developers · See also [architecture.md](architecture.md)

NetSeer's back end becomes a small local **hub** that companion apps talk to. The first client is
**WaveTop** (the Android wardriving app), with two near-term needs and one later one:

1. **Push a capture** to a running NetSeer with one button — no "save to a file, then open it".
2. **Live view** — stream observations to NetSeer as a wardrive happens and watch the map build.
3. **AI analysis** — ask NetSeer to help interpret a map (later).

All three live in the existing Python/FastAPI back end and reuse the existing parse-and-merge
pipeline ([`graph.py`](../src/netseer/graph.py)); they are independent of the window shell.

**Implementation status**

| Piece | State |
| --- | --- |
| Pairing + device tokens (`/api/v1/pair/start`, `/api/v1/pair`), discovery (`/api/v1/info`) | **shipped** ([`integration.py`](../src/netseer/integration.py)) |
| Capture push (`POST /api/v1/ingest/capture`) | **shipped** — becomes a normal reading job |
| Surfacing a pushed capture in the running UI (`WS /api/v1/events`) | **shipped** — the map opens on its own |
| Settings → Integrations UI (pairing code + device list + revoke) | **shipped** |
| Live-view WebSocket session | planned |
| AI analysis | planned |
| mDNS discovery, LAN binding toggle (pair over the network) | planned |

## Principles

- **Local-first and private.** Default binding stays `127.0.0.1`. Reaching NetSeer from another
  device is **opt-in** and always authenticated.
- **Reuse the pipeline.** Pushed captures and live observations flow through the same graph builder
  and merge logic the file parsers already use.
- **One contract, many clients.** WaveTop, NineLives, and future tools share the schemas below.
- **Additive.** New endpoints live under `/api/v1/…`; today's endpoints are unchanged.

## Transport and binding

| Setting | Default | Opt-in |
| --- | --- | --- |
| Bind address | `127.0.0.1` | `0.0.0.0` (LAN) when the user enables **Allow devices on my network** |
| Auth | required for all `/api/v1/*` | — |
| Discovery | — | mDNS/Bonjour service `_netseer._tcp` advertising host, port, and name |
| TLS | plain HTTP on loopback | self-signed TLS offered when bound to the LAN; the pairing step pins it |

The companion app finds NetSeer by mDNS, by a manually entered `host:port`, or by scanning the
pairing QR (which encodes `host:port` + a one-time code).

## Pairing and auth

A short, user-visible pairing handshake, managed in **Settings → Integrations**:

```mermaid
sequenceDiagram
    participant W as WaveTop
    participant N as NetSeer
    N->>N: User opens Settings → Integrations,<br/>taps "Pair a device" (shows 6-digit code + QR)
    W->>N: POST /api/v1/pair { code, device_name }
    N-->>W: 200 { token, api_version }
    Note over W,N: WaveTop stores the token and uses it on every call
    W->>N: Authorization: Bearer <token>
```

- NetSeer's own window mints the code via `POST /api/v1/pair/start` (guarded by host +
  `X-NetSeer-Window: 1`, so only the app's page can start pairing); the user reads it off the screen.
- The pairing code is short-lived (5 minutes) and single-use.
- The returned **device token** is long-lived, scoped to that device, and listed/revocable in
  Settings → Integrations.
- Every `/api/v1/*` call carries `Authorization: Bearer <token>`.
- API version is negotiated with the `X-NetSeer-API: 1` request header; the server echoes the
  version it served.

## Endpoints

### Discovery

`GET /api/v1/info` → capabilities and version, so a client can feature-detect.

```json
{ "product": "NetSeer", "version": "0.6.4", "api": 1,
  "capabilities": ["ingest.capture", "live.sessions", "ai.analyze"],
  "formats": ["pcap", "pcapng", "kismet", "netxml", "csv", "airodump"] }
```

### 1 — Push a capture

`POST /api/v1/ingest/capture` — send the capture bytes directly; no file on disk.

- Headers: `Authorization`, `Content-Type: application/octet-stream`,
  `X-NetSeer-Format: pcap|pcapng|kismet|netxml|csv|airodump`, `X-NetSeer-Source: WaveTop`,
  optional `X-NetSeer-Name` (what the resulting survey is called on the map).
- Body: raw capture bytes.
- Response `202`: `{ "job_id": "…" }` — ingestion reuses the async job pipeline
  (`/api/parse/jobs/*`), so large pushes stream progress and can be cancelled.

```mermaid
sequenceDiagram
    participant W as WaveTop
    participant N as NetSeer (back end)
    participant U as NetSeer UI
    W->>N: POST /api/v1/ingest/capture (bytes)
    N-->>W: 202 { job_id }
    N->>N: parse → graph.py merges into a new survey
    N->>U: event: capture-received (toast + opens the survey)
```

NetSeer surfaces the arrival to the running UI over the event channel (below), so a pushed capture
appears without the user touching NetSeer.

### 2 — Live view

A **session** groups one wardrive. The client opens it, streams observation deltas over a
WebSocket, and closes it. NetSeer merges each delta into the graph and rebroadcasts to the UI.

- `POST /api/v1/live/sessions` → `{ "session_id": "…", "ws_url": "/api/v1/live/sessions/{id}/stream" }`
- `WS  /api/v1/live/sessions/{id}/stream` → the client sends `observation` messages; the server
  acks and may send back `merged` summaries.
- `DELETE /api/v1/live/sessions/{id}` → end the session (the live survey can then be kept or
  discarded).

```mermaid
sequenceDiagram
    participant W as WaveTop
    participant N as NetSeer (back end)
    participant U as NetSeer UI
    W->>N: POST /api/v1/live/sessions
    N-->>W: { session_id, ws_url }
    loop while driving
        W->>N: WS observation delta (new/updated APs, clients, GPS)
        N->>N: graph.observe_* merges
        N->>U: WS live update (graph delta)
    end
    W->>N: DELETE /api/v1/live/sessions/{id}
```

**NetSeer UI live feed.** The front end subscribes to `WS /api/v1/events` (same-origin, no token —
it is the app) and receives `capture-received`, `live-update`, and `session-ended` events, applying
graph deltas to Cytoscape incrementally.

### 3 — AI analysis (later)

`POST /api/v1/ai/analyze` — hand the current graph (or one device) to an LLM for interpretation.

- Body: `{ "scope": "graph" | "device", "target": "<node id>", "question": "optional free text" }`
- Response: a streamed answer (SSE/`text/event-stream`).
- The API key lives **only on the back end** (env `NETSEER_AI_KEY`); the client never holds it.
- **Opt-in and transparent:** what gets sent is a *summary* of the map (device kinds, services,
  findings) — never raw packets or payloads — and the UI states this before the first call.

## Shared schemas

### Observation delta (live and batch)

```json
{
  "type": "observation",
  "ts": "2026-10-07T18:30:00Z",
  "devices": [
    {
      "mac": "AA:BB:CC:DD:EE:FF",
      "kind": "ap",                 // ap | client | bridge | unknown
      "ssid": "CoffeeShop",
      "channel": 6,
      "band": "2.4",                // 2.4 | 5 | 6
      "security": "wpa2",           // open | wep | wpa | wpa2 | wpa3 | owe
      "signal_dbm": -62,
      "vendor": "Cisco",
      "seen_at": "2026-10-07T18:29:59Z"
    }
  ],
  "links": [
    { "from": "AA:BB:CC:DD:EE:FF", "to": "11:22:33:44:55:66", "kind": "assoc" }
  ],
  "position": { "lat": 40.0, "lon": -105.0, "alt": 1600, "speed": 12.5, "heading": 270 }
}
```

A **batch push** of a finished wardrive is the same object (or an array of them) sent to
`/api/v1/ingest/observations` for clients that record first and upload later — the field shapes are
identical to the live messages, so one serializer on the client serves both paths.

### Error model

All errors: HTTP status + `{ "error": { "code": "…", "message": "…" } }`. Codes include
`unauthorized`, `pairing_expired`, `unsupported_format`, `payload_too_large`, `rate_limited`.

## Security and privacy

- **Opt-in network exposure.** Binding beyond loopback is off by default and gated behind a clear
  toggle; when off, only apps on the same machine can reach the API.
- **Every request authenticated**; tokens are per-device and revocable.
- **Hosted mode never exposes this.** The public Render copy keeps the integration API disabled —
  it is a desktop/source feature only.
- **AI is opt-in** and sends summaries, not captures.

## Versioning and compatibility

- New surface is under `/api/v1/…` and gated by the `X-NetSeer-API` header.
- Additive changes keep version 1; breaking changes bump to `/api/v2`.
- `GET /api/v1/info` lets clients degrade gracefully against older NetSeer builds.

## Open questions

- mDNS on by default when LAN binding is enabled, or a separate toggle?
- Retention of live surveys — auto-keep, or prompt at session end?
- Rate limits / payload caps for pushed captures over the LAN.
- Whether NineLives should consume the same `ingest`/`live` surface or a narrower one.
