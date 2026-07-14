# SIS Memory System Evolution Plan — 2026-07

**Status**: Strategic decision + implementation blueprint (REVISED 2026-07-13 after independent verification)
**Scope**: Starlight Intelligence System (SIS), starlight-memory, second-brain-os, MemPalace, Hermes providers, Honcho, Hindsight, mem0, sovereign best practices.
**Goal**: Evolve to a memory substrate that compounds intelligence across agents, swarms, humans, and brands. Sovereign first. Real evals decide, not vendor benchmarks. Providers stay interchangeable behind the router.
**Core thesis (revised)**: Local sovereign core (second-brain-os + starlight-memory local_core + SIS vaults/MemPalace) stays authoritative and does 100% of live traffic today. Honcho, Hindsight, and mem0 are three unproven, competing external accelerators — none has earned production status yet. Build the orchestrator ourselves; stay a selective, eval-gated customer of whichever external providers actually win on our own traces.

---

## 0. Verified corrections to the prior (Grok-authored) version of this plan

An earlier pass of this document, produced by Grok, recommended "adopt Hindsight as primary" based on vendor-published benchmarks and asserted specific implementation status. Independent verification (GitHub repos, official docs, live MCP query against the running `starlight-memory` server) found:

1. **The benchmark premise that justified "Hindsight primary" no longer holds.** Grok cited Hindsight at 91–94% LongMemEval vs. mem0 at "~67%." That mem0 number is real but stale — it's mem0's old algorithm. **Mem0 published a new algorithm in July 2026 claiming LongMemEval 94.4% / LoCoMo 92.5%**, which now matches or beats both Hindsight's self-reported 91.4%/89.61% and Honcho's self-reported ~90.4%/89.9%. **All three numbers are vendor-self-published.** No independent, neutral benchmark of the three exists — this is an active vendor benchmark war, not a settled comparison. Any plan built on "X clearly wins on benchmarks" is currently unfounded for all three candidates.
2. **Grok's claimed implementation work is mostly real, but not where it said.** `HindsightProvider` (`src/hindsight-provider.ts`), the `resources.ts` capability entry, and the `index.ts` export genuinely exist and are **committed** — but on branch `agent/codex/honcho-and-provider-eval`, not `main` (the branch name indicates this was built by a Codex agent, not Grok directly). Two other claimed updates — this file, and a section added to `Starlight-Intelligence-System/memory/README.md` — existed only as **uncommitted working-tree edits**, at real risk of loss. (This file is being corrected in place now; the SIS README edit still needs a decision — see §6.)
3. **Nothing external is actually live.** A direct query against the running `starlight-memory` MCP server (`memory_stats`) shows the only active backend is local core: `vaultRoot: C:\Users\frank\starlight-memory-vault`, 74 atoms, embeddings on, tenant `frank`. No mem0/Hindsight/Honcho traffic is flowing today. Everything beyond local vaults is unevaluated code sitting on a feature branch.
4. **Self-hosting is not as light as implied.** Honcho needs FastAPI + Postgres/pgvector + a separate always-on "Deriver" worker process (AGPL-3.0 license — fine for personal use, matters only if ever exposed as a network service to others). Hindsight needs Docker + Postgres + an LLM API key (MIT license, but the repo is ~8.5 months old with PR/marketing-driven star growth — 18k stars in 8.5 months is a promotion signal, not a maturity signal). Both mean a new persistent service + database + process to supervise under HealthWatch, plus ongoing LLM API spend for retain/reflect calls. Mem0 is the lightest to self-host (pip/npm lib or a single Docker container, Apache-2.0, most adopted at 60k+ stars) and is already wired in via the pre-existing `Mem0RemoteProvider` (committed 2026-06-18, predates this branch entirely).
5. **The "Hermes exposes Honcho/Hindsight/Mem0 as configurable providers" claim is real** — but it refers to NousResearch's `hermes-agent` (`AppData\Local\hermes\hermes-agent`, a Python plugin system with `plugins/memory/{mem0,honcho,hindsight,...}/plugin.yaml`), not anything built in this repo. It's upstream, vendored, unrelated to `starlight-memory`'s own (hand-rolled TypeScript, no SDK deps) adapters.

**Bottom line of the correction**: the plan's architecture (sovereign core + pluggable router + human-curated MemPalace) is sound and matches Frank's existing doctrine — keep it. The specific choice of "Hindsight as primary learning engine" is not currently justified by evidence. Treat all three externals as equally unproven until a real eval says otherwise.

