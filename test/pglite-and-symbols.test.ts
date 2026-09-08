import test from "node:test";
import assert from "node:assert/strict";
import { PGLiteVectorProvider } from "../src/pglite-provider.js";
import { CodeSymbolIndex } from "../src/code-symbol-index.js";
import type { SISMemoryRecord } from "../src/types.js";

test("PGLiteVectorProvider stores and recalls records by vector similarity", async () => {
  const provider = new PGLiteVectorProvider({ embeddingDimension: 128 });

  const record1: SISMemoryRecord = {
    memory_id: "mem-001",
    tenant_id: "tenant-starlight",
    source: { system: "antigravity" },
    modality: "text",
    memory_type: "semantic",
    raw_content: "Autonomous swarms use PGLite vector embeddings for sub-millisecond recall.",
    normalized_fact: "PGLite provides zero-daemon embedded PostgreSQL vector search.",
    entities: [{ name: "PGLite" }, { name: "Starlight" }],
    relations: [],
    importance: 0.9,
    confidence: 0.95,
    trust: 1.0,
    privacy_class: "private",
    retention_policy: "permanent",
    provenance: [],
    provider_shadow_refs: {},
  };

  const record2: SISMemoryRecord = {
    memory_id: "mem-002",
    tenant_id: "tenant-starlight",
    source: { system: "antigravity" },
    modality: "text",
    memory_type: "episodic",
    raw_content: "Suno AI track generation completed with 845 audio files.",
    normalized_fact: "Suno music library contains 845 tracks.",
    entities: [{ name: "Suno" }],
    relations: [],
    importance: 0.5,
    confidence: 0.8,
    trust: 0.9,
    privacy_class: "public",
    retention_policy: "permanent",
    provenance: [],
    provider_shadow_refs: {},
  };

  await provider.remember(record1);
  await provider.remember(record2);

  const results = await provider.recall({
    tenant_id: "tenant-starlight",
    query: "PGLite vector database recall",
    limit: 5,
  });

  assert.ok(results.length > 0, "Should recall results");
  assert.equal(results[0].record.memory_id, "mem-001", "Most relevant record should be first");
  assert.ok(results[0].score > 0, "Score should be positive");
});

test("CodeSymbolIndex parses definitions and callers", async () => {
  const indexer = new CodeSymbolIndex();
  await indexer.indexDirectory("src", [".ts"]);

  const summary = indexer.getSummary();
  assert.ok(summary.totalFilesIndexed > 0, "Should index files");
  assert.ok(summary.totalDefinitions > 0, "Should find symbol definitions");

  const pgliteDefs = indexer.getDefinitions("PGLiteVectorProvider");
  assert.ok(pgliteDefs.length > 0, "Should find PGLiteVectorProvider definition");
  assert.equal(pgliteDefs[0].kind, "class");
});
