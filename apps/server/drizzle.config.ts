// drizzle-kit config: `npm run db:generate -w @telegraph/server` writes SQL migrations to ./drizzle.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
