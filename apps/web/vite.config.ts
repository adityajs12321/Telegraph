import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app talks to the relay server directly; point it somewhere other than http://localhost:8080 with
// VITE_SERVER_URL, e.g. VITE_SERVER_URL=https://telegraph-server.fly.dev npm run build -w @telegraph/web
export default defineConfig({
  plugins: [react()],
});
