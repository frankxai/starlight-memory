#!/usr/bin/env node
// Recall eval over real prompts from the prompt ledger. Measures recall@5 and
// MRR for the repo's own BM25 and hybrid rankers, on the vault alone and on the
// vault plus staged imports, so "the import made memory smarter" is a number.
//
//   node eval/recall/run.mjs [--vault <dir>] [--staging <dir>] [--set <queries.jsonl>]
//                            [--gap-set <gap.jsonl>] [--modes bm25,hybrid] [--out <dir>]
//
// The labelled sets hold Frank's real prompts, so they live outside this public
// repo (~/.starlight/memory-evals/recall/). The committed result carries only
// aggregates and per-query ranks keyed by query id.
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PRIVATE_DIR = path.join(os.homedir(), '.starlight', 'memory-evals', 'recall');
const TENANT = 'frank';
const K = 10;

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };

// The vault pointer lives in the live home, so the vault is resolved from a
// separate instance of home.mjs before the home is redirected below; otherwise
// resolution falls through to the legacy ~/starlight-memory-vault copy.
const { resolveVault } = await import('../../src/mcp/home.mjs?live');
const VAULT = resolveVault(flag('--vault')).vault;

// The index appends every vector it computes to the shared embedding cache. An
// eval over staged atoms must not grow the live cache with atoms that are not in
// the vault, so it works on a private copy.
const evalHome = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-recall-'));
const liveCache = path.join(process.env.STARLIGHT_MEMORY_HOME || path.join(os.homedir(), '.starlight', 'memory'), 'embeddings.jsonl');
if (existsSync(liveCache)) await fs.copyFile(liveCache, path.join(evalHome, 'embeddings.jsonl'));
process.env.STARLIGHT_MEMORY_HOME = evalHome;

const { loadVault, parseFrontmatter } = await import('../../src/mcp/vault-store.mjs');
const { HybridIndex, EMB_CACHE } = await import('../../src/mcp/hybrid-index.mjs');
if (!EMB_CACHE.startsWith(evalHome)) throw new Error(`embedding cache resolved to ${EMB_CACHE}, not the eval copy`);

const STAGING = path.resolve(flag('--staging', path.join(REPO, '.import-staging')));
const SET = flag('--set', path.join(PRIVATE_DIR, 'queries.jsonl'));
const GAP_SET = flag('--gap-set', path.join(PRIVATE_DIR, 'gap-queries.jsonl'));
const MODES = flag('--modes', 'bm25,hybrid').split(',');
const OUT = path.resolve(flag('--out', path.join(HERE, 'results')));

async function readSet(file) {
  if (!existsSync(file)) return [];
  return (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.query);
}

/**
 * Staged atom ids embed a content hash, and Grok rewrites its topics in place,
 * so gap-set labels name the source instead: `src:<sourceId>` from the atom's
 * provenance frontmatter. Everything else is a vault memory_id.
 */
const sourceIdOf = new Map();
const matches = (label, id) => (label.startsWith('src:') ? sourceIdOf.get(id) === label.slice(4) : id === label);

function score(rankedIds, relevant) {
  const top5 = rankedIds.slice(0, 5);
  const found5 = relevant.filter((l) => top5.some((id) => matches(l, id))).length;
  const first = rankedIds.slice(0, K).findIndex((id) => relevant.some((l) => matches(l, id)));
  return { recall5: found5 / relevant.length, rr: first < 0 ? 0 : 1 / (first + 1), rank: first < 0 ? null : first + 1 };
}

const RANKERS = {
  bm25: { embeddings: 'off', run: (idx, q) => Promise.resolve(idx.searchLexical(q, K, TENANT)) },
  hybrid: { embeddings: 'on', run: (idx, q) => idx.recall(q, K, TENANT) },
};

async function evaluate(records, queries, mode) {
  const idx = new HybridIndex(records, { embeddings: RANKERS[mode].embeddings });
  const t0 = Date.now();
  try { await idx.build(); } catch (e) { return { skipped: `embedder unavailable: ${e.message}` }; }
  const buildMs = Date.now() - t0;
  const per = [];
  for (const q of queries) {
    const out = await RANKERS[mode].run(idx, q.query);
    per.push({ id: q.id, phrasing: q.phrasing, ...score(out.map((r) => r.record.memory_id), q.relevant) });
  }
  const mean = (xs) => Math.round((xs.reduce((a, b) => a + b, 0) / (xs.length || 1)) * 1000) / 1000;
  return {
    queries: per.length,
    'recall@5': mean(per.map((p) => p.recall5)),
    MRR: mean(per.map((p) => p.rr)),
    'hit@10': mean(per.map((p) => (p.rank ? 1 : 0))),
    buildMs,
    perQuery: Object.fromEntries(per.map((p) => [p.id, { recall5: p.recall5, rank: p.rank }])),
  };
}

