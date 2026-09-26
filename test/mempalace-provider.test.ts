/**
 * MemPalace adapter tests.
 *
 * MemPalace is the local verbatim layer ("what was said"). The adapter is
 * client-injected so one MemPalace MCP server per machine serves every agent,
 * and SIS keeps memory_id authority.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MemPalaceProvider,
  routeMemoryRecord,
  type MemPalaceClient,
  type SISMemoryRecord,
} from "../src/index.js";

function record(id: string, privacy_class: SISMemoryRecord["privacy_class"] = "private"): SISMemoryRecord {
  return {
    memory_id: id,
    tenant_id: "tenant_frank",
    source: { system: "claude-code", event_id: `evt_${id}`, session_id: "sess_1" },
    modality: "text",
    memory_type: "episodic",
    vault: "technical",
    raw_content: "Verbatim: we chose local_core as authority and MemPalace for recall of exact wording.",
    normalized_fact: "local_core is authority; MemPalace is verbatim recall.",
    entities: [],
    relations: [],
    importance: 0.7,
    confidence: 0.9,
    trust: 0.9,
    privacy_class,
    retention_policy: "permanent",
    provenance: [{ event_id: `evt_${id}`, transform: "raw", at: "2026-09-26T00:00:00.000Z" }],
    provider_shadow_refs: {},
  };
}

function noopClient(overrides: Partial<MemPalaceClient> = {}): MemPalaceClient {
  return {
    async addDrawer() { return { id: "drawer_unused" }; },
    async search() { return []; },
    async deleteDrawer() { return true; },
    ...overrides,
  };
}

describe("MemPalaceProvider", () => {
  it("queues verbatim drawers into wing=tenant, room=vault and flushes through the injected client", async () => {
    const added: Array<{ wing: string; room: string; content: string; metadata: Record<string, unknown> }> = [];
    const provider = new MemPalaceProvider({
      client: noopClient({
        async addDrawer(input) { added.push(input); return { id: `drawer_${added.length}` }; },
      }),
    });

    const saved = await provider.remember(record("sis_1"));
    assert.equal(added.length, 0, "remember queues instead of writing synchronously");
    assert.equal(saved.provider_shadow_refs.mempalace?.sync_state, "pending");
    assert.equal(saved.provider_shadow_refs.mempalace?.container, "sis_tenant_frank/technical");

    const flushed = await provider.flush();
    assert.equal(flushed.written, 1);
    assert.equal(added[0]?.wing, "sis_tenant_frank");
    assert.equal(added[0]?.room, "technical");
    assert.match(added[0]?.content ?? "", /^Verbatim:/);
    assert.equal(added[0]?.metadata.sis_memory_id, "sis_1");
  });

  it("sends the normalized fact instead of raw text when verbatim is disabled", async () => {
    const added: string[] = [];
    const provider = new MemPalaceProvider({
      verbatim: false,
      client: noopClient({ async addDrawer(input) { added.push(input.content); return { id: "d" }; } }),
    });
    await provider.remember(record("sis_2"));
    await provider.flush();
    assert.equal(added[0], "local_core is authority; MemPalace is verbatim recall.");
  });

  it("blocks secret and regulated records unless regulated is explicitly allowed", async () => {
    let calls = 0;
    const provider = new MemPalaceProvider({
      client: noopClient({ async addDrawer() { calls++; return { id: "forbidden" }; } }),
    });

    const secret = await provider.remember(record("secret_1", "secret"));
    const regulated = await provider.remember(record("regulated_1", "regulated"));
    await provider.flush();

    assert.equal(secret.provider_shadow_refs.mempalace?.sync_state, "failed");
    assert.equal(regulated.provider_shadow_refs.mempalace?.sync_state, "failed");
    assert.equal(calls, 0);
  });

  it("recalls drawers scoped to the tenant wing and maps them back to SIS ids", async () => {
    const provider = new MemPalaceProvider({
      client: noopClient({
        async search(input) {
          assert.equal(input.wing, "sis_tenant_frank");
          return [
            { id: "drawer_9", content: "exact words", score: 0.81, wing: "sis_tenant_frank", room: "technical", metadata: { sis_memory_id: "sis_9" } },
            { id: "drawer_10", content: "weak match", score: 0.1 },
          ];
        },
      }),
    });

    const results = await provider.recall({ tenant_id: "tenant_frank", query: "exact words", min_score: 0.5 });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.record.memory_id, "sis_9");
    assert.equal(results[0]?.record.raw_content, "exact words");
    assert.equal(results[0]?.record.provider_shadow_refs.mempalace?.container, "sis_tenant_frank/technical");
  });

  it("declares a shared per-machine daemon, never a per-agent instance", () => {
    const provider = new MemPalaceProvider({ client: noopClient() });
    assert.equal(provider.capabilities.process_model, "shared_daemon");
    assert.equal(provider.capabilities.per_agent_instance_allowed, false);
  });

  it("is routed as a derived local write only when verbatim_recall is on and never for secret records", () => {
    const on = routeMemoryRecord(record("r1"), { tenant_id: "tenant_frank", verbatim_recall: true });
    assert.deepEqual(on.map((r) => [r.provider, r.mode]), [
      ["local_core", "canonical_write"],
      ["mempalace", "derived_local_write"],
    ]);

    const off = routeMemoryRecord(record("r2"), { tenant_id: "tenant_frank" });
    assert.ok(!off.some((r) => r.provider === "mempalace"));

    const secret = routeMemoryRecord(record("r3", "secret"), { tenant_id: "tenant_frank", verbatim_recall: true });
    assert.deepEqual(secret.map((r) => r.provider), ["local_core"]);
  });
});
