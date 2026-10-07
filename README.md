# Telegraph

Telegraph is an end to end encrypted messaging service that works in your browser. Sign in once and use the service for free. Nothing is stored on the cloud (apart from your account details), and your messages stay private and secure.

## Requirements

Node.js 22.5+ (apps use the built-in `node:sqlite` module). The server needs PostgreSQL.

## Project structure

```
apps/
  web/              browser UI
  local-server/     local backend
    src/
      main.ts             entry point
      config.ts           CLI flags / env vars
      messenger.ts        encrypt + send, receive + decrypt + ack, message statuses
      server-api.ts       signed HTTP client for the server
      server-socket.ts    signed WebSocket to the server (reconnects)
      ui-server.ts        HTTP + WebSocket for the browser
      local-store.ts      SQLite: messages, identity, contacts
  server/           hosted server: keys, encrypted delivery, docker setup
    src/
      server.ts           
      auth.ts             request signature checks
      hub.ts              live WebSocket connections
      schema.ts           Drizzle table schemas
      store.ts            PostgreSQL queries (Drizzle ORM): identities, envelopes
    drizzle/              generated SQL migrations
packages/
  shared/           @telegraph/shared: wire protocol types + crypto + helper tools
```

`npm run build` compiles everything with TypeScript project references (`tsc -b`), shared first.

## Run locally

```bash
npm install
docker compose up --build # relay server + Postgres
npm run app -- --name alice --port 3001         # http://localhost:3001
npm run app -- --name bob   --port 3002         # http://localhost:3002
```

App options (also readable from env vars `NAME`, `PORT`, `SERVER`, `DATA_DIR`):

| flag | default | |
|---|---|---|
| `--name` | required | your username |
| `--port` | `3000` | local UI port |
| `--server` | `http://localhost:8080` | server URL |
| `--data-dir` | `<repo>/data` | where the local db is stored |

Server env vars: `PORT` (8080), `DATABASE_URL` (`postgres://localhost:5432/telegraph`), `MESSAGE_TTL_HOURS` (default = 1 days).

## How delivery works

1. The app encrypts the message to the recipient's public key and `POST`s it to `/envelopes` (`pending` → `sent`).
2. The server stores the envelope and, if the recipient is connected, pushes it over their WebSocket.
3. The recipient decrypts it, verifies the sender's signature, saves it locally, and **then** sends
   an `ack`. The server deletes the envelope and tells the sender (`delivered`).
4. A recipient who was offline gets every waiting envelope pushed as soon as it reconnects.
5. If the server is unreachable, the message stays `pending` locally and is retried.

Messages are de-duplicated by `id`, so retries and re-deliveries are always safe.

## Authentication

1. **Registering a name.** On startup the app sends `PUT /keys/<name>` with its public keys
   (Ed25519 for signing, X25519 for encryption). The server stores the first keys it sees for a
   name; a different key trying to claim the same name later gets `409`.
2. **Signing every request.** Each request (and the WebSocket connection) carries three headers:

   | header | value |
   |---|---|
   | `X-Telegraph-Name` | `alice` |
   | `X-Telegraph-Timestamp` | current time in ms |
   | `X-Telegraph-Signature` | Ed25519 signature of `METHOD\npath\ntimestamp\nsha256(body)` |

   The server looks up alice's registered public key and checks the signature. Only the holder
   of alice's private key can produce it, and it covers the body, so it can't be reused for a
   different request. Timestamps more than 5 minutes off are rejected, which limits replays (and
   HTTPS stops anyone capturing requests in the first place).
3. **Message-level checks.** Independently of the server, each message is signed by the sender
   inside the encryption, and recipients pin contacts' public keys on first use. Even a malicious
   server can't read messages, forge them, or swap someone's keys after you've talked to them.

## Security model

- Messages are encrypted with ephemeral X25519 + HKDF-SHA256 + AES-256-GCM and signed by the
  sender. The server only sees `id`, `from`, `to` and ciphertext.
- The server sees who talks to whom and when, and who is online (the `peers` list is shared with
  every connected app).

## Message format (JSON)

Message (what the app encrypts, and stores locally):

```json
{
  "type": "message",
  "id": "acf8d5e8-a395-4856-8bbd-d4618fea79e0",
  "from": "alice",
  "to": "bob",
  "body": "hello bob",
  "timestamp": "2026-10-05T19:06:53.611Z"
}
```

Envelope (the message above, encrypted and signed; all the server sees):

```json
{ "id": "…", "from": "alice", "to": "bob", "epk": "<base64>", "iv": "<base64>", "ciphertext": "<base64>", "tag": "<base64>" }
```

WebSocket frames. Server → app: `{"type":"envelope","envelope":{…}}`, `{"type":"delivered","id":"…"}`,
`{"type":"peers","peers":["alice","bob"]}`. App → server: `{"type":"ack","ids":["…"]}`.

## Storage

- App: `data/<name>.db` (repo root) holds tables `messages`, `identity` (your keys) and `contacts` (pinned keys).
- Server (PostgreSQL): `identities` (public keys) and `envelopes` (ciphertext as `jsonb`, deleted on ack or after TTL).
