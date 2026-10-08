// Configuration for the local app

import path from "node:path";
import { fileURLToPath } from "node:url";

// data dir for database
const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");

export interface AppConfig {
  profile: string; // names this app instance
  port: number;
  serverUrl: string;
  dataDir: string;
}

export function loadConfig(argv = process.argv, env = process.env): AppConfig {
  const get = (flag: string, fallback?: string) => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 ? argv[i + 1] : env[flag.toUpperCase().replace(/-/g, "_")] ?? fallback;
  };

  const profile = get("profile", "default")!;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile)) {
    throw new Error("--profile must be letters, digits, _ or - (max 64 chars)");
  }

  return {
    profile,
    port: Number(get("port", "3000")),
    serverUrl: get("server", "http://localhost:8080")!.replace(/\/+$/, ""),
    dataDir: path.resolve(get("data-dir", DEFAULT_DATA_DIR)!),
  };
}
