# Mem0 vs MemPalace vs Starlight Memory: compete or harmonize

**Date:** 2026-09-26
**Status:** strategic position + shipped adapter (this PR)
**Sources:** mem0ai/mem0 README and research page (Apr 2026 algorithm); MemPalace/mempalace README (v3.10, 59.3k stars, last commit 2026-09-24) plus issues #29, #39, #314 and #2387; SIS `phase0/` eval-50 and `tools/proving-ground/scorecards/2026-06-1*-memory-lane-*`.

---

## Verdict

These three don't sit on the same axis, so treat them as layers, not rivals.

| | Mem0 | MemPalace | Starlight Memory |
|---|---|---|---|
| Answers | what is true about the user (extracted facts) | what was said (verbatim drawers) | who owns this memory, who may see it, and whether a claim about it can be proven |
| Unit | extracted fact + entity links | verbatim drawer in wing/room, KG triples | `SISMemoryRecord` with SIS-owned `memory_id`, privacy class, retention, provenance, shadow refs |
| Write path | 1 LLM call, ADD-only (no UPDATE/DELETE since Apr 2026) | no LLM, store everything | canonical write first, then policy-gated derived writes |
| Business | API/platform, paid per usage; OSS SDK | free, MIT, local | sovereign substrate (MIT) + governed estate (commercial) |
| Benchmarks (vendor) | LoCoMo 92.5, LongMemEval 94.4, BEAM-10M 48.6 at ~7K tokens/query; open harness | LongMemEval R@5 96.6% raw retrieval | none published on public sets |
| Benchmarks (independent) | not yet reproduced by us | official scorer recall_all@5 **0.870**; end-to-end QA with GPT-4o judge **0.668** raw, **0.532** AAAK | internal eval-50: sovereign recall@5 36% vs Chroma 44%; RRF hybrid 0.690 recall@5 on 29 lexically judged queries |
| Moat | distribution (SDK/platform integrations), extraction quality | virality, zero cost, verbatim fidelity | authority, policy, multi-provider fan-in, signed projections, attestation |

**Positioning line:** Mem0 remembers facts. MemPalace remembers words. Starlight decides who owns the memory.

## Where not to compete

