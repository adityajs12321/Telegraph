// Serves the HTML Page

import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parseJson, type UiCommand, type UiEvent } from "@telegraph/shared";

interface UiEvents {
  connect: [reply: (event: UiEvent) => void];
  send: [to: string, body: string];
}

export class UiServer extends EventEmitter<UiEvents> {
  private server: http.Server;
  private browsers = new Set<WebSocket>();

  constructor(indexHtmlPath: string) {
    super();
    this.server = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        fs.createReadStream(indexHtmlPath).pipe(res);
      } else {
        res.writeHead(404).end();
      }
    });

    new WebSocketServer({ server: this.server, path: "/ws" }).on("connection", (ws) => this.accept(ws));
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, resolve));
  }

  broadcast(event: UiEvent) {
    const data = JSON.stringify(event);
    for (const ws of this.browsers) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  private accept(ws: WebSocket) {
    this.browsers.add(ws);
    ws.on("close", () => this.browsers.delete(ws));
    ws.on("message", (raw) => {
      const cmd = parseJson(raw) as UiCommand | null;
      if (cmd?.type !== "send" || typeof cmd.to !== "string" || typeof cmd.body !== "string") return;
      if (cmd.to.trim() && cmd.body.trim()) this.emit("send", cmd.to.trim(), cmd.body);
    });
    this.emit("connect", (event) => ws.send(JSON.stringify(event)));
  }
}
