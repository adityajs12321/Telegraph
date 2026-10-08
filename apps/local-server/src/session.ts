// Handles login/logout and routes browser commands to the Messenger.

import fs from "node:fs";
import path from "node:path";
import { generateIdentity, isValidName, normalizeEmail, type UiEvent } from "@telegraph/shared";
import { LocalStore, type Account } from "./local-store.js";
import { Messenger } from "./messenger.js";
import { ApiError, ServerApi } from "./server-api.js";
import { ServerSocket } from "./server-socket.js";
import type { UiServer } from "./ui-server.js";

type Reply = (event: UiEvent) => void;

const SIGNED_OUT_ELSEWHERE = "You were signed out because your account logged in on another device.";

export class Session {
  private account: Account | null = null;
  private store: LocalStore | null = null;
  private messenger: Messenger | null = null;
  private profileFile: string;
  private logoutReason: string | null = null;

  constructor(private serverUrl: string, private dataDir: string, profile: string, private ui: UiServer) {
    this.profileFile = path.join(dataDir, "profiles", `${profile}.json`);
    ui.on("connect", (reply) => {
      if (this.messenger) return reply(this.messenger.snapshot());
      reply({ type: "logged-out" });
      if (this.logoutReason) reply({ type: "notice", reason: this.logoutReason });
    });
    ui.on("send", (to, body) => this.messenger?.send(to, body));
    ui.on("addContact", (name, reply) => void this.messenger?.addContact(name, reply));
    ui.on("loginStart", (email, reply) => void this.sendCode(email, reply));
    ui.on("loginVerify", (email, code, name, reply) => void this.login(email, code, name, reply));
    ui.on("logout", () => this.logout());
  }

  // Picks up where the last run left off, if it was logged in.
  start() {
    const name = this.loggedInName();
    if (!name) return;
    const store = this.openStore(name);
    const account = store.account();
    if (account) return this.begin(account, store);
    store.close();
    this.setLoggedInName(null);
  }

  // ---- Login ----

  private async sendCode(rawEmail: string, reply: Reply) {
    const email = normalizeEmail(rawEmail);
    if (this.alreadySignedIn(reply)) return;
    if (!email) return reply({ type: "login", step: "error", reason: "that doesn't look like an email address" });
    try {
      await new ServerApi(this.serverUrl).sendLoginCode(email);
      reply({ type: "login", step: "code-sent" });
    } catch (err) {
      reply({ type: "login", step: "error", reason: describe(err) });
    }
  }

  private async login(rawEmail: string, code: string, name: string | undefined, reply: Reply) {
    const email = normalizeEmail(rawEmail);
    if (this.alreadySignedIn(reply) || !email) return;
    const identity = generateIdentity();
    try {
      const res = await new ServerApi(this.serverUrl).login({
        email,
        code,
        name,
        signPub: identity.signPub,
        boxPub: identity.boxPub,
      });
      if ("needsName" in res) return reply({ type: "login", step: "needs-name" });
      const account: Account = { ...identity, name: res.name, email };
      const store = this.openStore(account.name);
      store.saveAccount(account);
      this.setLoggedInName(account.name);
      this.begin(account, store);
    } catch (err) {
      reply({ type: "login", step: "error", reason: describe(err) });
    }
  }

  // Brings stale pages to the updated state
  private alreadySignedIn(reply: Reply): boolean {
    if (!this.account || !this.messenger) return false;
    reply(this.messenger.snapshot());
    reply({ type: "notice", reason: `You're already signed in as ${this.account.name}.` });
    return true;
  }

  private begin(account: Account, store: LocalStore) {
    const api = new ServerApi(this.serverUrl, account);
    const socket = new ServerSocket(this.serverUrl, api, account.name);
    socket.on("signedOut", () => this.logout(SIGNED_OUT_ELSEWHERE));
    socket.on("rejected", () => void this.checkStillSignedIn(api, account));

    this.account = account;
    this.store = store;
    this.logoutReason = null;
    this.messenger = new Messenger(account, store, api, socket, this.ui);
    this.messenger.start();
    this.ui.broadcast(this.messenger.snapshot());
    console.log(`[${account.name}] logged in as ${account.email}`);
  }

  // The server refused the signature, which means it has different keys for, another device logged in
  private async checkStillSignedIn(api: ServerApi, account: Account) {
    try {
      if ((await api.keysFor(account.name)).signPub === account.signPub) return;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) return;
    }
    if (this.account === account) this.logout(SIGNED_OUT_ELSEWHERE);
  }

  // Messages and contacts stay on this device; logging back in as the same user shows them again.
  private logout(reason?: string) {
    if (!this.account) return;
    console.log(`[${this.account.name}] logged out${reason ? `: ${reason}` : ""}`);
    this.messenger?.stop();
    this.store?.clearAccount(this.account.signPub);
    this.store?.close();
    this.setLoggedInName(null);
    this.messenger = null;
    this.store = null;
    this.account = null;
    this.logoutReason = reason ?? null;
    this.ui.broadcast({ type: "logged-out" });
    if (reason) this.ui.broadcast({ type: "notice", reason });
  }

  // ---- Files ----

  private openStore(name: string) {
    return new LocalStore(path.join(this.dataDir, `${name}.db`));
  }

  private loggedInName(): string | null {
    try {
      const { name } = JSON.parse(fs.readFileSync(this.profileFile, "utf8")) as { name?: unknown };
      return isValidName(name) ? name : null;
    } catch {
      return null;
    }
  }

  private setLoggedInName(name: string | null) {
    if (name === null) return fs.rmSync(this.profileFile, { force: true });
    fs.mkdirSync(path.dirname(this.profileFile), { recursive: true });
    fs.writeFileSync(this.profileFile, JSON.stringify({ name }) + "\n");
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (!(err instanceof TypeError)) console.error(err);
  return "couldn't reach the server; try again";
}
