# SportsTech Phase 0 — MCP Logging Proxy

This project is **Phase 0 audit scaffolding only**.

Its job is:

1. Receive MCP HTTP traffic from an agent.
2. Log request metadata to PostgreSQL.
3. Forward the exact MCP request to Sophie.
4. Return Sophie's response unchanged.
5. Produce aggregate usage reports.

It is **not** the SportsTech Internal Data MCP.

## Architecture

```text
Claude / Jarvis / PPC bot
          |
          v
+-----------------------------+
| SportsTech Audit Proxy      |
|                             |
| log + forward only          |
+--------------+--------------+
               |
               v
          Sophie MCP
               |
               v
           Response
```

## Requirements

- Node.js 22+
- A PostgreSQL database — either AWS RDS (used in this project's real deployments) or local Docker Postgres for pure offline dev
- A real Sophie MCP endpoint URL
- Any Sophie authentication required by the upstream MCP

The proxy does not discover a Sophie URL from the Sophie Hub website. You must provide the actual MCP endpoint you are authorized to use.

The Postgres database stores two things: the `mcp_audit_logs` table (the audit trail) and the Sophie OAuth tokens/PKCE handshake state (`oauth_tokens`, `oauth_pending` — see [src/db.js](src/db.js)). Storing OAuth state in Postgres instead of a local file is what lets this run on stateless/serverless hosts, not just a persistent VM.

## 1. Install

```powershell
npm install
```

## 2. Database

**Using AWS RDS (recommended, matches production):** just point the `DB_*` vars in `.env` at your RDS instance (see step 3). No local setup needed. On first run, `ensureDatabase()` automatically creates the required tables if they don't exist.

**Using local Docker Postgres instead (fully offline dev):**

```powershell
docker compose up -d
docker compose ps
```

Then set `DB_HOST=localhost`, `DB_PORT=5433`, `DB_USER=postgres`, `DB_PASSWORD=postgres`, `DB_NAME=sportstech_audit` in `.env` (see `docker-compose.yml` for the exact mapping).

## 3. Configure `.env`

Copy:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` — every variable is documented inline in `.env.example`. At minimum you need:

```env
SOPHIE_MCP_URL=https://YOUR-ACTUAL-SOPHIE-MCP-ENDPOINT/mcp
SOPHIE_OAUTH_CLIENT_ID=...
DB_HOST=...rds.amazonaws.com
DB_PORT=5432
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
PROXY_API_KEY=a-long-random-value   # required once this is reachable off your own machine
```

### If Sophie requires an Authorization header

Use:

```env
UPSTREAM_HEADERS_JSON={"Authorization":"Bearer YOUR_TOKEN"}
```

Do not commit this value. `.env` is ignored by Git.

If Sophie uses OAuth, mTLS, cookies, or a special authentication flow, **do not guess**. The proxy may need a small transport/auth change based on Sophie's actual MCP connection method.

## 4. Start the proxy

```powershell
npm start
```

Expected:

```text
SportsTech Phase 0 Audit Proxy listening on http://127.0.0.1:8787
Sophie upstream: https://...
Claude endpoint: http://127.0.0.1:8787/mcp/claude
```

## 5. Health check

Open:

```text
http://127.0.0.1:8787/health
```

Expected:

```json
{
  "ok": true,
  "service": "sportstech-phase0-audit-proxy",
  "upstream": "https://..."
}
```

## 6. Connect Claude

Point Claude's Sophie MCP connection at:

```text
http://127.0.0.1:8787/mcp/claude
```

Do not remove the original Sophie connection until the proxy has been tested.

If Claude uses a configuration format that only supports stdio rather than remote HTTP, use a local MCP bridge or the Claude-specific HTTP configuration supported by your environment. The proxy itself exposes an HTTP MCP endpoint.

## 7. Test with read-only operations

For the first test:

- list tools
- run one harmless read-only tool

Do NOT test write/action tools.

Verify:

```text
Claude
  -> proxy
  -> Sophie
  -> proxy
  -> Claude
```

and then inspect:

```text
/audit/summary
```

## 8. Generate report

After calls have been collected:

```powershell
npm run report
```

This prints:

- total calls
- successful/failed calls
- top tools/capabilities
- calls by agent

## Deployment

This proxy can run either as a normal always-on Node process, or as a serverless function — pick whichever fits your infra.

**Always-on host** (EC2, Railway, Fly.io, a container, etc.): deploy the repo as-is and run `npm start` (entrypoint: [src/index.js](src/index.js)). No extra config needed. Preferred if you want a persistent SSE/long-lived MCP connection with no timeout ceiling.

**Serverless** (Vercel): the repo already includes [api/index.js](api/index.js) (serverless entrypoint) and [vercel.json](vercel.json) (routes every path to it, `maxDuration: 60`). Deploy with `vercel --prod` after setting the same env vars in the Vercel dashboard. Note: serverless function timeouts (60s here) will cut off any single request/stream that runs longer — fine for normal MCP tool calls, a real constraint only if Sophie ever needs a longer-lived push stream.

Either way, the deployed URL **must be HTTPS** — Claude's remote MCP connector will not accept a plain `http://` endpoint (localhost is the only exception).

## Handoff checklist (for whoever deploys this)

1. Provision/confirm the Postgres database (RDS or otherwise) and get its host/port/user/password/db name.
2. Set every variable in `.env.example` in the deploy target's environment/secrets config — **do not commit `.env` or put real credentials in git**. Share credentials via a password manager or your team's secrets tooling, not chat or the repo.
3. Deploy (see "Deployment" above) and confirm `GET /health` returns `{"ok": true, ...}`.
4. Set `SOPHIE_OAUTH_REDIRECT_URI` to `https://<deployed-domain>/oauth/callback` and redeploy if it changed after step 3.
5. Register that exact redirect URI with whoever administers the Sophie OAuth client (`SOPHIE_OAUTH_CLIENT_ID`) — most OAuth providers reject callbacks to unregistered URIs. This is external to this repo.
6. Visit `https://<deployed-domain>/oauth/start` once, complete the Sophie login. This persists the token in the `oauth_tokens` table — nothing else to do after that (auto-refreshes).
7. Confirm `PROXY_API_KEY` is set to a real random value (never leave it empty once this is publicly reachable).
8. Hand back `https://<deployed-domain>/mcp/claude` (plus the `PROXY_API_KEY` value, via a secure channel) as the URL to give Claude.
9. Sanity check: call `/mcp/claude` with a read-only MCP tool call, then check `/audit/summary` to confirm it logged.

## Agent-specific endpoints

Use a different path for each agent so the audit log can reliably identify the source:

```text
/mcp/claude
/mcp/jarvis
/mcp/hermaine
/mcp/triplik
/mcp/ppc-bot
```

Example:

```text
http://127.0.0.1:8787/mcp/claude
```

The proxy forwards every path to the same Sophie upstream endpoint.

## What is intentionally NOT included

This project does not implement:

- SportsTech rollups
- Amazon SP-API ingestion
- Helium 10 replacement
- Agent Central replacement
- Playbooks
- Research database
- Caching
- Vendor decommissioning

Those are later phases.

## Security notes

The proxy binds to `127.0.0.1` by default (via `HOST`). On a container/VM deploy where the process must accept traffic from outside localhost, set `HOST=0.0.0.0` — but only do this alongside a real `PROXY_API_KEY` and TLS termination in front (see "Deployment" and the handoff checklist above).

Never commit:

- `.env`
- API keys
- OAuth tokens
- cookies
- customer data

The database stores redacted tool arguments for `tools/call`, and redacted response bodies (capped at `RESPONSE_BODY_MAX_BYTES`, default 200KB — see `response_body`/`response_body_truncated` on `mcp_audit_logs`). Redaction only applies when a response is a single JSON document; SSE/plain-text bodies are stored as-is, so avoid putting real secrets in Sophie's tool output if that matters for your audit retention policy.

For a production/remote deployment, add:

- TLS
- strong authentication
- strict Origin allow-list
- secret manager
- network restrictions
- retention policy
- audit access controls

## Important compatibility note

This implementation is a **transparent HTTP transport proxy**. It is intentionally not an MCP SDK server/client implementation because the goal in Phase 0 is to preserve the vendor MCP protocol as-is while observing traffic.

It supports the normal MCP Streamable HTTP pattern of POST/GET/DELETE and forwards MCP session/protocol headers.

If the Sophie connection is legacy SSE-only, OAuth-mediated, or uses a non-standard transport, the proxy may need an adapter after inspecting the actual connection configuration.
