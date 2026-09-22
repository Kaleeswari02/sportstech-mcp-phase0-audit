import "dotenv/config";
import express from "express";
import { Readable } from "node:stream";
import {
  getAuthorizationUrl,
  handleOAuthCallback,
  getValidAccessToken,
  getOAuthStatus
} from "./oauth.js";
import {
  insertStartedLog,
  markFirstByte,
  finishLog,
  pool
} from "./db.js";
import {
  hashSessionId,
  isAllowedOrigin,
  checkProxyAuth
} from "./security.js";
import { redact } from "./redact.js";

export const app = express();

// IMPORTANT: raw body is required because this proxy must forward the MCP JSON-RPC
// message without changing it.
app.use("/mcp", express.raw({ type: "*/*", limit: "10mb" }));

export const UPSTREAM_URL = process.env.SOPHIE_MCP_URL;

if (!UPSTREAM_URL || UPSTREAM_URL.includes("REPLACE-WITH-SOPHIE")) {
  console.error("Missing SOPHIE_MCP_URL in .env");
  process.exit(1);
}

const staticHeaders = parseUpstreamHeaders();

function parseUpstreamHeaders() {
  try {
    const parsed = JSON.parse(process.env.UPSTREAM_HEADERS_JSON || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("UPSTREAM_HEADERS_JSON must be a JSON object");
    }
    return parsed;
  } catch (error) {
    console.error("Invalid UPSTREAM_HEADERS_JSON:", error.message);
    process.exit(1);
  }
}

function agentFromPath(req) {
  // Use a separate endpoint path per agent:
  // /mcp/claude, /mcp/jarvis, /mcp/hermaine, /mcp/triplik, /mcp/ppc-bot
  const match = req.path.match(/^\/mcp\/([^/]+)$/);
  return match ? match[1] : "unknown";
}

function getRequestBody(req) {
  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return null;
  }

  try {
    return JSON.parse(req.body.toString("utf8"));
  } catch {
    return null;
  }
}

function extractMcpMetadata(body) {
  if (!body || typeof body !== "object") {
    return {
      requestId: null,
      mcpMethod: null,
      toolName: null,
      requestParams: null
    };
  }

  const params = body.params || {};

  return {
    requestId:
      body.id === undefined || body.id === null ? null : String(body.id),
    mcpMethod: body.method || null,
    toolName:
      body.method === "tools/call" ? (params.name || null) : null,
    requestParams:
      body.method === "tools/call"
        ? redact(params.arguments || {})
        : redact(params)
  };
}

