# Telegraph

Telegraph is an end to end encrypted messaging service that works in your browser. Sign in once and use the service for free. Nothing is stored on the cloud (apart from your account details), and your messages stay private and secure.

## Requirements

Node.js 22.5+ (apps use the built-in `node:sqlite` module). The server needs PostgreSQL.

## Project structure

```
apps/
  web/              browser UI (React + Vite)
    src/
      useTelegraph.ts     WebSocket connection to the local app
      Login.tsx           
      Sidebar.tsx         contacts list
      Chat.tsx            conversation with the selected contact
  local-server/     local backend
    src/
      main.ts             entry point
      config.ts           CLI flags / env vars
      session.ts          logged in/out: login, logout, starts and stops the messenger
      messenger.ts        encrypt + send, receive + decrypt + ack, message statuses
      server-api.ts       signed HTTP client for the server
      server-socket.ts    signed WebSocket to the server (reconnects)
      ui-server.ts        HTTP + WebSocket for the browser
      local-store.ts      SQLite: messages, logged-in account, pinned keys, address book
      local-migrations.ts schema changes for the local db
  server/           hosted server: keys, encrypted delivery, docker setup
    src/
      server.ts           
      auth.ts             request signature checks
      login-codes.ts      one-time email codes
      mailer.ts           sends the codes (Resend, or the server log in development)
      hub.ts              live WebSocket connections
      schema.ts           Drizzle table schemas
      store.ts            PostgreSQL queries (Drizzle ORM): identities, envelopes
    drizzle/              generated SQL migrations
packages/
  shared/           @telegraph/shared: wire protocol types + crypto + helper tools
```

`npm run build` compiles everything with TypeScript project references (`tsc -b`), shared first, then builds the web UI with Vite.

## Run locally

```bash
npm install
docker compose up --build # relay server + Postgres
npm run app -- --profile alice --port 3001      # http://localhost:3001
npm run app -- --profile bob   --port 3002      # http://localhost:3002
```

`npm run app` rebuilds the web UI before starting. To work on the UI with hot reload, run an app and then
`APP_PORT=3001 npm run dev -w @telegraph/web` (Vite forwards `/ws` to that app).

## Accounts

Open the app and log in with your email: the server emails a 6-digit code, and the first time an
email logs in you pick a username.

- Each login makes new keys on that device and replaces the account's keys on the server, so an
  account is logged in on **one device at a time**. Logging in somewhere else signs the other device
  out immediately.
- Contacts notice the new key automatically, and their apps refetch it. Messages that were waiting for the old device are dropped.
- Each user gets their own database, `data/<username>.db`. Logging out only forgets
  that device's keys, so switching users on one app just switches files, and logging back in shows your messages again.
- Codes expire after 10 minutes, allow 5 tries, and can be re-requested every 30 seconds.

## Contacts

Type a name into the box above the contact list and press **Add**. The app asks the server whether
that user exists and only adds them if it does. If the server
can't be reached, nothing is added and you're asked to try again.
Anyone you message, or who messages you, is added to the list automatically.

App options (also readable from env vars `PROFILE`, `PORT`, `SERVER`, `DATA_DIR`):

| flag | default | |
|---|---|---|
| `--profile` | `default` | names this app instance, which remembers who's logged in (`<data-dir>/profiles/<profile>.json`); use a different one per app running on the same machine |
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

1. **Logging in.** `POST /auth/code {email}` emails a code. `POST /auth/login {email, code, signPub, boxPub}`
   (plus `username` for a new account) checks it and stores the device's new public keys (Ed25519 for
   signing, X25519 for encryption) as that account's keys. The email proves who you are, and then the private keys on the device do.
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
{ "id": "…", "from": "alice", "to": "bob", "toKey": "<bob's boxPub>", "epk": "<base64>", "iv": "<base64>", "ciphertext": "<base64>", "tag": "<base64>" }
```

If the recipient has logged in on a new device since, the server answers `409`
and senders's app fetches recipient's new key and encrypts it again.

WebSocket frames. Server → app: `{"type":"envelope","envelope":{…}}`, `{"type":"delivered","id":"…"}`,
`{"type":"peers","peers":["alice","bob"]}`. App → server: `{"type":"ack","ids":["…"]}`. The server closes
the socket with code `4001` when the account logs in on another device.

## Storage

- App: `data/<username>.db` (one per user) holds tables `messages`, `identity` (username, email and this device's
  keys; empty when logged out), `contacts` (pinned keys) and `address_book` (the names in your contact list).
  `data/profiles/<profile>.json` (`{"name":"alice"}`) says which user each app instance is logged in as.
  To change the local schema, append a step to `MIGRATIONS` in `local-migrations.ts`; each db runs the
  steps it hasn't seen yet the next time it's opened.
- Server (PostgreSQL): `identities` (username, email, current public keys), `envelopes` (ciphertext as `jsonb`,
  deleted on ack or after TTL) and `login_codes` (hashed, deleted once used or expired).
