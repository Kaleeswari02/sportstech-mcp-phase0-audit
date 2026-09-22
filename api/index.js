import "dotenv/config";
import { app } from "../src/app.js";
import { ensureDatabase } from "../src/db.js";

// Serverless instances are reused across invocations while warm, so this only
// runs once per cold start rather than on every request.
let dbReady = null;

export default async function handler(req, res) {
  if (!dbReady) {
    dbReady = ensureDatabase().catch((error) => {
      dbReady = null;
      throw error;
    });
  }

  await dbReady;

  app(req, res);
}