function copyResponseHeaders(upstream, res) {
  // Only copy headers that are meaningful to the MCP client.
  const headersToCopy = [
    "content-type",
    "cache-control",
    "content-encoding",
    "content-length",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
    "www-authenticate",
    "allow",
    "retry-after"
  ];

  for (const name of headersToCopy) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

async function buildUpstreamHeaders(req) {
  const headers = { ...staticHeaders };

  const accessToken = await getValidAccessToken();

  headers.Authorization = `Bearer ${accessToken}`;

  for (const name of [
    "accept",
    "content-type",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
    "mcp-method",
    "mcp-name"
  ]) {
    const value = req.get(name);

    if (value) {
      headers[name] = value;
    }
  }

  return headers;
}

async function proxyRequest(req, res) {
  if (!isAllowedOrigin(req.get("origin"))) {
    return res.status(403).json({
      error: "Origin not allowed"
    });
  }

  if (!checkProxyAuth(req)) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  const agent = agentFromPath(req);
  const body = getRequestBody(req);
  const metadata = extractMcpMetadata(body);
  const sessionId = req.get("mcp-session-id");
  const protocolVersion = req.get("mcp-protocol-version");

  const auditId = await insertStartedLog({
    requestId: metadata.requestId,
    agent,
    vendor: "sophie",
    httpMethod: req.method,
    mcpMethod: metadata.mcpMethod,
    toolName: metadata.toolName,
    sessionIdHash: hashSessionId(sessionId),
    protocolVersion,
    requestParams: metadata.requestParams
  });

  const startedAt = Date.now();

  try {
    const upstream = await fetch(UPSTREAM_URL, {
      method: req.method,
      headers: await buildUpstreamHeaders(req),
      body:
        req.method === "POST" || req.method === "PUT" || req.method === "PATCH"
          ? req.body
          : undefined,
      redirect: "manual"
    });

    copyResponseHeaders(upstream, res);
    res.status(upstream.status);

    // For a response with a body, mark first byte as soon as the stream is available.
    if (upstream.body) {
      await markFirstByte(auditId);

      // Web ReadableStream -> Node Readable.
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on("error", async (error) => {
        await finishLog(auditId, {
          responseStatus: upstream.status,
          responseContentType: upstream.headers.get("content-type"),
          status: "error",
          errorMessage: error.message
        }).catch(console.error);

        if (!res.headersSent) res.status(502);
        res.end();
      });

      nodeStream.on("end", async () => {
        await finishLog(auditId, {
          responseStatus: upstream.status,
          responseContentType: upstream.headers.get("content-type"),
          status: upstream.ok ? "success" : "upstream_error"
        }).catch(console.error);
      });

      nodeStream.pipe(res);
      return;
    }

    await finishLog(auditId, {
      responseStatus: upstream.status,
      responseContentType: upstream.headers.get("content-type"),
      status: upstream.ok ? "success" : "upstream_error"
    });

    res.end();
  } catch (error) {
    const latency = Date.now() - startedAt;

    await finishLog(auditId, {
      responseStatus: 502,
      responseContentType: "application/json",
      status: "proxy_error",
      errorMessage: error.message
    }).catch(console.error);

    if (!res.headersSent) {
      res.status(502).json({
        error: "Proxy could not reach Sophie MCP",
        message: error.message,
        latency_ms: latency
      });
    } else {
      res.end();
    }
  }
}

// One MCP endpoint per agent gives us a reliable agent label without trusting
// an arbitrary body field.
// Examples:
//   http://127.0.0.1:8787/mcp/claude
//   http://127.0.0.1:8787/mcp/jarvis
app.get("/oauth/start", async (_req, res) => {
  try {
    const authorizationUrl = await getAuthorizationUrl();

    res.redirect(authorizationUrl);
  } catch (error) {
    res.status(500).send(`
      <h1>OAuth initialization failed</h1>
      <pre>${error.message}</pre>
    `);
  }
});
app.all("/mcp/:agent", proxyRequest);

app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).send(`
        <h1>OAuth authorization failed</h1>
        <p>${error_description || error}</p>
      `);
    }

    if (!code || !state) {
      return res.status(400).send(
        "Missing OAuth code or state."
      );
    }

    await handleOAuthCallback(code, state);

    res.send(`
      <h1>Sophie OAuth successful</h1>
      <p>The SportsTech Phase 0 Audit Proxy is now authenticated.</p>
      <p>You can close this browser tab.</p>
    `);
  } catch (error) {
    console.error("OAuth callback error:", error);

    res.status(500).send(`
      <h1>OAuth callback failed</h1>
      <pre>${error.message}</pre>
    `);
  }
});

app.get("/oauth/status", async (_req, res) => {
  try {
    res.json(await getOAuthStatus());
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});
// Health check.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "sportstech-phase0-audit-proxy",
    upstream: new URL(UPSTREAM_URL).origin
  });
});

// Simple audit summary endpoint for local use.
// It deliberately returns aggregate information only.
app.get("/audit/summary", async (_req, res) => {
  try {
    const [totals, tools, agents] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS calls,
               COUNT(*) FILTER (WHERE status = 'success')::int AS successful,
               COUNT(*) FILTER (WHERE status IN ('upstream_error','proxy_error'))::int AS failed
        FROM mcp_audit_logs
      `),
      pool.query(`
        SELECT COALESCE(tool_name, mcp_method, 'unknown') AS capability,
               COUNT(*)::int AS calls
        FROM mcp_audit_logs
        GROUP BY 1
        ORDER BY calls DESC
        LIMIT 50
      `),
      pool.query(`
        SELECT agent, COUNT(*)::int AS calls
        FROM mcp_audit_logs
        GROUP BY agent
        ORDER BY calls DESC
      `)
    ]);

    res.json({
      totals: totals.rows[0],
      top_tools: tools.rows,
      by_agent: agents.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
