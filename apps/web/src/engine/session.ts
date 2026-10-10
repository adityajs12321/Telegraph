// Handles login/logout and routes UI commands to the Messenger. Runs in the browser tab.

import { generateIdentity, isValidName, normalizeEmail, type UiCommand } from "@telegraph/shared";
import { LocalStore, type Account } from "./local-store";
import { Messenger, type Emit } from "./messenger";
import { ApiError, ServerApi } from "./server-api";
import { ServerSocket } from "./server-socket";

const SERVER_URL = ((import.meta.env.VITE_SERVER_URL as string | undefined) || "http://localhost:8080").replace(/\/+$/, "");

// localStorage key naming the user this browser is logged in as
const LOGGED_IN_KEY = "telegraph:logged-in";

const SIGNED_OUT_ELSEWHERE = "You were signed out because your account logged in on another device.";
const NOT_PERSISTED =
  "Your browser didn't allow persistent storage, so it may clear your messages and keys if it runs low on space.";

export class Session {
  private account: Account | null = null;
  private store: LocalStore | null = null;
  private messenger: Messenger | null = null;
  private closed = false;

  constructor(private emit: Emit) {}

  async start() {
    const name = loggedInName();
    if (name) {
      try {
        const store = await LocalStore.open(name);
        const account = await store.account();
        if (account) return await this.begin(account, store, false);
        store.close();
        setLoggedInName(null);
      } catch (err) {
        console.error(err);
        if (this.closed) return;
        this.emit({ type: "logged-out" });
        return this.emit({ type: "notice", reason: `Couldn't open this browser's saved data: ${(err as Error).message}` });
      }
    }
    if (!this.closed) this.emit({ type: "logged-out" });
  }

  // The tab is closing, stop without logging out.
  shutdown() {
    this.closed = true;
    this.messenger?.stop();
    this.store?.close();
    this.messenger = null;
    this.store = null;
    this.account = null;
  }

  command(cmd: UiCommand) {
    if (this.closed) return;
    switch (cmd.type) {
      case "send": {
        const to = cmd.to.trim();
        if (to && cmd.body.trim()) this.messenger?.run(this.messenger.send(to, cmd.body));
        break;
      }
      case "typing":
        this.messenger?.typing(cmd.to, cmd.typing);
        break;
      case "add-contact":
        this.messenger?.run(this.messenger.addContact(cmd.name.trim()));
        break;
      case "login-start":
        void this.sendCode(cmd.email);
        break;
      case "login-verify":
        void this.login(cmd.email, cmd.code.trim(), cmd.name?.trim());
        break;
      case "logout":
        this.logout();
        break;
    }
  }

  // ---- Login ----

  private async sendCode(rawEmail: string) {
    const email = normalizeEmail(rawEmail);
    if (this.alreadySignedIn()) return;
    if (!email) return this.emit({ type: "login", step: "error", reason: "that doesn't look like an email address" });
    try {
      await new ServerApi(SERVER_URL).sendLoginCode(email);
      this.emit({ type: "login", step: "code-sent" });
    } catch (err) {
      this.emit({ type: "login", step: "error", reason: describe(err) });
    }
  }

  private async login(rawEmail: string, code: string, name: string | undefined) {
    const email = normalizeEmail(rawEmail);
    if (this.alreadySignedIn() || !email) return;
    try {
      const identity = await generateIdentity();
      const res = await new ServerApi(SERVER_URL).login({
        email,
        code,
        name,
        signPub: identity.signPub,
        boxPub: identity.boxPub,
      });
      if ("needsName" in res) return this.emit({ type: "login", step: "needs-name" });
      const account: Account = { ...identity, name: res.name, email };
      const store = await LocalStore.open(account.name);
      await store.saveAccount(account);
      setLoggedInName(account.name);
      await this.begin(account, store, true);
    } catch (err) {
      this.emit({ type: "login", step: "error", reason: describe(err) });
    }
  }

  private alreadySignedIn(): boolean {
    if (!this.account) return false;
    this.emit({ type: "notice", reason: `You're already signed in as ${this.account.name}.` });
    return true;
  }

  private async begin(account: Account, store: LocalStore, fresh: boolean) {
    if (this.closed) return store.close();
    const api = new ServerApi(SERVER_URL, account);
    const socket = new ServerSocket(SERVER_URL, api, account.name);
    socket.on("signedOut", () => this.logout(SIGNED_OUT_ELSEWHERE));
    socket.on("rejected", () => void this.checkStillSignedIn(api, account));

    const messenger = new Messenger(account, store, api, socket, this.emit);
    this.account = account;
    this.store = store;
    this.messenger = messenger;
    this.emit(await messenger.snapshot());
    messenger.start();
    void this.persistStorage(fresh);
    console.log(`[${account.name}] logged in as ${account.email}`);
  }

  // Asks the browser not to evict this site's data when the device runs low on space.
  private async persistStorage(warn: boolean) {
    try {
      if (await navigator.storage.persisted()) return;
      if (!(await navigator.storage.persist()) && warn && !this.closed) this.emit({ type: "notice", reason: NOT_PERSISTED });
    } catch {
      // Storage API unavailable
    }
  }

  // The server refused our connection, which may mean another device logged in and replaced our keys
  private async checkStillSignedIn(api: ServerApi, account: Account) {
    try {
      if ((await api.keysFor(account.name)).signPub === account.signPub) return;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) return;
    }
    if (this.account === account) this.logout(SIGNED_OUT_ELSEWHERE);
  }

  private logout(reason?: string) {
    if (!this.account) return;
    console.log(`[${this.account.name}] logged out${reason ? `: ${reason}` : ""}`);
    this.messenger?.stop();
    const store = this.store;
    store
      ?.clearAccount(this.account.signPub)
      .catch((err) => console.error(err))
      .finally(() => store.close());
    setLoggedInName(null);
    this.messenger = null;
    this.store = null;
    this.account = null;
    this.emit({ type: "logged-out" });
    if (reason) this.emit({ type: "notice", reason });
  }
}

function loggedInName(): string | null {
  try {
    const name = localStorage.getItem(LOGGED_IN_KEY);
    return isValidName(name) ? name : null;
  } catch {
    return null;
  }
}

function setLoggedInName(name: string | null) {
  try {
    if (name === null) localStorage.removeItem(LOGGED_IN_KEY);
    else localStorage.setItem(LOGGED_IN_KEY, name);
  } catch {
    // Storage blocked
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (!(err instanceof TypeError)) console.error(err);
  return "couldn't reach the server; try again";
}
