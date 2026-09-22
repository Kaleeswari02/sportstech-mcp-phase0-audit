import crypto from "node:crypto";

export function hashSessionId(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function isAllowedOrigin(origin) {
  const configured = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  if (!origin) return true;
  if (configured.length === 0) return true;

  return configured.includes(origin);
}

export function checkProxyAuth(req) {
  const expected = process.env.PROXY_API_KEY;
  if (!expected) return true;

  const auth = req.get("authorization") || "";
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix)) return false;

  const supplied = auth.slice(prefix.length);
  return supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
