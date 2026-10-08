// Main app entry point
// Usage: npm run app -- --profile alice --port 3001

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "./config.js";
import { Session } from "./session.js";
import { UiServer } from "./ui-server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "../../web/dist");

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

if (!fs.existsSync(path.join(WEB_DIR, "index.html"))) {
  console.error(`web UI not built (missing ${WEB_DIR}); run: npm run build -w @telegraph/web`);
  process.exit(1);
}
const ui = new UiServer(WEB_DIR);

new Session(config.serverUrl, config.dataDir, config.profile, ui).start();

await ui.listen(config.port);
console.log(`[${config.profile}] UI at http://localhost:${config.port}  (server: ${config.serverUrl}, data: ${config.dataDir})`);
