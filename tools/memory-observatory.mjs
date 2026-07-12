#!/usr/bin/env node
/**
 * Starlight Memory Observatory
 * -----------------------------
 * The estate's living map of coding-agent memory systems people can adopt, and
 * the engine the Starlight Queen uses to recommend the right stack for a given
 * machine + creator profile. local_core (Starlight) is always the canonical
 * authority; everything else is an adapter/accelerator scored against it.
 *
 *   node tools/memory-observatory.mjs list
 *   node tools/memory-observatory.mjs recommend --ram 32 --sovereignty high \
 *        --privacy high --cross-device --theory-of-mind --budget low
 *
 * Curated, evidence-tagged. Benchmarks cite public claims (verify with --live
 * eval before treating any default as settled — "evaluation decides defaults").
 */

/** @typedef {'authority'|'recall-accelerator'|'peer-modeling'|'cloud-mirror'|'kg-recall'|'agent-runtime'} Role */

export const REGISTRY = [
  {
    id: "local-core", name: "Starlight local_core", license: "MIT", role: "authority",
    install: "built-in (this package)", cost: "free", ram_gb: 1,
    self_hostable: true, cross_device: "git-vault sync", theory_of_mind: false,
    recall: "hybrid BM25 + embeddings", benchmark: "canonical store (not ranked)",
    sovereignty: 5, adapter: "yes", notes: "Owns memory_id, provenance, privacy, retention, trust. Never delegated.",
  },
  {
    id: "hindsight", name: "Hindsight (vectorize.io)", license: "proprietary (local mode available)", role: "recall-accelerator",
    install: "Hermes one-click / cloud API / local mode", cost: "cloud paid; local = compute only", ram_gb: 4,
    self_hostable: true, cross_device: "service", theory_of_mind: "partial (reflect synthesis)",
    recall: "knowledge-graph + entity resolution + multi-strategy + reflect", benchmark: "LongMemEval SOTA (vendor claim)",
    sovereignty: 3, adapter: "yes", notes: "Best-in-class recall. Local mode preserves sovereignty. Hermes-native.",
  },
  {
    id: "honcho", name: "Honcho (Plastic Labs)", license: "AGPL-3.0", role: "peer-modeling",
    install: "self-host FastAPI / managed", cost: "self-host free; managed paid", ram_gb: 2,
    self_hostable: true, cross_device: "service", theory_of_mind: true,
    recall: "dialectic peer.chat (reasoning-first)", benchmark: "modeling, not a retrieval benchmark",
    sovereignty: 3, adapter: "yes", notes: "Peer/theory-of-mind ('what does Alice know about Bob'). AGPL = copyleft flag for commercial network service.",
  },
  {
    id: "mem0", name: "Mem0", license: "Apache-2.0", role: "cloud-mirror",
    install: "pip / API", cost: "OSS free; cloud paid", ram_gb: 1,
    self_hostable: true, cross_device: "service", theory_of_mind: "partial",
    recall: "vector + extraction", benchmark: "competitive on LOCOMO (vendor claim)",
    sovereignty: 3, adapter: "yes", notes: "Lightweight redacted cloud fact mirror. Already integrated.",
  },
  {
    id: "zep", name: "Zep / Graphiti", license: "Apache-2.0", role: "kg-recall",
    install: "self-host / cloud", cost: "OSS free; cloud paid", ram_gb: 3,
    self_hostable: true, cross_device: "service", theory_of_mind: "partial",
    recall: "temporal knowledge graph", benchmark: "strong on DMR / LongMemEval (vendor claim)",
    sovereignty: 4, adapter: "candidate", notes: "Temporal KG; sovereign self-host. No adapter yet.",
  },
  {
    id: "letta", name: "Letta (MemGPT)", license: "Apache-2.0", role: "agent-runtime",
    install: "self-host server", cost: "OSS free", ram_gb: 6,
    self_hostable: true, cross_device: "service", theory_of_mind: "partial",
    recall: "self-editing memory blocks", benchmark: "MemGPT paradigm (not a store)",
    sovereignty: 4, adapter: "runtime-only", notes: "Agent runtime with memory, not a canonical store. Heavy — bounded workers only.",
  },
  {
    id: "supermemory", name: "Supermemory", license: "proprietary", role: "cloud-mirror",
    install: "API", cost: "paid", ram_gb: 1,
    self_hostable: false, cross_device: "service", theory_of_mind: false,
    recall: "vector", benchmark: "n/a", sovereignty: 2, adapter: "registered", notes: "Cloud memory backend.",
  },
  {
    id: "cognee", name: "cognee", license: "Apache-2.0", role: "kg-recall",
    install: "pip / self-host", cost: "OSS free", ram_gb: 3,
    self_hostable: true, cross_device: "service", theory_of_mind: "partial",
    recall: "ECL knowledge graph", benchmark: "graph memory (emerging)",
    sovereignty: 4, adapter: "candidate", notes: "Extract-Cognify-Load graph memory. No adapter yet.",
  },
];

const WEIGHTS = { sovereignty: 3, privacy: 3, crossDevice: 2, theoryOfMind: 2, budget: 2, recall: 2, fit: 1 };

