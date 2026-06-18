# Starlight Memory

Sovereign memory provider contract, router, and resource policy for the Starlight Intelligence System.

This repo is the extraction point for the memory layer, but SIS remains the canonical control plane. The package is intentionally small right now: it locks the provider-neutral schema, routing policy, and resource constraints before heavier adapters are added.

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
