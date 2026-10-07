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
  if (!verifyData(requestDigest(req.method, req.path, ts, req.body), sig, key)) {
    throw new HttpError(401, "bad signature");
  }
  return name;
}
