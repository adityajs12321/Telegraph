// HTTP Client

import { AUTH_HEADERS, requestDigest, signData, type Envelope, type Identity, type PublicKeys } from "@telegraph/shared";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }

  // 4xx (other than rate limiting) won't succeed on retry.
  get permanent() {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export class ServerApi {
  constructor(private baseUrl: string, private name: string, private identity: Identity) {}

  register() {
    const keys: PublicKeys = { signPub: this.identity.signPub, boxPub: this.identity.boxPub };
    return this.request("PUT", `/keys/${encodeURIComponent(this.name)}`, keys);
  }

  keysFor(name: string) {
    return this.request<PublicKeys>("GET", `/keys/${encodeURIComponent(name)}`, undefined, false);
  }

  send(env: Envelope) {
    return this.request("POST", "/envelopes", env);
  }

  // Proves this request comes from `name`
  signedHeaders(method: string, path: string, body = ""): Record<string, string> {
    const ts = String(Date.now());
    return {
      [AUTH_HEADERS.name]: this.name,
      [AUTH_HEADERS.timestamp]: ts,
      [AUTH_HEADERS.signature]: signData(requestDigest(method, path, ts, body), this.identity.signPriv),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown, signed = true): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", ...(signed ? this.signedHeaders(method, path, raw) : {}) },
      body: raw || undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
    return data;
  }
}