---

## 1. Current State Audit (What We Actually Have)

### Sovereign Local Layer (Authoritative, live today)
- **second-brain-os**: Local-first vault system. `brain/` (public/shared) + `private/` separation. Markdown + JSONL. Ingestion pipelines (`src/sbo_ingestion/`: ingest, dual_write, summarize, audit, voice_check). Git + Syncthing friendly. No external memory-provider wiring at all — purely local/sovereign by design.
- **starlight-memory**: Router + policy layer + `local_core` (vaults, event logs, hybrid BM25/embeddings search). **Confirmed live** via direct MCP query: 74 atoms indexed, embeddings on, this is the only backend actually serving traffic right now. `Mem0RemoteProvider` (pre-existing), `HindsightProvider`, and a Honcho adapter exist as code on the `agent/codex/honcho-and-provider-eval` branch — all are hand-rolled TS interfaces expecting an externally-supplied client, not npm SDK integrations, and none are merged to `main` or connected to a live external service.
- **SIS memory/**: 6 vaults confirmed on disk (`vaults/{strategic,technical,creative,operational,wisdom,horizon}-vault.md`), plus `knowledge-graph/`, `atlases/`, `bases/`, `voice-sessions/`, `sis-memory.sqlite`. Local, git-tracked, human-curated.
- **MemPalace / vaults**: Curated, human-readable, git-tracked layer for MOCs / people / projects / patterns.

### Current External / Hybrid (unproven tier)
- **mem0**: Pre-existing adapter (before any of this branch's work). Its own July 2026 benchmark update claims parity with the other two. Cheapest and simplest to self-host of the three.
- **Hindsight**: Adapter code exists on branch, zero live traffic, zero eval runs.
- **Honcho**: Adapter code partially exists on branch, zero live traffic, zero eval runs.
- **Hermes (NousResearch)**: Exposes all three as configurable plugins — this is upstream infrastructure Frank already has, not something to build.

### Gaps
- No automated "reflect/generalize" loop — agents recall more than they learn/compound.
- No eval harness result has ever compared local-only vs. mem0 vs. Hindsight vs. Honcho on Frank's actual traces. Every claim of superiority so far is a vendor's own marketing.
- Two feature-branch files were uncommitted and at risk of loss (now being resolved).

---

## 2. Candidate Analysis (facts only, vendor numbers flagged as such)

### Hindsight (vectorize-io/hindsight)
- API: `retain()` / `recall()` / `reflect()` — confirmed accurate.
- Data model: not a strict 3-tier hierarchy as previously described — four logical networks (World/facts, Experiences, Entity summaries, Mental Models via `reflect`).
- Vendor benchmarks: LongMemEval 91.4%, LoCoMo 89.61% (self-published, arXiv preprint 2512.12818, **not peer-reviewed**; a Hermes-adjacent doc cites a different number, 94.6% — internally inconsistent even among vendor-adjacent sources).
- Self-host: Docker + Postgres + LLM API key. MIT license.
- Maturity: repo created Oct 2025 (~8.5 months old), 18k+ stars — growth is PR/press-release driven (VentureBeat, PR Newswire), not a maturity signal.

### Honcho (plastic-labs/honcho)
- Data model: workspaces/peers/sessions/messages — confirmed. Async reasoning is one **Deriver** worker (branded "Neuromancer" internally), not three separate named components as previously described.
- Dialectic query API — confirmed, the standout feature (reasoning over evolving peer/user representations).
- Vendor benchmarks: LongMem-S 90.4%, LoCoMo 89.9% (self-published) — roughly tied with Hindsight's self-reported numbers.
- Self-host: FastAPI + Postgres/pgvector + separate deriver process. **AGPL-3.0** (copyleft — a real constraint if this is ever exposed as a network service beyond personal use).
- Maturity: created Sept 2023, most mature/battle-tested of the three, actively maintained (pushed same-day).
- Pricing (hosted): ~$2/M tokens ingestion, `context()` reads free, reasoning $0.001–$0.50/query by tier.

### mem0 (mem0ai/mem0) — already wired
- Vendor benchmarks (July 2026 update): LongMemEval 94.4%, LoCoMo 92.5% — now the highest self-reported numbers of the three, reversing the "mem0 is weaker" premise the earlier plan relied on.
- Self-host: pip/npm library or single Docker container — the lightest infra footprint of the three. **Apache 2.0** (most permissive license).
- Maturity: created 2023, 60k+ stars, by far the most adopted — the safest bet for a first real eval.

### Shared caveat
No independent, neutral benchmark exists comparing these three. Every number above traces back to the vendor being measured. **Treat all three as tied until Frank's own eval harness says otherwise.**

---

## 3. Decision (revised)

**Do not stand up new persistent infrastructure (Honcho's Postgres+FastAPI+worker stack, or Hindsight's Docker+Postgres stack) right now.** The evidence that justified it — "Hindsight is the clear SOTA winner" — no longer holds. Running two more always-on services, each needing its own database, LLM API budget, and HealthWatch supervision, for an unproven and now-contested benchmark edge, is the kind of premature infrastructure the estate's own doctrine says to avoid (don't add abstractions before a second concrete use site; minimal footprint; local-first).

**What to do instead:**

1. **Keep the sovereign local core exactly as-is.** It's real, live, working, zero-cost, zero external dependency, and already serving every agent that talks to `starlight-memory`. This part of the original plan was correct — preserve it as Layer 0, authoritative, always.
2. **Keep the Hindsight/Honcho/mem0 adapters as dormant, code-complete options behind the router**, on the feature branch, not merged to `main`, not activated for live traffic. They cost nothing sitting there and preserve future optionality.
3. **If/when external memory augmentation is wanted, start with mem0 — not Hindsight or Honcho.** It's already wired (pre-existing adapter), lightest to self-host, most mature, most permissively licensed, and its own July numbers now claim parity with the other two. One well-evaluated provider beats three half-wired ones.
4. **Gate any provider's promotion to "active" on a real eval against Frank's own SIS/second-brain traces** — not vendor benchmarks. Extend the existing `starlight-memory` fan-in/eval harness (referenced in repo but not yet run against these providers) to score: recall accuracy, contradiction rate, latency, cost per 1K ops, and whether agents visibly improve across sessions. Only promote a provider past "dormant adapter" if it beats local-only + mem0 by a real margin on that harness.
5. **If a provider is later self-hosted, use Podman (the house container standard), not Docker Desktop**, and it must ship a HealthWatch heartbeat per the estate runtime doctrine (`SYSTEM.md`) before it's allowed to run unattended.

**Architecture (unchanged from the sound parts of the original plan):**

```
Agents / Hermes / Queen / Swarms  →  talk only to SIS memory API
                ↓
   SIS Memory Router (starlight-memory)
   - policy engine (privacy_class, workflow, cost, tenant)
   - hybrid local search (BM25 + embeddings)
   - provenance
                ↓
   Local Sovereign Core (always authoritative, live today)
   - second-brain-os vaults, starlight-memory local_core, SIS memory/ vaults + MemPalace
                ↓ (dormant, eval-gated, not yet activated)
   External adapters: mem0 (lightest, try first) | Honcho (peer modeling, AGPL) | Hindsight (learning/reflect, newest/least proven)
```

---

## 4. Roadmap

### Phase 1 — Document & stabilize (this pass)
- [x] Corrected this doc against verified facts.
- [ ] Decide fate of the two uncommitted/branch-only file changes (see §6 — needs Frank's call, not auto-committed per repo convention).
- [ ] Do **not** merge `agent/codex/honcho-and-provider-eval` to `main` until Phase 2 produces a real eval result.

### Phase 2 — Real eval (before any adoption decision)
- Extend `starlight-memory`'s eval/fan-in-benchmark harness to run all three adapters (mem0 first, since it's least infra to stand up for a test) against a fixed set of real SIS/second-brain traces.
- Score: recall accuracy, contradiction rate, cost/latency, multi-session improvement.
- Only after this produces a real winner (or "none beat local-only") does Phase 3 make sense.

### Phase 3 — Selective activation (only if Phase 2 justifies it)
- Activate the winning adapter behind the router for a narrow, high-value workflow first (not a full estate rollout).
- Podman-based self-host if self-hosting; HealthWatch heartbeat required.
- Re-evaluate quarterly — this is a fast-moving, vendor-benchmark-driven space; today's numbers will be stale again in months.

### Explicitly deferred (not decided by this doc)
- Whether to self-host Honcho or Hindsight at all.
- Whether to merge the feature branch to `main`.
- Whether to wire this into the real Hermes (`NousResearch/hermes-agent`) provider config, since that system already supports all three natively and duplicating that logic in `starlight-memory` may be redundant — worth a scoping conversation before building more adapter code.

Sovereign first. Evals — ours, not vendors' — decide. Providers stay interchangeable and, for now, dormant.
