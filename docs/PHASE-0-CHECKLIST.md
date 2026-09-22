# Phase 0 checklist

## A. Catalog

- [ ] Export/list Sophie Atlas skills
- [ ] Catalog Helium 10 capabilities
- [ ] Catalog Agent Central capabilities
- [ ] Map tool -> business capability
- [ ] Record inputs/outputs
- [ ] Record which agent/team uses each capability

## B. Instrumentation

- [ ] Obtain authorized Sophie MCP endpoint
- [ ] Confirm transport: Streamable HTTP / legacy SSE / other
- [ ] Start local PostgreSQL
- [ ] Start audit proxy
- [ ] Test a read-only call
- [ ] Verify request is forwarded
- [ ] Verify response is unchanged
- [ ] Verify audit row exists
- [ ] Configure agent-specific proxy endpoint
- [ ] Repeat for other agents only after first test succeeds

## C. Cost

- [ ] Sophie annual contract cost
- [ ] Helium 10 annual contract cost
- [ ] Agent Central annual contract cost
- [ ] Cancellation notice period
- [ ] Renewal date
- [ ] Finance confirmation

## D. Audit window

- [ ] 2–4 week minimum
- [ ] Include automated/scheduled jobs
- [ ] Monitor errors
- [ ] Monitor tool volume

## E. Decision output

- [ ] Rank capabilities by call volume
- [ ] Rank capabilities by business importance
- [ ] Identify agent dependencies
- [ ] Compare usage against vendor cost
- [ ] Produce Phase 1 scope
- [ ] Explicitly document low-usage capabilities for later phases

## Guardrail

The proxy must remain:

```text
LOG + FORWARD
```

It must not become:

```text
ROLLUPS + PERSISTENCE + PLAYBOOKS + CACHE
```

Those belong to later phases.
