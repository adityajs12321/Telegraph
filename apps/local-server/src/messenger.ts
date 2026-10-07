// Delivery logic

import { randomUUID } from "node:crypto";
import { open, seal, toWire, type ChatMessage, type Envelope, type Identity, type MessageStatus, type PublicKeys } from "@telegraph/shared";
import type { LocalStore } from "./local-store.js";
import { ApiError, type ServerApi } from "./server-api.js";
import type { ServerSocket } from "./server-socket.js";
import type { UiServer } from "./ui-server.js";

const REGISTER_RETRY_MS = 10_000;
const PENDING_RETRY_MS = 15_000;

export class Messenger {
  private peers: string[] = [];
  private registered = false;
  private inFlight = new Set<string>();

  constructor(
    private name: string,
    private me: Identity,
    private store: LocalStore,
    private api: ServerApi,
    private socket: ServerSocket,
    private ui: UiServer
  ) {
    ui.on("connect", (reply) =>
      reply({ type: "init", me: name, connected: socket.connected, peers: this.peers, history: store.recentMessages() })
    );
    ui.on("send", (to, body) => this.send(to, body));

    socket.on("open", () => this.onOpen());
    socket.on("close", () => this.onClose());
    socket.on("envelope", (env) => void this.receive(env));
    socket.on("delivered", (id) => this.setStatus(id, "delivered"));
    socket.on("peers", (peers) => this.setPeers(peers));
  }

  start() {
    void this.register();
    setInterval(() => this.retryPending(), PENDING_RETRY_MS);
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
    this.ui.broadcast({ ...msg, status: "pending" });
    void this.deliver(msg);
  }

  // ---- Outgoing ----

  private async deliver(msg: ChatMessage) {
    if (!this.registered || this.inFlight.has(msg.id)) return;
    this.inFlight.add(msg.id);
    try {
      const keys = await this.keysFor(msg.to);
      await this.api.send(seal(toWire(msg), this.me, keys.boxPub));
      // The recipient may already have acked it while we waited for the response.
      if (this.store.message(msg.id)?.status === "pending") this.setStatus(msg.id, "sent");
    } catch (err) {
      if (err instanceof ApiError && err.permanent) {
        this.setStatus(msg.id, "failed", `${msg.to}: ${err.message}`);
      } // otherwise it stays pending and is retried
    } finally {
      this.inFlight.delete(msg.id);
    }
  }

  private retryPending() {
    for (const msg of this.store.messagesWithStatus("pending")) void this.deliver(msg);
  }

  // ---- Incoming ----

  private async receive(env: Envelope) {
    let sender: PublicKeys;
    try {
      sender = await this.keysFor(env.from);
    } catch (err) {
      if (!(err instanceof ApiError && err.permanent)) return; // re-sends on reconnect in case server is down
      return this.drop(env, err);
    }
    try {
      const msg = open(env, this.me, sender.signPub);
      if (this.store.saveMessage(msg, "received")) this.ui.broadcast({ ...msg, status: "received" });
      this.socket.ack([env.id]);
    } catch (err) {
      this.drop(env, err as Error);
    }
  }

  // Acks an envelope that is unreadable, so it isn't sent twice
  private drop(env: Envelope, err: Error) {
    this.log(`dropping unreadable message ${env.id} from ${env.from}: ${err.message}`);
    this.socket.ack([env.id]);
  }

  // ---- Connection ----

  private async register() {
    try {
      await this.api.register();
      this.registered = true;
      this.log(`registered as "${this.name}"`);
      this.socket.connect();
      this.retryPending();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const reason = `the name "${this.name}" is registered to another device; pick a different --name`;
        this.log(reason);
        this.ui.broadcast({ type: "notice", reason });
        return;
      }
      this.log(`server unreachable (${(err as Error).message}); retrying in ${REGISTER_RETRY_MS / 1000}s`);
      setTimeout(() => this.register(), REGISTER_RETRY_MS);
    }
  }

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

  private setStatus(id: string, status: MessageStatus, reason?: string) {
    this.store.setStatus(id, status);
    this.ui.broadcast({ type: "status", id, status, reason });
  }

  private log(text: string) {
    console.log(`[${this.name}] ${text}`);
  }
}
