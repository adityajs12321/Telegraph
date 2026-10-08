// WebSocket connection to the server, authenticated with signed headers. Reconnects on drop

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { parseJson, SIGNED_OUT_CLOSE_CODE, type ClientFrame, type Envelope, type ServerFrame } from "@telegraph/shared";
import type { ServerApi } from "./server-api.js";

const WS_PATH = "/ws";

interface SocketEvents {
  open: [];
  close: [];
  envelope: [env: Envelope];
  delivered: [id: string];
  peers: [peers: string[]];
  typing: [from: string, typing: boolean];
  signedOut: []; // the server closed us because the account logged in on another device
  rejected: []; // 401 on connect: our keys may have been replaced while we were offline
}

export class ServerSocket extends EventEmitter<SocketEvents> {
  private ws: WebSocket | null = null;
  private url: string;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(serverUrl: string, private api: ServerApi, private name: string, private reconnectMs = 2000) {
    super();
    this.url = serverUrl.replace(/^http/, "ws") + WS_PATH;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url, { headers: this.api.signedHeaders("GET", WS_PATH) });
    this.ws = ws;

    let opened = false;
    ws.on("open", () => {
      opened = true;
      this.emit("open");
    });
    ws.on("message", (raw) => this.dispatch(parseJson(raw) as ServerFrame | null));
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) this.emit("rejected");
      ws.terminate();
    });
    ws.on("close", (code) => {
      if (this.ws !== ws || this.closed) return;
      if (opened) this.emit("close");
      if (code === SIGNED_OUT_CLOSE_CODE) return void this.emit("signedOut");
      this.retry = setTimeout(() => this.connect(), this.reconnectMs);
    });
    ws.on("error", () => {
      // reconnection
    });
  }

  // disconnect
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.ws?.close();
  }

  ack(ids: string[]) {
    if (this.connected) this.write({ type: "ack", ids });
  }

  typing(to: string, typing: boolean) {
    if (this.connected) this.write({ type: "typing", to, typing });
  }

  private write(frame: ClientFrame) {
    this.ws!.send(JSON.stringify(frame));
  }

  private dispatch(frame: ServerFrame | null) {
    switch (frame?.type) {
      case "envelope":
        this.emit("envelope", frame.envelope);
        break;
      case "delivered":
        this.emit("delivered", frame.id);
        break;
      case "peers":
        this.emit("peers", frame.peers.filter((p) => p !== this.name));
        break;
      case "typing":
        this.emit("typing", frame.from, frame.typing);
        break;
    }
  }
}
