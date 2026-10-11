// Live WebSocket connections, one per client.

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { isValidName, parseJson, SIGNED_OUT_CLOSE_CODE, type ClientFrame, type ServerFrame } from "@telegraph/shared";

const PING_MS = 30_000;

interface HubEvents {
  connect: [name: string];
  ack: [name: string, ids: string[]];
  receiptAck: [name: string, ids: string[]];
}

export class Hub extends EventEmitter<HubEvents> {
  private sockets = new Map<string, WebSocket>();
  private alive = new WeakSet<WebSocket>();
  private watching = new Map<string, string>(); // watcher -> the user they watch
  private watchers = new Map<string, Set<string>>(); // user -> who is watching them

  constructor() {
    super();
    // Pings keep idle connections open through proxies and drop ones that stopped answering.
    setInterval(() => this.pingAll(), PING_MS).unref();
  }

  // client must already be authenticated.
  attach(name: string, ws: WebSocket) {
    this.sockets.get(name)?.close(4000, "replaced by a newer connection");
    this.watch(name, null); // the new connection says what it wants to watch
    this.sockets.set(name, ws);
    this.alive.add(ws);
    console.log(`[server] ${name} connected`);

    ws.on("pong", () => this.alive.add(ws));
    ws.on("message", (raw) => {
      const frame = parseJson(raw) as ClientFrame | null;
      if (frame?.type === "ack" && Array.isArray(frame.ids)) {
        this.emit("ack", name, frame.ids.filter((id): id is string => typeof id === "string"));
      } else if (frame?.type === "receipt-ack" && Array.isArray(frame.ids)) {
        this.emit("receiptAck", name, frame.ids.filter((id): id is string => typeof id === "string"));
      } else if (frame?.type === "typing" && isValidName(frame.to) && frame.to !== name) {
        this.send(frame.to, { type: "typing", from: name, typing: frame.typing === true });
      } else if (frame?.type === "watch" && (frame.name === null || isValidName(frame.name))) {
        this.watch(name, frame.name);
      }
    });
    ws.on("close", () => {
      if (this.sockets.get(name) !== ws) return;
      this.sockets.delete(name);
      console.log(`[server] ${name} disconnected`);
      this.watch(name, null);
      this.announce(name, false);
    });

    this.emit("connect", name);
    this.announce(name, true);
  }

  // Their keys were replaced by a login on another device.
  disconnect(name: string, reason: string) {
    this.sockets.get(name)?.close(SIGNED_OUT_CLOSE_CODE, reason);
  }

  get size() {
    return this.sockets.size;
  }

  // Returns false if client isn't connected.
  send(name: string, frame: ServerFrame): boolean {
    const ws = this.sockets.get(name);
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  // Presence works like WhatsApp's: each app watches only the contact whose chat is open, so a user coming or going
  // reaches just the few apps looking at them, not everyone online.
  private watch(watcher: string, name: string | null) {
    const previous = this.watching.get(watcher);
    if (previous !== undefined) {
      this.watching.delete(watcher);
      const set = this.watchers.get(previous);
      set?.delete(watcher);
      if (set?.size === 0) this.watchers.delete(previous);
    }
    if (name === null || name === watcher) return;
    this.watching.set(watcher, name);
    let set = this.watchers.get(name);
    if (!set) this.watchers.set(name, (set = new Set()));
    set.add(watcher);
    this.send(watcher, { type: "presence", name, online: this.sockets.has(name) });
  }

  private announce(name: string, online: boolean) {
    for (const watcher of this.watchers.get(name) ?? []) this.send(watcher, { type: "presence", name, online });
  }

  private pingAll() {
    for (const ws of this.sockets.values()) {
      if (!this.alive.has(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.delete(ws);
      ws.ping();
    }
  }
}