async function main() {
  const queries = await readSet(SET);
  const gap = await readSet(GAP_SET);
  if (!queries.length) throw new Error(`no labelled queries at ${SET}`);
  const vault = await loadVault(VAULT, TENANT);
  const staged = existsSync(STAGING) ? await loadVault(STAGING, TENANT) : [];
  for (const r of staged) sourceIdOf.set(r.memory_id, String(parseFrontmatter(await fs.readFile(r._path, 'utf8')).data.sourceId ?? ''));

  const vaultIds = new Set(vault.map((r) => r.memory_id));
  const missing = queries.flatMap((q) => q.relevant.filter((l) => !l.startsWith('src:') && !vaultIds.has(l)).map((l) => `${q.id}:${l}`));
  if (missing.length) throw new Error(`labels not in the vault (relabel, do not guess): ${missing.join(', ')}`);
  const stagedSources = new Set(sourceIdOf.values());
  const gone = gap.flatMap((q) => q.relevant.filter((l) => !stagedSources.has(l.slice(4))).map((l) => `${q.id}:${l}`));
  if (staged.length && gone.length) console.error(`warning: gap labels with no staged atom (source changed or was consolidated away): ${gone.join(', ')}`);
  const collide = staged.filter((r) => vaultIds.has(r.memory_id)).map((r) => r.memory_id);
  if (collide.length) throw new Error(`staged ids collide with vault ids: ${collide.join(', ')}`);
  const combined = [...vault, ...staged];

  console.error(`vault ${vault.length} atoms | staged ${staged.length} | queries ${queries.length} | gap ${gap.length}`);
  const results = {};
  for (const mode of MODES) {
    const base = await evaluate(vault.map((r) => ({ ...r })), queries, mode);
    if (base.skipped) { results[mode] = base; console.error(`${mode}: ${base.skipped}`); continue; }
    const withImports = staged.length ? await evaluate(combined.map((r) => ({ ...r })), queries, mode) : null;
    const gapRun = staged.length && gap.length ? await evaluate(combined.map((r) => ({ ...r })), gap, mode) : null;
    const gapBase = staged.length && gap.length ? await evaluate(vault.map((r) => ({ ...r })), gap, mode) : null;
    results[mode] = {
      baseline: base,
      withImports,
      delta: withImports ? { 'recall@5': round(withImports['recall@5'] - base['recall@5']), MRR: round(withImports.MRR - base.MRR) } : null,
      gap: gapRun ? { baseline: gapBase, withImports: gapRun } : null,
    };
  }

  const date = new Date().toISOString().slice(0, 10);
  const report = {
    ranAt: new Date().toISOString(),
    method: 'recall@5 = share of labelled atoms in the top 5; MRR = 1/rank of the first labelled atom in the top 10 (0 if absent); rankers are HybridIndex.searchLexical (bm25) and HybridIndex.recall (hybrid RRF, MiniLM summary embeddings)',
    caveat: 'main-set labels come from the vault, so on vault+staged a staged atom can only displace a label: the main-set delta measures dilution, never gain. An imported atom that answers equally well counts as a miss. The gap set (labels on staged atoms, prompts the vault could not answer) measures gain.',
    corpus: { vaultAtoms: vault.length, stagedAtoms: staged.length },
    set: { queries: queries.length, human: queries.filter((q) => q.phrasing === 'human').length, dispatched: queries.filter((q) => q.phrasing === 'dispatched').length, labels: queries.reduce((s, q) => s + q.relevant.length, 0), gapQueries: gap.length, location: 'private: ~/.starlight/memory-evals/recall/ (real prompts; not in this public repo)' },
    results,
  };
  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `${date}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');

  console.log('\nmode     corpus            recall@5    MRR   hit@10');
  for (const [mode, r] of Object.entries(results)) {
    if (r.skipped) { console.log(`${mode.padEnd(8)} skipped: ${r.skipped}`); continue; }
    const row = (name, m) => console.log(`${mode.padEnd(8)} ${name.padEnd(16)} ${String(m['recall@5']).padStart(9)} ${String(m.MRR).padStart(6)} ${String(m['hit@10']).padStart(8)}`);
    row('vault', r.baseline);
    if (r.withImports) row('vault+staged', r.withImports);
    if (r.gap) { row('gap: vault', r.gap.baseline); row('gap: +staged', r.gap.withImports); }
  }
  console.log(`\nresults: ${file}`);
  await fs.rm(evalHome, { recursive: true, force: true });
}

function round(x) { return Math.round(x * 1000) / 1000; }

main().catch((e) => { console.error(e.message); process.exit(1); });
