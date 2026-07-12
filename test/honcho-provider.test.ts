/**
 * Honcho remote adapter tests.
 *
 * The client is injected so the adapter remains offline-testable and never
 * creates one Honcho runtime per terminal coding agent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HonchoProvider,
  type HonchoClient,
  type SISMemoryRecord,
} from "../src/index.js";

function record(
  id: string,
  privacy_class: SISMemoryRecord["privacy_class"] = "private-shareable",
): SISMemoryRecord {
  return {
    memory_id: id,
    tenant_id: "tenant_frank",
    user_id: "frank",
    source: { system: "test", event_id: `evt_${id}`, session_id: "session_1" },
    modality: "text",
    memory_type: "profile",
    raw_content: "Raw private text must never be required for Honcho writes.",
    normalized_fact: "Frank prefers reasoning-first peer memory with SIS authority.",
    summary: "Honcho peer-modeling doctrine.",
    entities: [{ name: "Honcho" }],
    relations: [],
    importance: 0.8,
    confidence: 0.9,
    trust: 0.9,
    privacy_class,
    retention_policy: "permanent",
    provenance: [{ event_id: `evt_${id}`, transform: "raw", at: "2026-07-12T00:00:00.000Z" }],
    provider_shadow_refs: {},
  };
}

describe("HonchoProvider", () => {
  it("buffers turns and flushes a session batch through an injected client", async () => {
    const batches: Parameters<HonchoClient["addMessages"]>[0][] = [];
    const client: HonchoClient = {
      async addMessages(input) {
        batches.push(input);
        return { message_ids: input.messages.map((message) => message.id ?? "generated") };
      },
      async peerChat() { return { content: "", memories: [] }; },
      async deleteMessage() { return true; },
    };
    const provider = new HonchoProvider({ client, flush_batch_size: 10 });

    const saved = await provider.remember(record("sis_1"));
    assert.equal(batches.length, 0, "remember queues instead of making a synchronous network write");
    assert.equal(saved.provider_shadow_refs.honcho?.sync_state, "pending");

    const flushed = await provider.flush();
    assert.deepEqual(flushed, { attempted: 1, written: 1, failed: 0 });
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.workspace_id, "tenant_frank");
    assert.equal(batches[0]?.peer_id, "frank");
    assert.equal(batches[0]?.session_id, "session_1");
    assert.equal(batches[0]?.messages[0]?.id, "sis_1");
    assert.equal(
      batches[0]?.messages[0]?.content,
      "Frank prefers reasoning-first peer memory with SIS authority.",
    );
    assert.equal(batches[0]?.messages[0]?.metadata?.sis_memory_id, "sis_1");
  });

  it("blocks secret and regulated records unless external mirroring is explicitly allowed", async () => {
    let calls = 0;
    const client: HonchoClient = {
      async addMessages() { calls++; return {}; },
      async peerChat() { return { content: "", memories: [] }; },
    };
    const provider = new HonchoProvider({ client });

    const secret = await provider.remember(record("secret_1", "secret"));
    const regulated = await provider.remember(record("regulated_1", "regulated"));
    const flushed = await provider.flush();

    assert.equal(secret.provider_shadow_refs.honcho?.provider_record_id, "blocked_by_policy");
    assert.equal(regulated.provider_shadow_refs.honcho?.sync_state, "failed");
    assert.equal(flushed.written, 0);
    assert.equal(calls, 0);

    const allowed = new HonchoProvider({ client, allowExternalMirror: true });
    await allowed.remember(record("regulated_2", "regulated"));
    assert.equal((await allowed.flush()).written, 1);
    assert.equal(calls, 1);
  });

  it("uses peer.chat dialectic recall and maps evidence back to SIS shadow refs", async () => {
    const client: HonchoClient = {
      async addMessages() { return {}; },
      async peerChat(input) {
        assert.equal(input.workspace_id, "tenant_frank");
        assert.equal(input.query, "how does Frank prefer memory?");
        assert.equal(input.limit, 5);
        return {
          content: "Frank prefers a reasoning-first memory system.",
          memories: [{
            id: "honcho_1",
            content: "Reasoning-first peer memory",
            score: 0.82,
            metadata: { sis_memory_id: "sis_remote" },
          }],
        };
      },
    };
    const provider = new HonchoProvider({ client, peer_id: "frank" });

    const results = await provider.recall({
      tenant_id: "tenant_frank",
      query: "how does Frank prefer memory?",
      limit: 5,
    });

    assert.equal(results[0]?.record.memory_id, "sis_remote");
    assert.equal(results[0]?.record.provider_shadow_refs.honcho?.provider_record_id, "honcho_1");
    assert.equal(results[0]?.score, 0.82);
  });

  it("declares remote, batched, peer-modeling capabilities", () => {
    const client: HonchoClient = {
      async addMessages() { return {}; },
      async peerChat() { return { content: "", memories: [] }; },
    };
    const provider = new HonchoProvider({ client });
    assert.equal(provider.capabilities.process_model, "remote_api");
    assert.equal(provider.capabilities.authority, "peer_modeling");
    assert.equal(provider.capabilities.ram_profile, "remote");
    assert.equal(provider.capabilities.supports_batching, true);
    assert.equal(provider.capabilities.per_agent_instance_allowed, false);
  });
});
