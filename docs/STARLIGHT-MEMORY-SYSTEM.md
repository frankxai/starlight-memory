# Starlight Memory as a System

Starlight Memory is not a library — it is the estate's **memory operating system**:
a sovereign canonical store, a continuously-benchmarked **observatory** of every
coding-agent memory system a creator could adopt, and the engine the **Starlight
Queen** uses to install and maintain the right stack for a given machine and
creator. Any creator who adopts Starlight inherits an excellent, validated,
cross-agent, cross-device memory experience by default.

## The three layers

1. **Authority — `local_core`.** Sovereign, filesystem-native markdown atoms with a
   hybrid BM25 + embedding index. Owns `memory_id`, provenance, privacy class,
   retention, and trust. Never delegated. (MIT, public.)
2. **Observatory — the adapter registry.** A curated, evidence-tagged catalog of
   adoptable memory systems (Hindsight, Honcho, Mem0, Zep, Letta, cognee, …), each
   with license, install path, cost, privacy posture, cross-device, theory-of-mind,
   and benchmark. Lives in `tools/memory-observatory.mjs` (`REGISTRY`) and the
   `MemoryProvider` adapters in `src/`. This is the public "which memory system
   should I use?" surface.
3. **Queen — recommend / install / maintain.** Given a machine profile (RAM/CPU via
   `pp`) and a creator's requirements (sovereignty, privacy, cross-device,
   theory-of-mind, budget), the Queen ranks the registry and installs the right
   stack, wires the MCP into every harness, and keeps it maintained.

## How the Queen uses it

```bash
# 1. Recommend a stack for this machine + creator
node tools/memory-observatory.mjs recommend --ram 32 --sovereignty high \
     --privacy high --cross-device --theory-of-mind --budget low

# 2. Let evidence pick the default recall provider (not vendor claims)
node eval/provider-recall.mjs --live      # with provider keys in env

# 3. Wire the one canonical MCP into every harness (already done 2026-07-12):
#    Codex ~/.codex/config.toml · Claude (claude mcp add) · Grok ~/.grok/config.toml
#    · Antigravity ~/.gemini/config/mcp_config.json  → all point at
#    src/mcp/server.mjs over ~/starlight-memory-vault
```

**Default stack (sovereign creator):** `local_core` authority → Hindsight (or Zep, if
sovereignty/budget outweigh the SOTA claim) recall accelerator → Honcho peer layer
(opt-in; AGPL-3.0 caveat) → Mem0 cheap mirror. **Evaluation decides the default** —
the `--live` scorecard, not the leaderboard claims, settles it.

## Cross-agent + cross-device (the two unlocks)

- **Cross-agent:** one MCP server (`src/mcp/server.mjs`), one vault, every harness
  config points at it. Tools: `memory_recall` (hybrid), `memory_search` (BM25),
  `memory_remember`. Heavy providers fan in through this gateway — never one runtime
  per terminal agent (see `docs/ADAPTER_CONTRACT.md`).
- **Cross-device:** the git-vault sync CLI (`bin/`, junction wiring) versions and
  syncs the vault across machines. Private vault repo; MIT tooling.

## Embedded in process (so it stays true)

- **Benchmark refresh loop:** the observatory registry + `--live` scorecard are
  re-run on a cadence; new/updated systems (and their benchmark claims) are folded in
  so the recommendation never goes stale. Bind as a scheduled watch loop per the loop
  runner-matrix; the Queen owns it.
- **New-adopter path:** onboarding any creator/machine runs `recommend` → installs →
  wires MCP → validates with a recall smoke test. This is the "excellent experience
  by default" guarantee.
- **Evidence discipline:** every default recall provider is chosen from a scorecard,
  cross-model reviewed (see `../../CROSS-MODEL-GATE.md`); vendor benchmark claims are
  tagged as claims until reproduced on our data.

## Open build (staged, not done)

- **Public observatory surface** (a page/site rendering `REGISTRY` + latest scorecard)
  so the benchmark is public and adoptable — the "website" layer.
- **Adapters for candidates:** Zep/Graphiti and cognee (currently `candidate`).
- **Live differentiated benchmark:** the offline eval is a plumbing baseline (all
  providers score identically in mock mode); real ranking needs `--live` keys or
  provider-differentiated behavior.
