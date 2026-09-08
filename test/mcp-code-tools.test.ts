import test from "node:test";
import assert from "node:assert/strict";
import { CodeSymbolIndex } from "../src/code-symbol-index.js";
import { PGLiteVectorProvider } from "../src/pglite-provider.js";

test("CodeSymbolIndex indexes functions, classes, interfaces and resolves call references", async () => {
  const indexer = new CodeSymbolIndex();
  await indexer.indexDirectory("src", [".ts"]);

  const summary = indexer.getSummary();
  assert.ok(summary.totalFilesIndexed > 0, "Should index source files");
  assert.ok(summary.totalDefinitions > 0, "Should extract definitions");
  assert.ok(summary.totalReferences > 0, "Should extract references");

  // Check definitions for PGLiteVectorProvider
  const pgliteDefs = indexer.getDefinitions("PGLiteVectorProvider");
  assert.ok(pgliteDefs.length > 0, "Should find PGLiteVectorProvider class");
  assert.equal(pgliteDefs[0].kind, "class");

  // Check definitions for CodeSymbolIndex
  const indexDefs = indexer.getDefinitions("CodeSymbolIndex");
  assert.ok(indexDefs.length > 0, "Should find CodeSymbolIndex class");

  // Check definition for routeMemoryRecord function
  const routerDefs = indexer.getDefinitions("routeMemoryRecord");
  assert.ok(routerDefs.length > 0, "Should find routeMemoryRecord function");
  assert.equal(routerDefs[0].kind, "function");
});

test("PGLiteVectorProvider computes cosine similarity and ranks results", async () => {
  const pglite = new PGLiteVectorProvider({ embeddingDimension: 64 });

  await pglite.remember({
    memory_id: "m-1",
    tenant_id: "frank",
    source: { system: "unit-test" },
    modality: "text",
    memory_type: "semantic",
    raw_content: "Starlight Sovereign Memory with PGLite vector embeddings",
    normalized_fact: "PGLite vector embeddings run in-process",
    entities: [{ name: "PGLite" }],
    relations: [],
    importance: 0.9,
    confidence: 1.0,
    trust: 1.0,
    privacy_class: "private",
    retention_policy: "permanent",
    provenance: [],
    provider_shadow_refs: {},
  });

  await pglite.remember({
    memory_id: "m-2",
    tenant_id: "frank",
    source: { system: "unit-test" },
    modality: "text",
    memory_type: "semantic",
    raw_content: "Completely unrelated text about gardening and plants",
    normalized_fact: "Gardening involves watering plants",
    entities: [{ name: "Plants" }],
    relations: [],
    importance: 0.2,
    confidence: 0.5,
    trust: 0.5,
    privacy_class: "public",
    retention_policy: "permanent",
    provenance: [],
    provider_shadow_refs: {},
  });

  const recall = await pglite.recall({
    tenant_id: "frank",
    query: "PGLite vector embeddings",
    limit: 1,
  });

  assert.equal(recall.length, 1);
  assert.equal(recall[0].record.memory_id, "m-1");
  assert.ok(recall[0].score > 0.5);
});
