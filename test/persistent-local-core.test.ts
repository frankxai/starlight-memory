/**
 * TDD for PersistentLocalCoreProvider.
 * Goal: local_core must survive process restart (real persistence).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PersistentLocalCoreProvider } from "../src/persistent-local-core-provider.js";
import type { SISMemoryRecord } from "../src/types.js";

const TEST_DB = path.join(process.cwd(), "test", "tmp-persistent-core.db");

function makeRecord(id: string, tenant = "tenant_test"): SISMemoryRecord {
  return {
    memory_id: id,
    tenant_id: tenant,
    source: { system: "test" },
    modality: "text",
    memory_type: "episodic",
    normalized_fact: `Persistent fact ${id}`,
    entities: [],
    relations: [],
    importance: 0.8,
    confidence: 0.9,
    trust: 0.85,
    privacy_class: "private-shareable",
    retention_policy: "permanent",
    provenance: [],
    provider_shadow_refs: {},
  };
}

describe("PersistentLocalCoreProvider (real persistence)", () => {
  before(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  after(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("survives restart — data written in one instance is visible in a fresh instance", async () => {
    // First instance writes
    const p1 = new PersistentLocalCoreProvider({ dbPath: TEST_DB });
    await p1.remember(makeRecord("persist_1"));
    await p1.remember(makeRecord("persist_2"));
    // Simulate process exit (no close needed for better-sqlite3 in this pattern)

    // Fresh instance must see the data
    const p2 = new PersistentLocalCoreProvider({ dbPath: TEST_DB });
    const results = await p2.recall({ tenant_id: "tenant_test", query: "persist", limit: 5 });

    assert.ok(results.length >= 2, "must retrieve persisted records after restart");
    assert.ok(results.some(r => r.record.memory_id === "persist_1"));
    assert.ok(results.some(r => r.record.memory_id === "persist_2"));
  });

  it("enforces tenant isolation even with persistence", async () => {
    const p = new PersistentLocalCoreProvider({ dbPath: TEST_DB });
    await p.remember(makeRecord("iso_1", "tenant_a"));
    await p.remember(makeRecord("iso_2", "tenant_b"));

    const a = await p.recall({ tenant_id: "tenant_a", query: "iso", limit: 10 });
    const b = await p.recall({ tenant_id: "tenant_b", query: "iso", limit: 10 });

    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].record.tenant_id, "tenant_a");
  });
});
