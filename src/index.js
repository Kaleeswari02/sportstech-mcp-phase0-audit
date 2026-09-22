import "dotenv/config";
import { app, UPSTREAM_URL } from "./app.js";
import { ensureDatabase, closeDb } from "./db.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);

await ensureDatabase();

const server = app.listen(PORT, HOST, () => {
  console.log(`SportsTech Phase 0 Audit Proxy listening on http://${HOST}:${PORT}`);
  console.log(`Sophie upstream: ${UPSTREAM_URL}`);
  console.log(`Claude endpoint: http://${HOST}:${PORT}/mcp/claude`);
});

async function shutdown(signal) {
  console.log(`\\n${signal} received. Shutting down...`);
  server.close(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
