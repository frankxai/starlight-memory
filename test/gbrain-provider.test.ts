/**
 * gbrain adapter tests.
 *
 * callTool is injected so these run offline and never contend for the
 * single-writer PGLite lock that a real gbrain serve holds.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { GBrainProvider, routeMemoryRecord, type SISMemoryRecord } from "../src/index.js";

/**
 * Spins a server that mimics a real streamable-HTTP MCP endpoint. `mode`
 * chooses which of the two legal shapes it answers with — both must work.
 */
async function mcpServer(mode: "sse" | "json"): Promise<{ url: string; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      seen.push(msg.method);

      // Stateful servers reject everything until initialize has been seen.
      if (msg.method !== "initialize" && !req.headers["mcp-session-id"]) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: -32000, message: "Bad Request: Server not initialized" } }));
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }

      const result = msg.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake-gbrain", version: "0" } }
        : { structuredContent: { id: 7, status: "inserted" } };
      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });

      const headers: Record<string, string> = {};
      if (msg.method === "initialize") headers["mcp-session-id"] = "sess-abc";

      if (mode === "sse") {
        res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${payload}\n\n`);
      } else {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(payload);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function makeRecord(overrides: Partial<SISMemoryRecord> = {}): SISMemoryRecord {
  return {
    memory_id: "mem_1",
    tenant_id: "tenant_frank",
    source: { system: "claude-code", session_id: "sess_9" },
    modality: "text",
    memory_type: "semantic",
    normalized_fact: "Voyage voyage-4 gives 200M free tokens before $0.06/1M",
    entities: [{ id: "projects/gbrain", name: "gbrain" }],
    relations: [],
    importance: 0.6,
    confidence: 0.9,
    trust: 0.8,
    privacy_class: "public",
    retention_policy: "permanent",
    provenance: [{ event_id: "evt_1", transform: "extracted", at: "2026-09-01T00:00:00Z" }],
    provider_shadow_refs: {},
    ...overrides,
  };
}

describe("GBrainProvider", () => {
  it("writes a fact and records the shadow ref", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const provider = new GBrainProvider({
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { id: 42, status: "inserted" };
      },
    });

    const record = await provider.remember(makeRecord());

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "remember");
    assert.equal(calls[0].args.entity, "projects/gbrain");
    assert.equal(calls[0].args.visibility, "world");
    assert.equal(calls[0].args.kind, "fact");
    assert.match(String(calls[0].args.provenance), /^sis:claude-code:extracted \(sess_9\)$/);
    assert.equal(record.provider_shadow_refs.gbrain?.provider_record_id, "42");
    assert.equal(record.provider_shadow_refs.gbrain?.sync_state, "synced");
  });

  it("never sends secret or regulated records to gbrain", async () => {
    let called = false;
    const provider = new GBrainProvider({
      callTool: async () => {
        called = true;
        return { id: 1 };
      },
    });

    await provider.remember(makeRecord({ privacy_class: "secret" }));
    await provider.remember(makeRecord({ privacy_class: "regulated" }));

    assert.equal(called, false);
  });

  it("maps SIS memory types onto gbrain's kind CHECK constraint", async () => {
    const kinds: unknown[] = [];
    const provider = new GBrainProvider({
      callTool: async (_name, args) => {
        kinds.push(args.kind);
        return { id: 1, status: "inserted" };
      },
    });

    await provider.remember(makeRecord({ memory_type: "episodic" }));
    await provider.remember(makeRecord({ memory_type: "policy" }));
    await provider.remember(makeRecord({ memory_type: "aspirational" }));
    await provider.remember(makeRecord({ memory_type: "procedural" }));

    assert.deepEqual(kinds, ["event", "commitment", "idea", "fact"]);
  });

  it("translates retention policy into a ttl", async () => {
    const ttls: unknown[] = [];
    const provider = new GBrainProvider({
      callTool: async (_name, args) => {
        ttls.push(args.ttl);
        return { id: 1, status: "inserted" };
      },
    });

    await provider.remember(makeRecord({ retention_policy: "ephemeral" }));
    await provider.remember(makeRecord({ retention_policy: "rolling_90d" }));
    await provider.remember(makeRecord({ retention_policy: "permanent" }));
    await provider.remember(
      makeRecord({ retention_policy: "delete_by", retention_until: "2026-12-01T00:00:00Z" }),
    );

    assert.deepEqual(ttls, ["24h", "90d", undefined, "2026-12-01T00:00:00Z"]);
  });

  it("rebuilds SIS records from recall hits", async () => {
    const provider = new GBrainProvider({
      callTool: async () => ({
        facts: [
          {
            id: 7,
            fact: "Test User left Example Corp in June 2030",
            entity_slug: "people/test-user",
            visibility: "world",
            confidence: 0.95,
            score: 0.81,
            matched_terms: ["example"],
          },
        ],
      }),
    });

    const results = await provider.recall({ tenant_id: "tenant_frank", query: "example" });

    assert.equal(results.length, 1);
    assert.equal(results[0].record.memory_id, "gbrain:7");
    assert.equal(results[0].record.tenant_id, "tenant_frank");
    assert.equal(results[0].record.privacy_class, "public");
    assert.equal(results[0].record.provenance[0].transform, "provider_imported");
    assert.equal(results[0].score, 0.81);
  });

  // These exercise the real transport. Everything above injects callTool, which
  // is why the handshake and the SSE body shape were both broken unnoticed.
  for (const mode of ["json", "sse"] as const) {
    it(`talks to a real MCP endpoint answering with ${mode}`, async () => {
      const srv = await mcpServer(mode);
      try {
        const provider = new GBrainProvider({ endpoint: srv.url, timeoutMs: 5000 });
        const record = await provider.remember(makeRecord());
        assert.equal(record.provider_shadow_refs.gbrain?.provider_record_id, "7");
        assert.equal(record.provider_shadow_refs.gbrain?.container, "facts:inserted");
        assert.equal(srv.seen[0], "initialize", `handshake skipped; saw ${srv.seen.join(",")}`);
        assert.ok(srv.seen.includes("tools/call"));
      } finally {
        await srv.close();
      }
    });
  }

  it("surfaces a transport failure instead of reporting a phantom success", async () => {
    const provider = new GBrainProvider({ endpoint: "http://127.0.0.1:1/mcp", timeoutMs: 1500 });
    await assert.rejects(() => provider.recall({ tenant_id: "tenant_frank", query: "x" }));
  });

  it("is routed only when hybrid_retrieval is on, and never for secrets", () => {
    const withFlag = routeMemoryRecord(makeRecord(), {
      tenant_id: "tenant_frank",
      hybrid_retrieval: true,
    });
    assert.ok(withFlag.some((route) => route.provider === "gbrain"));

    const withoutFlag = routeMemoryRecord(makeRecord(), { tenant_id: "tenant_frank" });
    assert.ok(!withoutFlag.some((route) => route.provider === "gbrain"));

    const secret = routeMemoryRecord(makeRecord({ privacy_class: "secret" }), {
      tenant_id: "tenant_frank",
      hybrid_retrieval: true,
    });
    assert.ok(!secret.some((route) => route.provider === "gbrain"));
  });
});
