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

  constructor() {
    super();
    // Pings keep idle connections open through proxies and drop ones that stopped answering.
    setInterval(() => this.pingAll(), PING_MS).unref();
  }

  // client must already be authenticated.
  attach(name: string, ws: WebSocket) {
    this.sockets.get(name)?.close(4000, "replaced by a newer connection");
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
      }
    });
    ws.on("close", () => {
      if (this.sockets.get(name) !== ws) return;
      this.sockets.delete(name);
      console.log(`[server] ${name} disconnected`);
      this.broadcastPeers();
    });

    this.emit("connect", name);
    this.broadcastPeers();
  }

  // Their keys were replaced by a login on another device.
  disconnect(name: string, reason: string) {
    this.sockets.get(name)?.close(SIGNED_OUT_CLOSE_CODE, reason);
  }

  // Returns false if client isn't connected.
  send(name: string, frame: ServerFrame): boolean {
    const ws = this.sockets.get(name);
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  private broadcastPeers() {
    const peers = [...this.sockets.keys()];
    for (const name of peers) this.send(name, { type: "peers", peers });
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
