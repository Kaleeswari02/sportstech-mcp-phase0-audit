const SENSITIVE_KEY_RE =
  /^(authorization|proxy.?api.?key|api.?key|access.?token|refresh.?token|client.?secret|password|secret|cookie|set-cookie)$/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);

  if (value && typeof value === "object") {
    const output = {};
    for (const [key, val] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redact(val);
    }
    return output;
  }

  return value;
}
