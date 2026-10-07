// WebSocket connection to the server, authenticated with signed headers. Reconnects on drop

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { parseJson, type ClientFrame, type Envelope, type ServerFrame } from "@telegraph/shared";
import type { ServerApi } from "./server-api.js";

const WS_PATH = "/ws";

interface SocketEvents {
  open: [];
  close: [];
  envelope: [env: Envelope];
  delivered: [id: string];
  peers: [peers: string[]];
}

export class ServerSocket extends EventEmitter<SocketEvents> {
  private ws: WebSocket | null = null;
  private url: string;

  constructor(serverUrl: string, private api: ServerApi, private name: string, private reconnectMs = 2000) {
    super();
    this.url = serverUrl.replace(/^http/, "ws") + WS_PATH; // http -> ws, https -> wss
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    const ws = new WebSocket(this.url, { headers: this.api.signedHeaders("GET", WS_PATH) });
    this.ws = ws;

    ws.on("open", () => this.emit("open"));
    ws.on("message", (raw) => this.dispatch(parseJson(raw) as ServerFrame | null));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.emit("close");
      setTimeout(() => this.connect(), this.reconnectMs);
    });
    ws.on("error", () => {
      // reconnection
    });
  }

  ack(ids: string[]) {
    if (this.connected) this.write({ type: "ack", ids });
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
    }
  }
}
