# Provider adapter contract

Every provider adapter in this package must satisfy the `MemoryProvider` interface and the resource doctrine in `resources.ts`.

## Non-negotiable performance rule

Frank's target runtime is dozens of terminal agents on the same machine. A provider adapter must **not** assume one process per agent.

Allowed shapes:

- `embedded_lightweight` — safe in-process, small memory footprint, no heavy vector/graph server per agent.
- `shared_daemon` — one local service per machine/tenant, all agents fan in through SIS.
- `remote_api` — SaaS or self-hosted API with client-side batching/caching.
- `shared_daemon_or_remote_api` — local singleton or remote mode.
- `external_runtime` — bounded runtime workers only; never the canonical store.

## Required adapter metadata

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

## Required methods

```ts
interface MemoryProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;
  remember(record: SISMemoryRecord): Promise<SISMemoryRecord>;
  recall(request: RecallRequest): Promise<RecallResult[]>;
  forget(request: ForgetRequest): Promise<boolean>;
}
```

## Current concrete providers

- `InMemoryLocalCoreProvider` — test-only/dev-friendly local_core implementation. It proves the API and gives consumers a zero-dependency hot-path provider.
- `Mem0RemoteProvider` — remote-only, client-injected Mem0 adapter. It buffers writes, flushes in batches, blocks private/secret/regulated records by default, and maps Mem0 IDs back into SIS provider-shadow refs.
- `HonchoProvider` — remote peer-modeling adapter with the same fail-closed privacy boundary.
- `GraphitiProjectionProvider` — temporal graph projection with a shared-client boundary, minimal metadata allowlist, tenant isolation, tombstones, and optional durable sanitized outbox.

## External privacy invariant

- `public` and `private-shareable` may cross the trust boundary.
- `private` is local by default and requires an explicit tenant/provider opt-in for external projection.
- `regulated` requires its own explicit opt-in.
- `secret` is never externally mirrored.
- A remote adapter receives only approved fact/summary text and a minimal metadata allowlist. Full records, raw content, vault names, agent IDs, entities, and relations stay local.
- Retry state must be durable at the shared gateway when loss would violate deletion or projection guarantees. Durable queues must serialize sanitized projection envelopes, never full canonical records.

Built on SIP — provider adapter contract.

## Evolution notes (2026-06-18)

- Added Mem0RemoteProvider (remote_api, batched, privacy-first).
- Added fan-in benchmark proving 50 concurrent agent simulation with single lightweight provider.
- Evolved package exports for subpath imports.
- All adapters must still satisfy the resource doctrine in resources.ts.

## Evolution notes (2026-07-29)

- Made private external mirroring fail closed across the router, Mem0, Honcho, and remote Graphiti.
- Added explicit local-shared-daemon routing for private graph projection.
- Removed structured/sensitive metadata from external projection envelopes.
- Added `JsonFileGraphitiProjectionOutbox` for restart-safe sanitized projection/deletion retries.
