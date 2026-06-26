# Starlight Memory

Sovereign memory provider contract, router, and resource policy for the Starlight Intelligence System.

[![CI](https://github.com/frankxai/starlight-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/frankxai/starlight-memory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](package.json)
[![Built on SIP](https://img.shields.io/badge/built%20on-SIP-7c3aed)](https://github.com/frankxai/Starlight-Intelligence-System)
[![Memory](https://img.shields.io/badge/memory-local%20core%20first-0f766e)](docs/ADAPTER_CONTRACT.md)

This repo is the extraction point for the memory layer, but SIS remains the canonical control plane. The package is intentionally small right now: it locks the provider-neutral schema, routing policy, and resource constraints before heavier adapters are added.

## 90-second start

Use this repo when an agent or application needs the SIS memory contract, privacy-aware routing policy, or a lightweight local provider for tests and development.

```bash
git clone https://github.com/frankxai/starlight-memory.git
cd starlight-memory
npm ci
npm run verify
```

Start with:

- [`docs/ADAPTER_CONTRACT.md`](docs/ADAPTER_CONTRACT.md) for provider requirements.
- [`src/types.ts`](src/types.ts) for the canonical SIS memory record and policy types.
- [`src/router.ts`](src/router.ts) for routing behavior.
- [`src/resources.ts`](src/resources.ts) for singleton/shared-daemon constraints.

## Core doctrine

- **SIS/local_core is authoritative.** External systems are adapters, accelerators, or runtime integrations.
- **Provider IDs are secondary indexes.** SIS owns `memory_id`, provenance, privacy class, retention, and trust.
- **Dozens of agents per machine is the target environment.** Heavy providers must run as shared daemons or remote APIs — never one provider runtime per terminal coding agent.
- **Cloud writes are derived/mirrored by policy.** Sensitive memory stays local unless explicit tenant policy allows otherwise.
- **Evaluation decides defaults.** Providers earn default status through recall quality, latency, contradiction rate, cost, privacy, and exportability.

## Current package surface

```ts
import {
  routeMemoryRecord,
  estimateProviderResourcePlan,
  DEFAULT_PROVIDER_CAPABILITIES,
  type SISMemoryRecord,
  type TenantMemoryPolicy,
} from '@starlight-intelligence/memory';
```

### `routeMemoryRecord(record, policy)`

Routes a SIS memory record through the canonical local write plus optional mirrors:

- `local_core` — always first, always canonical.
- `mem0` — optional redacted cloud fact mirror.
- `hindsight` — graph/entity projection.
- `supermemory` — enterprise connector/session ingest.
- `honcho` — peer/user modeling.
- `holographic`, `openviking`, `byterover` — local/dev memory accelerators.

### `estimateProviderResourcePlan(providers)`

Returns singleton/shared-daemon requirements so provider adapters do not accidentally spawn one heavyweight runtime per agent.

### `InMemoryLocalCoreProvider`

A zero-dependency local provider that implements the adapter contract for tests, development, and hot-path API proof. It enforces tenant isolation, explicit forget, and lexical recall without external services.

### `Mem0RemoteProvider`

A remote-only, client-injected Mem0 adapter. It queues writes, flushes batches, blocks `secret` / `regulated` records by default, and maps Mem0 result IDs back into SIS `provider_shadow_refs` without making Mem0 canonical.

## Adapter contract

See [`docs/ADAPTER_CONTRACT.md`](docs/ADAPTER_CONTRACT.md).

## Development

```bash
npm install
npm test
npm run lint
npm run build
npm run verify
```

## Strategy doc

See [`docs/strategic/sis-memory-provider-strategy-2026-06-18.md`](docs/strategic/sis-memory-provider-strategy-2026-06-18.md).

## Relationship to SIS

This repository is created alongside the in-SIS implementation. Short term, SIS consumes/hosts the live operational version under `src/memory-provider/`. Long term, this repo becomes the shared package once the interface survives real adapters and evaluation.

Built on SIP — sovereign memory router.

## Quick usage

```ts
import {
  InMemoryLocalCoreProvider,
  Mem0RemoteProvider,
  type SISMemoryRecord,
} from '@starlight-intelligence/memory';

// Local core (sovereign, hot path)
const local = new InMemoryLocalCoreProvider();
await local.remember(myRecord);

// Mem0 remote (batched accelerator)
const mem0 = new Mem0RemoteProvider({ client: myMem0Client });
await mem0.remember(record);
await mem0.flush(); // explicit batch

// Fan-in safe: dozens of agents route through one instance
```

See tests for full patterns and the fan-in benchmark.
