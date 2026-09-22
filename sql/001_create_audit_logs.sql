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

CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_timestamp
  ON mcp_audit_logs(timestamp);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_tool
  ON mcp_audit_logs(tool_name);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_agent
  ON mcp_audit_logs(agent);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_mcp_method
  ON mcp_audit_logs(mcp_method);


