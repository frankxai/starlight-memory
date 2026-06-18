# starlight-memory — Agent Instructions

> Sovereign memory provider contract, router, and resource policy for the Starlight Intelligence System.

This repo is a focused extraction point from `Starlight-Intelligence-System`. SIS remains the canonical control plane; this package defines reusable contracts and resource-aware routing primitives.

## Doctrine

1. `local_core` / SIS remains authoritative.
2. External providers are adapters, accelerators, or runtimes — never primary truth.
3. Optimize for Frank's real machine shape: dozens of terminal coding agents per host.
4. Never introduce provider code that spawns heavyweight memory runtimes per agent process.
5. Prefer shared daemon, remote API, or embedded-lightweight patterns with bounded caches.
6. Any new provider must declare process model, RAM profile, batching support, and per-agent-instance policy.
7. Add tests before production code.

## Commands

```bash
npm test
npm run lint
npm run build
npm run verify
```

## Key files

- `src/types.ts` — provider-neutral SIS memory record and policy types.
- `src/router.ts` — privacy-aware provider routing.
- `src/resources.ts` — provider resource profiles and singleton/shared-daemon constraints.
- `src/local-core-provider.ts` — zero-dependency in-memory `local_core` provider for tests/dev and hot-path API proof.
- `test/*.test.ts` — regression tests for routing, resource doctrine, tenant isolation, recall, and forget behavior.
- `docs/ADAPTER_CONTRACT.md` — adapter implementation contract.
- `docs/strategic/sis-memory-provider-strategy-2026-06-18.md` — strategic architecture.

Built on SIP — sovereign memory router.
