// Serves the built web UI

import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { parseJson, type UiCommand, type UiEvent } from "@telegraph/shared";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

interface UiEvents {
  connect: [reply: (event: UiEvent) => void];
  send: [to: string, body: string];
  addContact: [name: string, reply: (event: UiEvent) => void];
  loginStart: [email: string, reply: (event: UiEvent) => void];
  loginVerify: [email: string, code: string, name: string | undefined, reply: (event: UiEvent) => void];
  logout: [];
}

export class UiServer extends EventEmitter<UiEvents> {
  private server: http.Server;
  private browsers = new Set<WebSocket>();

  constructor(private webDir: string) {
    super();
    this.server = http.createServer((req, res) => this.serveFile(req, res));

    new WebSocketServer({ server: this.server, path: "/ws" }).on("connection", (ws) => this.accept(ws));
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, resolve));
  }

  broadcast(event: UiEvent) {
    const data = JSON.stringify(event);
    for (const ws of this.browsers) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  private serveFile(req: http.IncomingMessage, res: http.ServerResponse) {
    const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const file = path.join(this.webDir, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(this.webDir + path.sep)) return void res.writeHead(404).end();
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return void res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
  }

  private accept(ws: WebSocket) {
    this.browsers.add(ws);
    ws.on("close", () => this.browsers.delete(ws));
    const reply = (event: UiEvent) => ws.send(JSON.stringify(event));
    ws.on("message", (raw) => {
      const cmd = parseJson(raw) as UiCommand | null;
      if (cmd?.type === "send" && typeof cmd.to === "string" && typeof cmd.body === "string") {
        if (cmd.to.trim() && cmd.body.trim()) this.emit("send", cmd.to.trim(), cmd.body);
      } else if (cmd?.type === "add-contact" && typeof cmd.name === "string") {
        this.emit("addContact", cmd.name.trim(), reply);
      } else if (cmd?.type === "login-start" && typeof cmd.email === "string") {
        this.emit("loginStart", cmd.email, reply);
      } else if (cmd?.type === "login-verify" && typeof cmd.email === "string" && typeof cmd.code === "string") {
        const name = typeof cmd.name === "string" ? cmd.name.trim() : undefined;
        this.emit("loginVerify", cmd.email, cmd.code.trim(), name, reply);
      } else if (cmd?.type === "logout") {
        this.emit("logout");
      }
    });
    this.emit("connect", reply);
  }
}