Retrieval accuracy on public benchmarks. Both outrun `local_core` today, and our own numbers show it (Chroma beat sovereign by 8pp recall@5 on eval-50; our best hybrid is 0.690 recall@5 on an internal, lexically judged set that isn't comparable to theirs). Retrieval is table stakes that commoditizes quarterly. Any quarter spent chasing a LongMemEval headline is a quarter not spent on the layer nobody else owns.

## Where Starlight wins by construction

1. **Truth reconciliation moved upstream, and nobody picked it up.** Mem0's 2026 algorithm dropped UPDATE/DELETE, so memories accumulate. MemPalace stores everything verbatim. Both push "which of these is still true" to the caller. Starlight already carries `trust`, `confidence`, `provenance` and `retention_policy` per record; adding supersession, contradiction and validity windows at read time makes it the reconciliation layer above both.
2. **Forgetting is a governance problem.** ADD-only stores and verbatim stores can't honor "forget this" without a canonical ID → provider ID map. `provider_shadow_refs` is that map. Neither product has one across providers.
3. **Fan-in.** MemPalace ships per-harness hooks (Claude Code, Codex, Cursor) against a local Chroma writer. Run twenty terminal agents and you get twenty writers on one store. The SIS gateway (one MCP server, one writer per machine) is the fix, and it's already the doctrine in `ADAPTER_CONTRACT.md`.
4. **Honest evals as a product.** MemPalace's launch claims (100% LongMemEval, 100% LoCoMo via `top_k=50`) were walked back after public audits, and #2387 (2026-08-29) reports the remediations still hadn't shipped four months later. A neutral observatory that runs official scorers and publishes signed scorecards is a position neither vendor can credibly hold about itself.

## Harmonized stack (what this PR ships)

```text
agent (Claude Code / Codex / Cursor / Grok / Antigravity)
        │  one MCP gateway per machine
        ▼
local_core (authority: memory_id, privacy, retention, provenance)
        ├── MemPalace   derived_local_write   verbatim "what was said"   policy.verbatim_recall
        ├── Mem0        redacted_fact_write   extracted "what is true"   policy.default_cloud_memory (self-hosted OSS first)
        ├── Hindsight / Graphiti  graph_projection   entities + relations
        └── Honcho      peer_observation      theory of mind (opt-in, AGPL)
```

Shipped here:

- `src/mempalace-provider.ts`: client-injected MemPalace adapter. Wing = `sis_<tenant>`, room = vault (or memory type). Verbatim by default because the store is local. `secret` is always blocked; `regulated` is blocked unless allowed explicitly. Writes are batched and recall maps back to SIS ids.
- `resources.ts`: MemPalace declared `shared_daemon` with `per_agent_instance_allowed: false`.
- `router.ts` / `types.ts`: `verbatim_recall` policy flag. For local-only tenants, set `local_provider: "mempalace"` instead.
- `tools/memory-observatory.mjs`: MemPalace added as the `verbatim-recall` role, with its benchmark tagged **disputed** so it gets no recall boost. The Mem0 entry now reflects the Apr 2026 algorithm. `recommend` gains a verbatim slot.
- `test/mempalace-provider.test.ts`: 6 tests covering batching, wing/room mapping, verbatim toggle, privacy blocks, tenant-scoped recall and routing.

## Drift found in the estate (not fixed here)

1. **"mempalace" means three different things.** In SIS, `memory/mempalace/atoms.jsonl` is the in-house hashing-TF substrate, and the proving-ground scorecards label it "hashing-TF (mempalace, baseline)". `memory/mempalace_upstream/` is the real upstream Chroma store. `memory/palace/palace.json` is a separate mind-palace spatial index. With upstream MemPalace at 59k stars, any public line like "mempalace baseline 0.586" will be read as a claim about their product. Rename the in-house substrate (e.g. `sovereign-index`) before any research-surface publication.
2. **`skills/memory/sis-memory-orchestrator/references/substrate-matrix.md` is stale.** It still says "License: check upstream" (it's MIT) and assumes a guessed API (`from mempalace import Memory`). The Mem0 section predates the ADD-only algorithm.
3. **`forget()` in both the Mem0 and MemPalace adapters passes the SIS `memory_id` to the provider's delete.** It needs to resolve through `provider_shadow_refs` first. I kept parity with the existing Mem0 adapter rather than widen this PR. This is the next fix, and it's the one that makes the forgetting claim real.
4. **The observatory eval is mock-only.** `eval/provider-recall.mjs` scores every provider identically offline, so "evaluation decides the default" isn't true yet.

## Evolution sequence

1. **Official-scorer eval lane (next).** Mem0 open-sourced `mem0ai/memory-benchmarks`. Run it, plus LongMemEval-S end-to-end QA with the official scorer, against `local_core`, `local_core + MemPalace` and `local_core + Mem0 OSS`. Sign the scorecard (`protocol/sign.mjs`) and publish it on the observatory page. This turns the observatory into the referee.
2. **Shadow-ref forget + import.** Fix `forget()` resolution. Add `starlight-memory import --from mempalace|mem0` to mint SIS ids over an existing palace or Mem0 store with `provider_imported` provenance. This is the adoption path: MemPalace and Mem0 users keep what they run and add Starlight above it. No migration ask.
3. **Read-time reconciliation.** Add `supersedes`, `contradicts` and `valid_from` / `valid_to` to the record, and build a recall merger that ranks across providers by trust × recency × validity. This is the feature ADD-only and verbatim stores structurally can't offer.
4. **SIS rename + substrate-matrix refresh.** Operational-tier and cheap, but it has to land before any public research artifact cites a "mempalace" number.

## Falsifiers

- If a Mem0 or MemPalace release ships cross-provider canonical IDs, privacy-class routing, or a verifiable forget, the authority layer stops being unique. Watch their changelogs in the observatory refresh loop.
- If `local_core + MemPalace` doesn't beat `local_core` alone on end-to-end QA by a margin worth one extra daemon, drop MemPalace from the default stack and keep it as an adapter.
- If Mem0 OSS self-hosted can't run behind one gateway without per-agent runtimes, it stays in the cloud-mirror role with redaction only.

*Built on SIP. This document composes the SIS memory-provider contract (`docs/ADAPTER_CONTRACT.md`) and the Metrics Truth Rule. Vendor numbers are labeled as claims, and independent numbers cite their audit.*
