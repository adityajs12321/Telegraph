// Main app entry point
// Usage: npm run app -- --name alice --port 3001

import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateIdentity } from "@telegraph/shared";
import { loadConfig, type AppConfig } from "./config.js";
import { LocalStore } from "./local-store.js";
import { Messenger } from "./messenger.js";
import { ServerApi } from "./server-api.js";
import { ServerSocket } from "./server-socket.js";
import { UiServer } from "./ui-server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_INDEX = path.resolve(HERE, "../../web/index.html");

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const dbFile = path.join(config.dataDir, `${config.name}.db`);
const store = new LocalStore(dbFile);

// one time identity creation
let identity = store.identity();
if (!identity) {
  identity = generateIdentity();
  store.saveIdentity(identity);
}

const api = new ServerApi(config.serverUrl, config.name, identity);
const socket = new ServerSocket(config.serverUrl, api, config.name);
const ui = new UiServer(WEB_INDEX);

new Messenger(config.name, identity, store, api, socket, ui).start();

await ui.listen(config.port);
console.log(`[${config.name}] UI at http://localhost:${config.port}  (server: ${config.serverUrl}, db: ${dbFile})`);