function scoreSystem(sys, req) {
  let score = 0;
  const why = [];
  if (req.sovereignty === "high") {
    const s = sys.sovereignty; score += (s / 5) * WEIGHTS.sovereignty;
    if (s >= 4) why.push("high sovereignty"); else if (s <= 2) why.push("⚠ low sovereignty");
  }
  if (req.privacy === "high") {
    if (sys.self_hostable) { score += WEIGHTS.privacy; why.push("self-hostable (privacy)"); }
    else why.push("⚠ cloud-only");
  }
  if (req.crossDevice && sys.cross_device) { score += WEIGHTS.crossDevice; why.push(`cross-device: ${sys.cross_device}`); }
  if (req.theoryOfMind) {
    if (sys.theory_of_mind === true) { score += WEIGHTS.theoryOfMind; why.push("theory-of-mind"); }
    else if (sys.theory_of_mind === "partial") { score += WEIGHTS.theoryOfMind * 0.4; }
  }
  if (req.budget === "low") {
    if (/free/.test(sys.cost)) { score += WEIGHTS.budget; why.push("free/OSS path"); }
    else why.push("⚠ paid");
  }
  if (/SOTA|strong|competitive/i.test(sys.benchmark)) { score += WEIGHTS.recall; why.push("strong recall benchmark"); }
  if (req.ram && sys.ram_gb <= Math.max(1, req.ram / 8)) { score += WEIGHTS.fit; }
  else if (req.ram && sys.ram_gb > req.ram / 2) why.push("⚠ heavy for this machine");
  return { score: Math.round(score * 100) / 100, why };
}

export function recommend(req) {
  const scored = REGISTRY
    .filter((s) => s.role !== "authority")
    .map((s) => ({ ...s, ...scoreSystem(s, req) }))
    .sort((a, b) => b.score - a.score);
  const byRole = (r) => scored.find((s) => s.role === r && s.adapter === "yes") || scored.find((s) => s.role === r);
  return {
    authority: REGISTRY.find((s) => s.role === "authority"),
    recall: byRole("recall-accelerator"),
    peer: req.theoryOfMind ? byRole("peer-modeling") : null,
    mirror: req.budget === "low" ? scored.find((s) => s.role === "cloud-mirror" && /free/.test(s.cost)) : byRole("cloud-mirror"),
    ranked: scored,
  };
}

// ---- CLI ----
function parseArgs(argv) {
  const o = { ram: undefined, sovereignty: "high", privacy: "high", crossDevice: false, theoryOfMind: false, budget: "low" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ram") o.ram = Number(argv[++i]);
    else if (a === "--sovereignty") o.sovereignty = argv[++i];
    else if (a === "--privacy") o.privacy = argv[++i];
    else if (a === "--cross-device") o.crossDevice = true;
    else if (a === "--theory-of-mind") o.theoryOfMind = true;
    else if (a === "--budget") o.budget = argv[++i];
  }
  return o;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") {
    console.log("# Starlight Memory Observatory — registry\n");
    console.log("| System | License | Role | Self-host | ToM | Benchmark | Adapter |");
    console.log("|---|---|---|:-:|:-:|---|:-:|");
    for (const s of REGISTRY) {
      console.log(`| ${s.name} | ${s.license} | ${s.role} | ${s.self_hostable ? "✓" : "✗"} | ${s.theory_of_mind === true ? "✓" : s.theory_of_mind ? "~" : "✗"} | ${s.benchmark} | ${s.adapter} |`);
    }
    return;
  }
  if (cmd === "recommend") {
    const req = parseArgs(rest);
    const r = recommend(req);
    console.log("# Starlight Queen — memory-stack recommendation\n");
    console.log(`Profile: RAM ${req.ram ?? "?"}GB · sovereignty=${req.sovereignty} · privacy=${req.privacy} · cross-device=${req.crossDevice} · theory-of-mind=${req.theoryOfMind} · budget=${req.budget}\n`);
    console.log(`**Authority (always):** ${r.authority.name} — ${r.authority.notes}`);
    if (r.recall) console.log(`**Recall accelerator:** ${r.recall.name}  (score ${r.recall.score}) — ${r.recall.why.join(", ")}`);
    if (r.peer) console.log(`**Peer / theory-of-mind:** ${r.peer.name}  (score ${r.peer.score}) — ${r.peer.why.join(", ")}`);
    if (r.mirror) console.log(`**Cheap mirror (optional):** ${r.mirror.name}  (score ${r.mirror.score})`);
    console.log("\n## Full ranking");
    for (const s of r.ranked) console.log(`- ${s.score.toFixed(2)}  ${s.name} [${s.role}] — ${s.why.join(", ")}`);
    console.log("\n> Benchmarks are public vendor claims. Run `node eval/provider-recall.mjs --live` with keys to let evidence pick the default.");
    return;
  }
  console.log("usage: memory-observatory.mjs <list|recommend> [--ram N --sovereignty high --privacy high --cross-device --theory-of-mind --budget low]");
}

main();
