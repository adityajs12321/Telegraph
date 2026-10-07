// Telegraph server: delivers end-to-end encrypted messages between apps.
//
// HTTP (JSON):
//   GET  /health
//   PUT  /keys/:name   register public keys (signed with the key being registered)
//   GET  /keys/:name   look up someone's public keys
//   POST /envelopes    send an envelope (signed, sender = envelope.from)
// WebSocket:
//   GET  /ws           server pushes `envelope`, `delivered` and `peers`; app sends `ack`
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { isValidName, type Envelope, type PublicKeys } from "@telegraph/shared";
import { authenticate, HttpError, type SignedRequest } from "./auth.js";
import { Hub } from "./hub.js";
import { Store } from "./store.js";

const PORT = Number(process.env.PORT ?? 8080);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/telegraph";
const TTL_HOURS = Number(process.env.MESSAGE_TTL_HOURS ?? 24 * 7);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PER_RECIPIENT = 1000;

const store = new Store(DATABASE_URL);
const hub = new Hub();

const signPubFor = async (name: string) => (await store.keysFor(name))?.signPub;

interface Request extends SignedRequest {
  params: string[];
}

type Handler = (req: Request) => Promise<[number, unknown]>;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function nameParam(req: Request): string {
  const name = decodeURIComponent(req.params[0]);
  if (!isValidName(name)) throw new HttpError(400, "invalid name");
  return name;
}

// ---- Routes ----

const health: Handler = async () => [200, { ok: true }];

const getKeys: Handler = async (req) => {
  const name = nameParam(req);
  const keys = await store.keysFor(name);
  if (!keys) throw new HttpError(404, "unknown name");
  return [200, { name, ...keys }];
};

// first come first served:
const putKeys: Handler = async (req) => {
  const name = nameParam(req);
  const keys = json<PublicKeys>(req.body);
  if (typeof keys.signPub !== "string" || typeof keys.boxPub !== "string") {
    throw new HttpError(400, "signPub and boxPub required");
  }
  // Proves the caller holds the private key for the key being registered.
  if ((await authenticate(req, () => keys.signPub)) !== name) throw new HttpError(403, "name mismatch");

  if (await store.register(name, keys)) return [201, { name }];
  const existing = await store.keysFor(name);
  if (existing?.signPub === keys.signPub && existing.boxPub === keys.boxPub) return [200, { name }];
  throw new HttpError(409, "name already registered with different keys");
};

const postEnvelope: Handler = async (req) => {
  const caller = await authenticate(req, signPubFor);
  const env = json<Envelope>(req.body);
  for (const field of ["id", "from", "to", "epk", "iv", "ciphertext", "tag"] as const) {
    if (typeof env[field] !== "string") throw new HttpError(400, `missing ${field}`);
  }
  if (env.from !== caller) throw new HttpError(403, "sender mismatch");
  if (!(await store.keysFor(env.to))) throw new HttpError(404, "unknown recipient");
  if ((await store.countFor(env.to)) >= MAX_PER_RECIPIENT) throw new HttpError(429, "too many undelivered messages for recipient");

  await store.deposit(env);
  hub.send(env.to, { type: "envelope", envelope: env });
  return [201, { id: env.id }];
};

const routes: Array<[method: string, pattern: RegExp, handler: Handler]> = [
  ["GET", /^\/health$/, health],
  ["GET", /^\/keys\/([^/]+)$/, getKeys],
  ["PUT", /^\/keys\/([^/]+)$/, putKeys],
  ["POST", /^\/envelopes$/, postEnvelope],
];

async function dispatch(raw: http.IncomingMessage): Promise<[number, unknown]> {
  const method = raw.method ?? "GET";
  const urlPath = new URL(raw.url ?? "/", "http://x").pathname;

  for (const [m, pattern, handler] of routes) {
    const match = urlPath.match(pattern);
    if (m === method && match) {
      const body = method === "GET" ? "" : await readBody(raw);
      return handler({ headers: raw.headers, method, path: urlPath, params: match.slice(1), body });
    }
  }
  throw new HttpError(404, "not found");
}

// ---- WebSocket ----
// On connect, push everything that arrived while the app was offline.
hub.on("connect", async (name) => {
  try {
    for (const envelope of await store.pendingFor(name)) hub.send(name, { type: "envelope", envelope });
  } catch (err) {
    console.error(`[server] couldn't load pending envelopes for ${name}:`, err);
  }
});

// The recipient saved these, delete them and tell each sender.
// If this fails the envelopes stay stored and are pushed again on the next connect; apps ignore duplicates.
hub.on("ack", async (name, ids) => {
  try {
    for (const { id, sender } of await store.remove(name, ids)) hub.send(sender, { type: "delivered", id });
  } catch (err) {
    console.error(`[server] couldn't remove acked envelopes for ${name}:`, err);
  }
});

const wss = new WebSocketServer({ noServer: true });

async function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  let name: string;
  try {
    const urlPath = new URL(req.url ?? "/", "http://x").pathname;
    if (urlPath !== "/ws") throw new HttpError(404, "not found");
    name = await authenticate({ headers: req.headers, method: "GET", path: urlPath, body: "" }, signPubFor);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => hub.attach(name, ws));
}

// ---- Startup ----
const server = http.createServer(async (req, res) => {
  let status: number;
  let payload: unknown;
  try {
    [status, payload] = await dispatch(req);
  } catch (err) {
    status = err instanceof HttpError ? err.status : 500;
    payload = { error: err instanceof HttpError ? err.message : "internal error" };
    if (status === 500) console.error(err);
  }
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
});
server.on("upgrade", upgrade);

async function purgeExpired() {
  try {
    const purged = await store.purgeOlderThan(new Date(Date.now() - TTL_HOURS * 3600 * 1000));
    if (purged) console.log(`[server] purged ${purged} expired envelope(s)`);
  } catch (err) {
    console.error("[server] purge failed:", err);
  }
}

await store.migrate();
void purgeExpired();
setInterval(purgeExpired, 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  const db = new URL(DATABASE_URL);
  console.log(`[server] listening on http://localhost:${PORT} (db: ${db.host}${db.pathname}, ttl: ${TTL_HOURS}h)`);
});
