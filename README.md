# Starlight Memory

<p align="center">
  <img src=".github/hero.svg" alt="Starlight Memory: sovereign local-core memory routing for AI agents" width="100%">
</p>

Local-first memory for agent fleets: a sovereign provider contract, router, and resource policy for the Starlight Intelligence System.

[![CI](https://github.com/frankxai/starlight-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/frankxai/starlight-memory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](package.json)
[![Built on SIP](https://img.shields.io/badge/built%20on-SIP-7c3aed)](https://github.com/frankxai/Starlight-Intelligence-System)
[![Memory](https://img.shields.io/badge/memory-local%20core%20first-0f766e)](docs/ADAPTER_CONTRACT.md)

SIS / `local_core` is the canonical authority: it owns memory IDs, provenance, retention, and policy. Everything else—Graphiti, Hindsight, Honcho, Mem0, and cloud access—is an optional derived provider or projection behind the contract. **Your vault is authoritative. Providers are replaceable. Remote access is projection-only.**

```text
Canonical SIS/local vault
        │ policy + privacy gate
        ├── optional derived provider projection (for example, Graphiti)
        └── optional signed cloud projection → read-only remote MCP recall
```

| Capability | Current evidence | Boundary |
|---|---|---|
| Local-first routing | Implemented and test-covered | Providers never become canonical |
| Optional Graphiti projection | Injected shared-client adapter with privacy, durable sanitized outbox, retry, and tenant tests | No Graphiti deployment is claimed |
| Signed cloud projection | Local exporter/gateway integration tests | Not a hosted service |
| Remote MCP recall | Authenticated local integration test | Production rollout remains gated |

> **Cloud status:** locally verified implementation only. No public endpoint, cloud write path, OAuth edge, or hosted-memory service is being claimed. See [Cloud Projection Boundary](docs/CLOUD_GATEWAY.md).

## Add persistent memory to any coding agent (MCP)

One server, one vault, every agent shares it — Claude Code, Codex, Cursor, Grok, Antigravity:

```bash
npx @starlight-intelligence/memory init --harness all   # writes an MCP snippet per agent
# merge each snippet into that agent's MCP config, then restart it
```

Seven tools over local stdio: `memory_recall`, `memory_search`, `memory_remember`, `memory_forget`, `vault_read`, `vault_list`, and `memory_stats`. Memory lives as filesystem-native markdown in your vault — sovereign, versioned, yours. Heavy providers fan in through this one gateway; never one runtime per terminal agent.

For cloud-hosted agents, use the separate authenticated, read-only Streamable HTTP gateway backed by an **Ed25519-signed, hash-verified summary projection**—never the canonical vault. The production gate remains explicit; see [`docs/CLOUD_GATEWAY.md`](docs/CLOUD_GATEWAY.md).

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
- **Cloud writes are derived/mirrored by policy.** `private` stays local by default; `private-shareable` is the explicit projection class. `secret` never leaves local core.
- **Evaluation decides defaults.** Providers earn default status through recall quality, latency, contradiction rate, cost, privacy, and exportability.

## Cross-machine sync CLI (`starlight-memory`)

A zero-dependency, cross-OS CLI that turns a git repo into a **memory vault** and links your agent's file-based memory dirs into it — so memory is versioned, backed up, and synced across every machine you work on.

Portable by construction:

- **Linking** uses `fs.symlink(type: 'junction')` on Windows (no admin) and `'dir'` symlinks on macOS/Linux — one code path, every OS.
- **Paths are computed per-machine** from a shared, logical-name config — nothing is hardcoded to a username or absolute path.
- **Sync is plain `git`** (any remote — GitHub, GitLab, self-hosted, local bare repo). No cloud SDK, no OS scheduler required.

```bash
# in your (private) vault repo:
npx @starlight-intelligence/memory discover     # list this machine's Claude memory dirs
# add the ones you want to starlight-memory.config.json (see the .example file)
npx @starlight-intelligence/memory wire          # symlink them into the vault
npx @starlight-intelligence/memory sync          # pull, then commit + push changes
npx @starlight-intelligence/memory status        # link state + git status
```

On a second machine: clone the vault, run `wire`, done — memory follows you. Run `sync` from any agent hook, `git` alias, or your own scheduler (launchd / cron / Task Scheduler) for hands-off operation. `unwire` cleanly restores real directories. Keep the vault repo **private** — it holds your actual memories; this package (the tooling) is the public, MIT part.

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
- `hindsight` — default graph/entity projection for compatibility.
- `graphiti` — optional temporal graph projection, explicitly selected per tenant and always behind the Starlight gateway.
- `supermemory` — enterprise connector/session ingest.
- `honcho` — peer/user modeling.
- `holographic`, `openviking`, `byterover` — local/dev memory accelerators.

### `estimateProviderResourcePlan(providers)`

Returns singleton/shared-daemon requirements so provider adapters do not accidentally spawn one heavyweight runtime per agent.

### `InMemoryLocalCoreProvider`

A zero-dependency local provider that implements the adapter contract for tests, development, and hot-path API proof. It enforces tenant isolation, explicit forget, and lexical recall without external services.

### `Mem0RemoteProvider`

A remote-only, client-injected Mem0 adapter. It queues writes, flushes batches, blocks `private` / `secret` / `regulated` records by default, and maps Mem0 result IDs back into SIS `provider_shadow_refs` without making Mem0 canonical.

### `GraphitiProjectionProvider`

An optional temporal graph projection behind one injected shared client. Remote mode accepts only `public` and `private-shareable` records by default, emits a minimal metadata allowlist, bounds tenant-scoped recall, and keeps local core authoritative. `private` records require either an explicit `local_shared_daemon` deployment or a tenant external-mirror opt-in.

Use `JsonFileGraphitiProjectionOutbox` on the shared gateway to make projection and deletion retries restart-safe. The outbox stores only the already-approved episode text plus canonical IDs; it never serializes a full `SISMemoryRecord`, raw vault content, entities, or relations.

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

When moving an existing memory-vault clone into the canonical estate, sync the old clone first and then run `starlight-memory wire --repoint-existing`. The command replaces only the junction; the previous target directory is left untouched.

See tests for full patterns and the fan-in benchmark.
