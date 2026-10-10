// Delivery logic for the logged-in account.

import { isValidName, open, seal, toWire, type ChatMessage, type Envelope, type MessageStatus, type PublicKeys, type UiEvent } from "@telegraph/shared";
import type { Account, LocalStore } from "./local-store";
import { ApiError, type ServerApi } from "./server-api";
import type { ServerSocket } from "./server-socket";

const PENDING_RETRY_MS = 15_000;

export type Emit = (event: UiEvent) => void;

export class Messenger {
  private name: string;
  private peers: string[] = [];
  private inFlight = new Set<string>();
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    private me: Account,
    private store: LocalStore,
    private api: ServerApi,
    private socket: ServerSocket,
    private emit: Emit
  ) {
    this.name = me.name;

    socket.on("open", () => this.run(this.onOpen()));
    socket.on("close", () => this.onClose());
    socket.on("envelope", (env) => this.run(this.receive(env)));
    socket.on("delivered", (id) => this.run(this.setStatus(id, "delivered")));
    socket.on("peers", (peers) => this.setPeers(peers));
    socket.on("typing", (from, typing) => this.emit({ type: "typing", from, typing }));
  }

  start() {
    if (this.stopped) return;
    this.run(this.socket.connect());
    this.retryTimer = setInterval(() => this.run(this.retryPending()), PENDING_RETRY_MS);
    this.run(this.retryPending());
  }

  stop() {
    this.stopped = true;
    clearInterval(this.retryTimer);
    this.socket.close();
  }

  async snapshot(): Promise<UiEvent> {
    return {
      type: "init",
      me: this.name,
      connected: this.socket.connected,
      peers: this.peers,
      contacts: await this.store.contactList(),
      history: await this.store.recentMessages(),
    };
  }

  async send(to: string, body: string) {
    const msg: ChatMessage = {
      type: "message",
      id: crypto.randomUUID(),
      from: this.name,
      to,
      body,
      timestamp: new Date().toISOString(),
    };
    await this.store.saveMessage(msg, "pending");
    await this.listContact(to);
    this.emit({ ...msg, status: "pending" });
    this.run(this.deliver(msg));
  }

  typing(to: string, typing: boolean) {
    this.socket.typing(to, typing);
  }

  // ---- Outgoing ----

  private async deliver(msg: ChatMessage) {
    if (this.stopped || this.inFlight.has(msg.id)) return;
    this.inFlight.add(msg.id);
    try {
      try {
        await this.api.send(await seal(toWire(msg), this.me, (await this.keysFor(msg.to)).boxPub));
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        // They logged in on a new device, so encrypt again for their new key.
        await this.api.send(await seal(toWire(msg), this.me, (await this.refreshKeys(msg.to)).boxPub));
      }
      if (this.stopped) return; // database is closed when logged out
      // Only if still pending: the `delivered` frame can beat this.
      if (await this.store.setStatus(msg.id, "sent", "pending")) this.emit({ type: "status", id: msg.id, status: "sent" });
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof ApiError && err.permanent) {
        await this.setStatus(msg.id, "failed", `${msg.to}: ${err.message}`);
      }
    } finally {
      this.inFlight.delete(msg.id);
    }
  }

  private async retryPending() {
    for (const msg of await this.store.messagesWithStatus("pending")) this.run(this.deliver(msg));
  }

  // ---- Incoming ----

  private async receive(env: Envelope) {
    let msg: ChatMessage;
    try {
      msg = await this.open(env);
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof ApiError && !err.permanent) return; // reconnect if server unreachable
      return this.drop(env, err as Error);
    }
    if (this.stopped) return;
    if (await this.store.saveMessage(msg, "received")) {
      await this.listContact(msg.from);
      this.emit({ ...msg, status: "received" });
    }
    this.socket.ack([env.id]);
  }

  private async open(env: Envelope): Promise<ChatMessage> {
    try {
      return await open(env, this.me, (await this.keysFor(env.from)).signPub);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const pinned = await this.store.contactKeys(env.from);
      const current = await this.refreshKeys(env.from);
      if (current.signPub === pinned?.signPub) throw err;
      return open(env, this.me, current.signPub);
    }
  }

  // Acks an envelope that is unreadable, so it isn't sent twice
  private drop(env: Envelope, err: Error) {
    this.log(`dropping unreadable message ${env.id} from ${env.from}: ${err.message}`);
    this.socket.ack([env.id]);
  }

  // ---- Contacts ----

  async addContact(name: string) {
    const fail = (reason: string) => this.emit({ type: "contact-error", name, reason });
    if (!isValidName(name)) return fail("names are letters, digits, _ or -, max 32 chars");
    if (name === this.name) return fail("that's you");
    // Always ask the server so that only legit users are listed
    let keys: PublicKeys;
    try {
      keys = await this.api.keysFor(name);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return fail(`no user named "${name}"`);
      return fail(`couldn't reach the server to check "${name}"; try again`);
    }
    if (this.stopped) return;
    await this.store.pinContactKeys(name, keys);
    await this.listContact(name);
  }

  private async listContact(name: string) {
    if (await this.store.addContact(name)) this.emit({ type: "contacts", contacts: await this.store.contactList() });
  }

  // ---- Connection ----

  private async onOpen() {
    this.log(`connected to server`);
    this.emit({ type: "connection", connected: true });
    await this.retryPending();
  }

  private onClose() {
    this.setPeers([]);
    this.emit({ type: "connection", connected: false });
  }

  private setPeers(peers: string[]) {
    this.peers = peers;
    this.emit({ type: "peers", peers });
  }

  // ---- Helpers ----

  private async keysFor(name: string): Promise<PublicKeys> {
    const pinned = await this.store.contactKeys(name);
    if (pinned) return pinned;
    const keys = await this.api.keysFor(name);
    await this.store.pinContactKeys(name, keys);
    return keys;
  }

  // Tells the user if their keys ever change
  private async refreshKeys(name: string): Promise<PublicKeys> {
    const keys = await this.api.keysFor(name);
    const pinned = await this.store.contactKeys(name);
    if (pinned?.signPub !== keys.signPub || pinned.boxPub !== keys.boxPub) {
      await this.store.replaceContactKeys(name, keys);
      if (pinned) this.emit({ type: "notice", reason: `${name} logged in on a new device; their key changed` });
    }
    return keys;
  }

  private async setStatus(id: string, status: MessageStatus, reason?: string) {
    if (await this.store.setStatus(id, status)) this.emit({ type: "status", id, status, reason });
  }

  // Runs work in the background. Errors after logout are expected: the database is already closed.
  run(work: Promise<unknown>) {
    work.catch((err) => {
      if (!this.stopped) console.error(`[${this.name}]`, err);
    });
  }

  private log(text: string) {
    console.log(`[${this.name}] ${text}`);
  }
}
