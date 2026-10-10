// HTTP Client

import {
  AUTH_HEADERS,
  requestDigest,
  signData,
  type Envelope,
  type LoginRequest,
  type LoginResponse,
  type PublicKeys,
} from "@telegraph/shared";
import type { Account } from "./local-store";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }

  get permanent() {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export class ServerApi {
  constructor(private baseUrl: string, private account: Account | null = null) {}

  sendLoginCode(email: string) {
    return this.request("POST", "/auth/code", { email }, false);
  }

  login(req: LoginRequest) {
    return this.request<LoginResponse>("POST", "/auth/login", req, false);
  }

  keysFor(name: string) {
    return this.request<PublicKeys>("GET", `/keys/${encodeURIComponent(name)}`, undefined, false);
  }

  send(env: Envelope) {
    return this.request("POST", "/envelopes", env);
  }

  // Proves this request comes from `name`
  async signedHeaders(method: string, path: string, body = ""): Promise<Record<string, string>> {
    if (!this.account) throw new Error("not logged in");
    const ts = String(Date.now());
    return {
      [AUTH_HEADERS.name]: this.account.name,
      [AUTH_HEADERS.timestamp]: ts,
      [AUTH_HEADERS.signature]: await signData(await requestDigest(method, path, ts, body), this.account.signPriv),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown, signed = true): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", ...(signed ? await this.signedHeaders(method, path, raw) : {}) },
      body: raw || undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
    return data;
  }
}
