import "dotenv/config";
import { pool, closeDb } from "./db.js";

const { rows: totals } = await pool.query(`
  SELECT
    COUNT(*)::int AS total_calls,
    COUNT(*) FILTER (WHERE status = 'success')::int AS successful_calls,
    COUNT(*) FILTER (WHERE status IN ('upstream_error','proxy_error'))::int AS failed_calls
  FROM mcp_audit_logs
`);

const { rows: tools } = await pool.query(`
  SELECT
    COALESCE(tool_name, mcp_method, 'unknown') AS capability,
    COUNT(*)::int AS calls,
    ROUND(
      COUNT(*) * 100.0 /
      NULLIF((SELECT COUNT(*) FROM mcp_audit_logs), 0),
      2
    ) AS usage_percent
  FROM mcp_audit_logs
  GROUP BY 1
  ORDER BY calls DESC
`);

const { rows: agents } = await pool.query(`
  SELECT agent, COUNT(*)::int AS calls
  FROM mcp_audit_logs
  GROUP BY agent
  ORDER BY calls DESC
`);

console.log("\\n=== SportsTech Phase 0 MCP Usage Report ===\\n");
console.table(totals);
console.log("\\nTop capabilities/tools:");
console.table(tools);
console.log("\\nUsage by agent:");
console.table(agents);

await closeDb();
