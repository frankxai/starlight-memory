# Provider Adapter Contract

Every provider adapter in this package must satisfy the `MemoryProvider` interface and the resource doctrine in `resources.ts`.

---

## Non-negotiable Performance Rule

Frank's target runtime is dozens of concurrent terminal agents on the same machine. A provider adapter must **not** assume one process per agent.

Allowed shapes:
- `embedded_lightweight` — Safe in-process, small memory footprint, no heavy vector/graph server per agent.
- `shared_daemon` — One local service per machine/tenant, all agents fan in through SIS.
- `remote_api` — SaaS or self-hosted API with client-side batching/caching.
- `shared_daemon_or_remote_api` — Local singleton or remote mode.
- `external_runtime` — Bounded runtime workers only; never the canonical store.

---

## Required Adapter Metadata

Each adapter must define `ProviderCapabilities`:

```ts
{
  provider: 'mem0',
  process_model: 'remote_api',
  authority: 'accelerator',
  ram_profile: 'remote',
  supports_batching: true,
  per_agent_instance_allowed: false,
  notes: 'Use behind SIS gateway; never spawn per terminal.'
}
```

---

## Required Methods

```ts
interface MemoryProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;
  remember(record: SISMemoryRecord): Promise<SISMemoryRecord>;
  recall(request: RecallRequest): Promise<RecallResult[]>;
  forget(request: ForgetRequest): Promise<boolean>;
}
```

---

## Active Concrete Providers (July 2026 Ground Truth)

1. **`LocalCoreProvider` (`local_core`)**:
   - In-process, plaintext file-based system of record.
   - Proves the API and gives consumers a zero-dependency, private local database.
2. **`Mem0RemoteProvider` (`mem0`)**:
   - Remote/local client-injected Mem0 adapter.
   - Buffers writes, flushes in batches, blocks secret/regulated records, and maps Mem0 IDs back into provider-shadow references.
3. **`HindsightProvider` (`hindsight`)**:
   - Cloud or local daemon graph projection adapter.
   - Integrates Vectorize.io Knowledge Graph (KG) retrieval and entity-resolution.
4. **`HonchoProvider` (`honcho`)**:
   - Local SQLite-backed Theory-of-Mind (ToM) peer-modeling adapter.
   - Batches write flushes, gates privacy-classes, and provides dialectic recall. Subject to AGPL-3.0 copyleft.

---

## Evolution Notes

### 2026-07-12
- Integrated `hindsight-provider` and `honcho-provider` under the `MemoryProvider` interface.
- Verified all 4 providers in `eval/provider-recall.mjs` test suite. All tests passing green.
- Wired the unified MCP server `src/mcp/server.mjs` directly to all 4 client harnesses.

### 2026-06-18
- Added `Mem0RemoteProvider` (remote_api, batched, privacy-first).
- Added fan-in benchmark proving 50 concurrent agent simulation with single lightweight provider.
