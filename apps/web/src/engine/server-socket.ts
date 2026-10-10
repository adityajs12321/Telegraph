// WebSocket connection to the server, authenticated with signed query parameters. Reconnects on drop

import { parseJson, SIGNED_OUT_CLOSE_CODE, type ClientFrame, type Envelope, type ServerFrame } from "@telegraph/shared";
import type { ServerApi } from "./server-api";

const WS_PATH = "/ws";

interface SocketEvents {
  open: [];
  close: [];
  envelope: [env: Envelope];
  delivered: [id: string];
  peers: [peers: string[]];
  typing: [from: string, typing: boolean];
  signedOut: []; // the server closed us because the account logged in on another device
  rejected: []; // couldn't connect: our keys may have been replaced while we were offline
}

export class ServerSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private handlers: { [K in keyof SocketEvents]?: ((...args: SocketEvents[K]) => void)[] } = {};

  constructor(serverUrl: string, private api: ServerApi, private name: string, private reconnectMs = 2000) {
    this.url = serverUrl.replace(/^http/, "ws") + WS_PATH;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  on<K extends keyof SocketEvents>(event: K, handler: (...args: SocketEvents[K]) => void) {
    ((this.handlers[event] ??= []) as ((...args: SocketEvents[K]) => void)[]).push(handler);
  }

  async connect() {
    if (this.closed) return;
    // Browsers can't set WebSocket headers, so the signed headers go in the query string.
    const auth = new URLSearchParams(await this.api.signedHeaders("GET", WS_PATH));
    if (this.closed) return;
    const ws = new WebSocket(`${this.url}?${auth}`);
    this.ws = ws;

    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.emit("open");
    };
    ws.onmessage = (e) => this.dispatch(parseJson(e.data) as ServerFrame | null);
    ws.onclose = (e) => {
      if (this.ws !== ws || this.closed) return;
      if (opened) this.emit("close");
      if (e.code === SIGNED_OUT_CLOSE_CODE) return void this.emit("signedOut");
      // Browsers hide the handshake's HTTP status, so a 401 looks like any other failed connection.
      if (!opened) this.emit("rejected");
      this.retry = setTimeout(() => void this.connect(), this.reconnectMs);
    };
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

  private emit<K extends keyof SocketEvents>(event: K, ...args: SocketEvents[K]) {
    for (const handler of this.handlers[event] ?? []) handler(...args);
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
