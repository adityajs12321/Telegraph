// Configuration for the local app

import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidName } from "@telegraph/shared";

// data dir for database
const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");

export interface AppConfig {
  name: string;
  port: number;
  serverUrl: string;
  dataDir: string;
}

export function loadConfig(argv = process.argv, env = process.env): AppConfig {
  const get = (flag: string, fallback?: string) => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 ? argv[i + 1] : env[flag.toUpperCase().replace(/-/g, "_")] ?? fallback;
  };

  const name = get("name");
  if (!isValidName(name)) {
    throw new Error("--name is required (letters, digits, _ or -, max 32 chars)");
  }

  return {
    name,
    port: Number(get("port", "3000")),
    serverUrl: get("server", "http://localhost:8080")!.replace(/\/+$/, ""),
    dataDir: path.resolve(get("data-dir", DEFAULT_DATA_DIR)!),
  };
}
