import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const useDiscreteParams = Boolean(process.env.DB_HOST);

export const pool = new Pool(
  useDiscreteParams
    ? {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl:
          process.env.DB_SSL === "false"
            ? false
            : { rejectUnauthorized: false },
        // Serverless platforms (e.g. Vercel) run many short-lived instances in
        // parallel, each with its own pool. Keep this small so they don't
        // collectively exhaust RDS's max_connections.
        max: Number(process.env.DB_POOL_MAX || 5)
      }
    : { connectionString: process.env.DATABASE_URL }
);

export async function ensureDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      agent TEXT NOT NULL,
      vendor TEXT NOT NULL DEFAULT 'sophie',
      http_method TEXT NOT NULL,
      mcp_method TEXT,
      tool_name TEXT,
      session_id_hash TEXT,
      protocol_version TEXT,
      request_params JSONB,
      response_status INTEGER,
      response_content_type TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      first_byte_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      latency_ms INTEGER,
      time_to_first_byte_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'started',
      error_message TEXT
    );

    ALTER TABLE mcp_audit_logs
      ADD COLUMN IF NOT EXISTS response_body TEXT,
      ADD COLUMN IF NOT EXISTS response_body_truncated BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_timestamp
      ON mcp_audit_logs(timestamp);

    CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_tool
      ON mcp_audit_logs(tool_name);

    CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_agent
      ON mcp_audit_logs(agent);

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      vendor TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_type TEXT NOT NULL DEFAULT 'Bearer',
      expires_at BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS oauth_pending (
      state TEXT PRIMARY KEY,
      vendor TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function saveOAuthPending(vendor, state, codeVerifier) {
  await pool.query(
    `INSERT INTO oauth_pending (state, vendor, code_verifier, created_at)
     VALUES ($1,$2,$3,NOW())`,
    [state, vendor, codeVerifier]
  );
}

export async function consumeOAuthPending(vendor, state) {
  const result = await pool.query(
    `DELETE FROM oauth_pending
     WHERE state = $1 AND vendor = $2
     RETURNING code_verifier, created_at`,
    [state, vendor]
  );
  return result.rows[0] ?? null;
}

export async function saveOAuthTokens(vendor, tokens) {
  await pool.query(
    `INSERT INTO oauth_tokens (vendor, access_token, refresh_token, token_type, expires_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (vendor) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           token_type = EXCLUDED.token_type,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
    [
      vendor,
      tokens.access_token,
      tokens.refresh_token ?? null,
      tokens.token_type ?? "Bearer",
      tokens.expires_at ?? null
    ]
  );
}

export async function loadOAuthTokens(vendor) {
  const result = await pool.query(
    `SELECT access_token, refresh_token, token_type, expires_at
     FROM oauth_tokens WHERE vendor = $1`,
    [vendor]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, expires_at: row.expires_at !== null ? Number(row.expires_at) : null };
}

export async function insertStartedLog(entry) {
  const result = await pool.query(
    `INSERT INTO mcp_audit_logs
      (request_id, agent, vendor, http_method, mcp_method, tool_name,
       session_id_hash, protocol_version, request_params, started_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),'started')
     RETURNING id`,
    [
      entry.requestId ?? null,
      entry.agent,
      entry.vendor ?? "sophie",
      entry.httpMethod,
      entry.mcpMethod ?? null,
      entry.toolName ?? null,
      entry.sessionIdHash ?? null,
      entry.protocolVersion ?? null,
      entry.requestParams ?? null
    ]
  );
  return result.rows[0].id;
}

export async function markFirstByte(id) {
  await pool.query(
    `UPDATE mcp_audit_logs
     SET first_byte_at = COALESCE(first_byte_at, NOW()),
         time_to_first_byte_ms = EXTRACT(EPOCH FROM (COALESCE(first_byte_at, NOW()) - started_at)) * 1000
     WHERE id = $1`,
    [id]
  );
}

export async function finishLog(id, entry) {
  await pool.query(
    `UPDATE mcp_audit_logs
     SET response_status = $2,
         response_content_type = $3,
         completed_at = NOW(),
         latency_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
         status = $4,
         error_message = $5,
         response_body = $6,
         response_body_truncated = $7
     WHERE id = $1`,
    [
      id,
      entry.responseStatus ?? null,
      entry.responseContentType ?? null,
      entry.status,
      entry.errorMessage ?? null,
      entry.responseBody ?? null,
      entry.responseBodyTruncated ?? false
    ]
  );
}

export async function closeDb() {
  await pool.end();
}
