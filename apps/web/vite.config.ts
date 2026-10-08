import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the UI with hot reload and forwards /ws to a running local app
// (APP_PORT, default 3000), e.g. APP_PORT=3001 npm run dev -w @telegraph/web
const appPort = process.env.APP_PORT ?? "3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/ws": { target: `ws://localhost:${appPort}`, ws: true } },
  },
});
