import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GraphitiProjectionProvider,
  type GraphitiClient,
  type SISMemoryRecord,
} from "../src/index.js";

function record(
  id: string,
  privacy_class: SISMemoryRecord["privacy_class"] = "private-shareable",
): SISMemoryRecord {
  return {
    memory_id: id,
    tenant_id: "tenant_frank",
    workspace_id: "starlight-memory",
    source: { system: "test", event_id: `evt_${id}` },
    modality: "text",
    memory_type: "semantic",
    raw_content: "Raw vault content must never be sent to Graphiti.",
    normalized_fact: "Starlight local_core remains canonical while Graphiti is an optional graph projection.",
    summary: "Graphiti is a derived projection.",
    entities: [{ name: "Starlight", type: "system" }],
    relations: [{ subject: "Starlight", predicate: "projects_to", object: "Graphiti" }],
    importance: 0.8,
    confidence: 0.9,
    trust: 0.9,
    privacy_class,
    retention_policy: "permanent",
    provenance: [{ event_id: `evt_${id}`, transform: "raw", at: "2026-07-27T00:00:00.000Z" }],
    provider_shadow_refs: {},
  };
}

describe("GraphitiProjectionProvider", () => {
  it("queues redacted graph episodes and flushes them through one injected shared client", async () => {
    const writes: Parameters<GraphitiClient["addEpisode"]>[0][] = [];
    const client: GraphitiClient = {
      async addEpisode(input) {
        writes.push(input);
        return { id: `graphiti_${input.name}` };
      },
      async searchFacts() { return []; },
      async deleteByMemoryId() { return true; },
    };
    const provider = new GraphitiProjectionProvider({ client, flush_batch_size: 10 });

    const saved = await provider.remember(record("sis_1"));
    assert.equal(saved.provider_shadow_refs.graphiti?.sync_state, "pending");
    assert.equal(writes.length, 0, "remember queues remote graph writes");

    const flushed = await provider.flush();
    assert.deepEqual(flushed, { attempted: 1, written: 1, failed: 0 });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.group_id, "tenant_frank");
    assert.equal(writes[0]?.name, "sis_1");
    assert.equal(writes[0]?.episode_body, record("sis_1").normalized_fact);
    assert.equal(writes[0]?.episode_body.includes("Raw vault content"), false);
    assert.equal(writes[0]?.metadata?.sis_memory_id, "sis_1");
    assert.equal(writes[0]?.metadata?.tenant_id, "tenant_frank");
  });

  it("blocks secret and regulated records before they can enter the graph projection", async () => {
    let writes = 0;
    const client: GraphitiClient = {
      async addEpisode() { writes++; return { id: "graphiti_unexpected" }; },
      async searchFacts() { return []; },
      async deleteByMemoryId() { return true; },
    };
    const provider = new GraphitiProjectionProvider({ client });

    const secret = await provider.remember(record("secret_1", "secret"));
    const regulated = await provider.remember(record("regulated_1", "regulated"));
    const flushed = await provider.flush();

    assert.equal(secret.provider_shadow_refs.graphiti?.provider_record_id, "blocked_by_policy");
    assert.equal(regulated.provider_shadow_refs.graphiti?.sync_state, "failed");
    assert.equal(flushed.written, 0);
    assert.equal(writes, 0);
  });

  it("uses tenant-scoped graph recall and rejects cross-tenant facts returned by an upstream client", async () => {
    const client: GraphitiClient = {
      async addEpisode() { return { id: "unused" }; },
      async searchFacts(input) {
        assert.deepEqual(input.group_ids, ["tenant_frank"]);
        return [
          {
            id: "graphiti_1",
            fact: "Starlight projects approved graph-shaped memory to Graphiti.",
            score: 0.84,
            metadata: { tenant_id: "tenant_frank", sis_memory_id: "sis_remote" },
          },
          {
            id: "graphiti_other_tenant",
            fact: "Must never return this cross-tenant graph fact.",
            score: 0.99,
            metadata: { tenant_id: "other_tenant" },
          },
        ];
      },
      async deleteByMemoryId() { return true; },
    };
    const provider = new GraphitiProjectionProvider({ client });

    const results = await provider.recall({ tenant_id: "tenant_frank", query: "graph projection", limit: 5 });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.record.memory_id, "sis_remote");
    assert.equal(results[0]?.record.provider_shadow_refs.graphiti?.provider_record_id, "graphiti_1");
    assert.equal(results[0]?.score, 0.84);
  });

  it("bounds Graphiti recall input before it reaches the shared remote service", async () => {
    let received: Parameters<GraphitiClient["searchFacts"]>[0] | undefined;
    const client: GraphitiClient = {
      async addEpisode() { return { id: "unused" }; },
      async searchFacts(input) { received = input; return []; },
      async deleteByMemoryId() { return true; },
    };
    const provider = new GraphitiProjectionProvider({ client });
    await provider.recall({ tenant_id: "tenant_frank", query: "bounded", limit: 999 });
    assert.equal(received?.limit, 20);
    await assert.rejects(provider.recall({ tenant_id: "tenant_frank", query: "x".repeat(513), limit: 1 }));
  });

  it("requires an explicit policy opt-in before a regulated record can be projected", async () => {
    const client: GraphitiClient = {
      async addEpisode() { return { id: "graphiti_regulated" }; },
      async searchFacts() { return []; },
      async deleteByMemoryId() { return true; },
    };
    const provider = new GraphitiProjectionProvider({ client, allowExternalMirror: true });

    const secret = await provider.remember(record("secret_even_when_enabled", "secret"));
    await provider.remember(record("regulated_allowed", "regulated"));
    assert.equal(secret.provider_shadow_refs.graphiti?.provider_record_id, "blocked_by_policy");
    assert.deepEqual(await provider.flush(), { attempted: 1, written: 1, failed: 0 });
  });

  it("deletes again when a canonical forget races an in-flight Graphiti add", async () => {
    const calls: string[] = [];
    let releaseAdd: (() => void) | undefined;
    const addStarted = new Promise<void>((resolve) => { releaseAdd = resolve; });
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const client: GraphitiClient = {
      async addEpisode() {
        calls.push("add");
        signalStarted?.();
        await addStarted;
        return { id: "race" };
      },
      async searchFacts() { return []; },
      async deleteByMemoryId() { calls.push("delete"); return true; },
    };
    const provider = new GraphitiProjectionProvider({ client });
    await provider.remember(record("racing"));
    const flushing = provider.flush();
    await started;
    await provider.forget({ tenant_id: "tenant_frank", memory_id: "racing" });
    releaseAdd?.();
    await flushing;
    assert.deepEqual(calls, ["add", "delete", "delete"]);
  });

  it("cancels queued projection work when the canonical record is forgotten", async () => {
    let writes = 0;
    const client: GraphitiClient = {
      async addEpisode() { writes++; return { id: "unexpected" }; },
      async searchFacts() { return []; },
      async deleteByMemoryId() { return true; },
    };
    const provider = new GraphitiProjectionProvider({ client });
    await provider.remember(record("forgotten"));
    assert.equal(provider.pendingCount(), 1);
    await provider.forget({ tenant_id: "tenant_frank", memory_id: "forgotten" });
    assert.equal(provider.pendingCount(), 0);
    assert.deepEqual(await provider.flush(), { attempted: 0, written: 0, failed: 0 });
    assert.equal(writes, 0);
  });

  it("keeps failed graph deletions queued for retry while canonical deletion remains authoritative", async () => {
    let deleteAttempts = 0;
    const client: GraphitiClient = {
      async addEpisode() { return { id: "unused" }; },
      async searchFacts() { return []; },
      async deleteByMemoryId() {
        deleteAttempts++;
        return deleteAttempts > 1;
      },
    };
    const provider = new GraphitiProjectionProvider({ client });
    assert.equal(await provider.forget({ tenant_id: "tenant_frank", memory_id: "delete_retry" }), false);
    assert.equal(provider.pendingCount(), 1);
    assert.deepEqual(await provider.flush(), { attempted: 1, written: 1, failed: 0 });
    assert.equal(provider.pendingCount(), 0);
    assert.equal(deleteAttempts, 2);
  });

  it("retains failed derived writes for retry instead of silently losing projection state", async () => {
    let attempts = 0;
    const client: GraphitiClient = {
      async addEpisode() {
        attempts++;
        if (attempts === 1) throw new Error("transient graph outage");
        return { id: "retried" };
      },
      async searchFacts() { return []; },
      async deleteByMemoryId() { return true; },
    };
    const provider = new GraphitiProjectionProvider({ client });
    await provider.remember(record("retryable"));
    assert.deepEqual(await provider.flush(), { attempted: 1, written: 0, failed: 1 });
    assert.equal(provider.pendingCount(), 1);
    assert.deepEqual(await provider.flush(), { attempted: 1, written: 1, failed: 0 });
    assert.equal(provider.pendingCount(), 0);
  });

  it("declares Graphiti as a singleton shared daemon or remote graph accelerator", () => {
    const client: GraphitiClient = {
      async addEpisode() { return { id: "unused" }; },
      async searchFacts() { return []; },
      async deleteByMemoryId() { return true; },
    };
    const provider = new GraphitiProjectionProvider({ client });
    assert.equal(provider.capabilities.process_model, "shared_daemon_or_remote_api");
    assert.equal(provider.capabilities.authority, "graph_synthesis");
    assert.equal(provider.capabilities.per_agent_instance_allowed, false);
  });
});
