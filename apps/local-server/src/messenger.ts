// Delivery logic for the logged-in account. Created on login, stopped on logout.

import { randomUUID } from "node:crypto";
import { isValidName, open, seal, toWire, type ChatMessage, type Envelope, type MessageStatus, type PublicKeys, type UiEvent } from "@telegraph/shared";
import type { Account, LocalStore } from "./local-store.js";
import { ApiError, type ServerApi } from "./server-api.js";
import type { ServerSocket } from "./server-socket.js";
import type { UiServer } from "./ui-server.js";

const PENDING_RETRY_MS = 15_000;

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
    private ui: UiServer
  ) {
    this.name = me.name;
    store.addContactsFromMessages(me.name);

    socket.on("open", () => this.onOpen());
    socket.on("close", () => this.onClose());
    socket.on("envelope", (env) => void this.receive(env));
    socket.on("delivered", (id) => this.setStatus(id, "delivered"));
    socket.on("peers", (peers) => this.setPeers(peers));
  }

  start() {
    this.socket.connect();
    this.retryTimer = setInterval(() => this.retryPending(), PENDING_RETRY_MS);
    this.retryPending();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.retryTimer);
    this.socket.close();
  }

  // rework needed
  snapshot(): UiEvent {
    return {
      type: "init",
      me: this.name,
      connected: this.socket.connected,
      peers: this.peers,
      contacts: this.store.contactList(),
      history: this.store.recentMessages(),
    };
  }

  send(to: string, body: string) {
    const msg: ChatMessage = {
      type: "message",
      id: randomUUID(),
      from: this.name,
      to,
      body,
      timestamp: new Date().toISOString(),
    };
    this.store.saveMessage(msg, "pending");
    this.listContact(to);
    this.ui.broadcast({ ...msg, status: "pending" });
    void this.deliver(msg);
  }

  // ---- Outgoing ----

  private async deliver(msg: ChatMessage) {
    if (this.stopped || this.inFlight.has(msg.id)) return;
    this.inFlight.add(msg.id);
    try {
      try {
        await this.api.send(seal(toWire(msg), this.me, (await this.keysFor(msg.to)).boxPub));
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        // They logged in on a new device, so encrypt again for their new key.
        await this.api.send(seal(toWire(msg), this.me, (await this.refreshKeys(msg.to)).boxPub));
      }
      if (this.stopped) return; // database is closed when logged out
      if (this.store.message(msg.id)?.status === "pending") this.setStatus(msg.id, "sent");
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof ApiError && err.permanent) {
        this.setStatus(msg.id, "failed", `${msg.to}: ${err.message}`);
      }
    } finally {
      this.inFlight.delete(msg.id);
    }
  }

  private retryPending() {
    for (const msg of this.store.messagesWithStatus("pending")) void this.deliver(msg);
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
    if (this.store.saveMessage(msg, "received")) {
      this.listContact(msg.from);
      this.ui.broadcast({ ...msg, status: "received" });
    }
    this.socket.ack([env.id]);
  }

  private async open(env: Envelope): Promise<ChatMessage> {
    try {
      return open(env, this.me, (await this.keysFor(env.from)).signPub);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const pinned = this.store.contactKeys(env.from);
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

  async addContact(name: string, reply: (event: UiEvent) => void) {
    const fail = (reason: string) => reply({ type: "contact-error", name, reason });
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
    this.store.pinContactKeys(name, keys);
    this.listContact(name);
  }

  private listContact(name: string) {
    if (this.store.addContact(name)) this.ui.broadcast({ type: "contacts", contacts: this.store.contactList() });
  }

  // ---- Connection ----

  private onOpen() {
    this.log(`connected to server`);
    this.ui.broadcast({ type: "connection", connected: true });
    this.retryPending();
  }

  private onClose() {
    this.setPeers([]);
    this.ui.broadcast({ type: "connection", connected: false });
  }

  private setPeers(peers: string[]) {
    this.peers = peers;
    this.ui.broadcast({ type: "peers", peers });
  }

  // ---- Helpers ----

  private async keysFor(name: string): Promise<PublicKeys> {
    const pinned = this.store.contactKeys(name);
    if (pinned) return pinned;
    const keys = await this.api.keysFor(name);
    this.store.pinContactKeys(name, keys);
    return keys;
  }

  // Tells the user if their keys ever change
  private async refreshKeys(name: string): Promise<PublicKeys> {
    const keys = await this.api.keysFor(name);
    const pinned = this.store.contactKeys(name);
    if (pinned?.signPub !== keys.signPub || pinned.boxPub !== keys.boxPub) {
      this.store.replaceContactKeys(name, keys);
      if (pinned) this.ui.broadcast({ type: "notice", reason: `${name} logged in on a new device; their key changed` });
    }
    return keys;
  }

  private setStatus(id: string, status: MessageStatus, reason?: string) {
    this.store.setStatus(id, status);
    this.ui.broadcast({ type: "status", id, status, reason });
  }

  private log(text: string) {
    console.log(`[${this.name}] ${text}`);
  }
}
