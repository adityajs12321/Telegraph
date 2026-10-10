// Request authentication

import type { IncomingHttpHeaders } from "node:http";
import { AUTH_HEADERS, requestDigest, verifyData } from "@telegraph/shared";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface SignedRequest {
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
  body: string;
}

// Returns the caller's verified name.
export async function authenticate(
  req: SignedRequest,
  signPubFor: (name: string) => Promise<string | undefined> | string | undefined
): Promise<string> {
  const name = req.headers[AUTH_HEADERS.name];
  const ts = req.headers[AUTH_HEADERS.timestamp];
  const sig = req.headers[AUTH_HEADERS.signature];
  if (typeof name !== "string" || typeof ts !== "string" || typeof sig !== "string") {
    throw new HttpError(401, "missing auth headers");
  }
  // Limits how long a captured request could be replayed.
  if (Math.abs(Date.now() - Number(ts)) > MAX_CLOCK_SKEW_MS) throw new HttpError(401, "stale timestamp");

  const key = await signPubFor(name);
  if (!key) throw new HttpError(401, "unknown identity");
  if (!(await verifyData(await requestDigest(req.method, req.path, ts, req.body), sig, key))) {
    throw new HttpError(401, "bad signature");
  }
  return name;
}

// Remembers accepted signatures until their timestamp goes stale, so each can be used only once.
// Used for the WebSocket, whose signature travels in the URL and can end up in proxy/server logs.
// In memory, so this assumes a single server process.
export class UsedSignatures {
  private expiries = new Map<string, number>();

  constructor() {
    setInterval(() => this.prune(), 60_000).unref();
  }

  // Throws if `sig` was already used; otherwise records it.
  claim(sig: string, ts: string) {
    if (this.expiries.has(sig)) throw new HttpError(401, "signature already used");
    this.expiries.set(sig, Number(ts) + MAX_CLOCK_SKEW_MS);
  }

  private prune() {
    const now = Date.now();
    for (const [sig, expiry] of this.expiries) if (expiry < now) this.expiries.delete(sig);
  }
}
