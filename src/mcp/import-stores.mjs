// import-stores — one-shot converter that folds the stores the MCP server cannot
// see (memory-bus JSONL, SIS vault JSONL, Grok memory-v2 markdown) into vault
// atoms with provenance. Pure planning is separated from writing so a dry run and
// a real run make identical decisions.
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadVault, parseFrontmatter, stringifyFrontmatter } from './vault-store.mjs';

export const MIN_CHARS = 40;
const HOME = os.homedir();

export const DEFAULT_SOURCES = {
  bus: path.join(HOME, '.starlight', 'memory-bus', 'atoms.jsonl'),
  sisDir: path.join(HOME, '.starlight', 'vaults'),
  grokDir: path.join(HOME, '.grok', 'memory-v2'),
};

// Same shapes as agentic-ops lifecycle/prompt-ledger.js (the prompt ledger's
// redaction pass), plus key=value assignments, which that ledger never sees
// but memory notes about config files do.
export const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /gho_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9_\-.]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?(?![$<{])[A-Za-z0-9_\-/+]{20,}/i,
];

export function findSecret(text) {
  const s = String(text || '');
  return SECRET_PATTERNS.find((re) => re.test(s)) || null;
}

/**
 * The dedupe key. Memory-bus atoms carry an indexer tag and the source file's
 * frontmatter; vault atoms carry neither, so both are stripped before hashing or
 * the same memory never matches itself.
 */
const XREPO = /^\s*\[xrepo_[0-9a-f]+\]\s*/i;

export function normalizeContent(text) {
  let s = String(text || '').replace(XREPO, '');
  if (/^---\r?\n/.test(s)) s = parseFrontmatter(s).body.replace(XREPO, '');
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function contentHash(text) {
  return crypto.createHash('sha256').update(normalizeContent(text)).digest('hex');
}

const TYPE_MAP = { user: 'profile', feedback: 'policy', project: 'episodic', reference: 'semantic' };
const SIS_VAULTS = new Set(['strategic', 'technical', 'creative', 'operational', 'wisdom', 'horizon']);
const INDEX_POINTER = /^\s*-\s*\[[^\]]+\]\([^)]+\.md\)/;

function firstHeading(s) { const m = /^#{1,6}\s+(.+)$/m.exec(s); return m ? m[1].trim() : ''; }
function firstContentLine(s) { return String(s || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^#{1,6}\s/.test(l) && !/^[-*_]{3,}$/.test(l)) || ''; }
const BOILERPLATE = [/auto-populated by [^.]*consolidation\.?/gi, /edit freely\.?/gi, /^>/];

const isLabel = (l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').split(/\s+/).length < 5;

/**
 * Section labels and generator boilerplate carry no memory; what is left must
 * clear MIN_CHARS. A sentence-length heading is content: Grok writes the whole
 * observation as its title.
 */
export function substantiveText(body) {
  return String(body || '').split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isLabel(l) && BOILERPLATE.reduce((s, re) => s.replace(re, ''), l).trim())
    .join(' ');
}

/** "Decisions & rationale" names a section, not a memory; lead with what it says. */
function describe(heading, body) {
  const h = oneLine(heading);
  if (h && h.split(/\s+/).length >= 5) return h;
  const line = oneLine(firstContentLine(body).replace(/^[-*>]\s*/, ''));
  return oneLine(h && line ? `${h}: ${line}` : h || line);
}
function firstLine(s) { return String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || ''; }
function oneLine(s, n = 200) { return String(s || '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, n); }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'atom'; }
function isoFrom(v) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
function listOf(v) { return Array.isArray(v) ? v.map(String).filter(Boolean) : []; }

// ---- readers: each yields raw candidates {source, sourceId, body, summary, ...} ----

export async function readMemoryBus(file) {
  if (!existsSync(file)) return [];
  const out = [];
  const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    let a;
    try { a = JSON.parse(line); } catch { out.push({ source: 'memory-bus', sourceId: `line:${i + 1}`, body: '', skip: 'unparseable' }); continue; }
    const raw = String(a.text || '').replace(XREPO, '');
    const { data, body } = /^---\r?\n/.test(raw) ? parseFrontmatter(raw) : { data: {}, body: raw.trim() };
    const ns = String(a.namespace || '');
    const declared = data.metadata && typeof data.metadata === 'object' ? data.metadata.type : data.type;
    let skip = null;
    if (/mock/i.test(ns)) skip = 'fixture';
    else if (ns.endsWith('/index') && body.split(/\r?\n/).filter((l) => l.trim()).length === 1 && INDEX_POINTER.test(body)) skip = 'index-pointer';
    out.push({
      source: 'memory-bus', sourceId: String(a.id || `line:${i + 1}`), body,
      summary: oneLine(data.description || data.name || describe(firstHeading(body), body)),
      memory_type: TYPE_MAP[declared] || 'semantic',
      tags: ['imported', 'memory-bus', ns.split('/')[1], ...listOf(data.tags)].filter(Boolean),
      observed_at: isoFrom(a.timestamp), origin: ns, skip,
      name: data.name ? String(data.name) : undefined,
    });
  }
  return out;
}

const SIS_TEXT_FIELDS = ['insight', 'content', 'insight_detail', 'context', 'implication', 'meditation', 'wish', 'benediction', 'quoteworthy'];

export async function readSisVaults(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  for (const f of files) {
    const vault = path.basename(f, '.jsonl');
    const lines = (await fs.readFile(path.join(dir, f), 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const [i, line] of lines.entries()) {
      let e;
      try { e = JSON.parse(line); } catch { out.push({ source: 'sis-vault', sourceId: `${f}:${i + 1}`, body: '', skip: 'unparseable' }); continue; }
      const present = SIS_TEXT_FIELDS.filter((k) => typeof e[k] === 'string' && e[k].trim());
      const headKey = present.find((k) => k !== 'context') || present[0];
      const head = headKey ? e[headKey] : '';
      const rest = present.filter((k) => k !== headKey).map((k) => `${k}: ${e[k].trim()}`);
      const body = [head.trim(), ...rest].filter(Boolean).join('\n\n');
      out.push({
        source: 'sis-vault', sourceId: `${f}#${e.id || i + 1}`, body,
        summary: oneLine(head),
        memory_type: 'semantic', vault: SIS_VAULTS.has(e.vault || vault) ? (e.vault || vault) : undefined,
        tags: ['imported', 'sis-vault', e.category, ...listOf(e.tags)].filter(Boolean),
        observed_at: isoFrom(e.createdAt), origin: f,
        skip: e.source === 'seed' ? 'seed' : null,
      });
    }
  }
  return out;
}

/**
 * Grok's memory-v2 keeps raw observations until a consolidation pass folds them
 * into topics and moves the originals to archive/. Topics and the unconsolidated
 * inbox are the live memory; the archive is already represented by the topics,
 * so it is opt-in. MEMORY.md is a generated index of the topics.
 */
export async function readGrokMemory(root, { includeArchive = false } = {}) {
  if (!existsSync(root)) return [];
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      const rel = path.relative(root, p).replace(/\\/g, '/');
      const at = `/${rel}`;
      const kind = at.includes('/archive/') ? 'archive' : at.includes('/observations/') ? 'observation' : at.includes('/topics/') ? 'topic' : 'index';
      if (kind === 'archive' && !includeArchive) continue;
      const text = await fs.readFile(p, 'utf8');
      const { data, body } = parseFrontmatter(text);
      out.push({
        source: 'grok-memory-v2', sourceId: rel, body: body.trim(),
        summary: describe(firstHeading(body) || data.topic_hint, body),
        memory_type: TYPE_MAP[data.type] || (kind === 'topic' ? 'semantic' : 'episodic'),
        tags: ['imported', 'grok', `grok-${kind}`, ...listOf(data.keywords)].filter(Boolean),
        observed_at: isoFrom(data.created_at), origin: kind,
        skip: kind === 'index' ? 'generated-index' : null,
      });
    }
  }
  await walk(root);
  return out;
}

// ---- planning ----

/**
 * Decides every candidate without touching disk. Order of checks matters: a
 * secret is never hashed into the report as "dup of X", and trivial content
 * never claims a hash slot that a later real atom could need.
 */
export function planImport(candidates, vaultRecords, { importedAt = new Date().toISOString() } = {}) {
  const vaultHashes = new Map();
  const vaultBodies = [];
  const vaultNames = new Map();
  for (const r of vaultRecords) {
    const body = r.raw_content || r.normalized_fact || '';
    vaultHashes.set(contentHash(body), r.memory_id);
    vaultBodies.push([normalizeContent(body), r.memory_id]);
    vaultNames.set(String(r._declared_id || r.memory_id), r.memory_id);
    if (r._path) vaultNames.set(path.basename(r._path, '.md'), r.memory_id);
  }
  const batch = new Map();
  const items = [];
  for (const c of candidates) {
    const base = { source: c.source, sourceId: c.sourceId };
    if ([c.body, c.summary, c.name, ...(c.tags || [])].some(findSecret)) { items.push({ ...base, decision: 'skipped-secret' }); continue; }
    const norm = normalizeContent(c.body);
    if (c.skip) { items.push({ ...base, decision: 'skipped-trivial', reason: c.skip }); continue; }
    if (norm.length < MIN_CHARS) { items.push({ ...base, decision: 'skipped-trivial', reason: 'short' }); continue; }
    if (substantiveText(c.body).length < MIN_CHARS) { items.push({ ...base, decision: 'skipped-trivial', reason: 'heading-or-boilerplate-only' }); continue; }
    const hash = crypto.createHash('sha256').update(norm).digest('hex');
    if (vaultHashes.has(hash)) { items.push({ ...base, decision: 'dup', dupOf: vaultHashes.get(hash), reason: 'vault-exact' }); continue; }
    if (batch.has(hash)) { items.push({ ...base, decision: 'dup', dupOf: batch.get(hash), reason: 'batch-exact' }); continue; }
    const container = vaultBodies.find(([b]) => b.includes(norm));
    if (container) { items.push({ ...base, decision: 'dup', dupOf: container[1], reason: 'vault-contains' }); continue; }
    const memory_id = `${slug(c.summary || firstLine(c.body))}-${hash.slice(0, 8)}`;
    batch.set(hash, memory_id);
    // Same memory file, different wording: another version of an atom the vault
    // already holds. Content differs, so it is kept, but a human picks the winner.
    const sameNameAs = c.name && vaultNames.get(c.name);
    items.push({ ...base, decision: 'kept', memory_id, ...(sameNameAs ? { reason: 'same-name-as-vault', sameNameAs } : {}), atom: toAtom(c, { memory_id, hash, importedAt }) });
  }
  return { items, counts: countBySource(candidates, items) };
}

export function toAtom(c, { memory_id, hash, importedAt }) {
  const summary = (c.summary || oneLine(c.body)).replace(/"/g, "'");
  const tags = [...new Set((c.tags || []).map((t) => String(t).replace(/[,[\]]/g, ' ').trim()).filter(Boolean))];
  const data = {
    memory_id,
    summary: `"${summary}"`,
    memory_type: c.memory_type || 'semantic',
    vault: c.vault,
    tags: tags.length ? tags : undefined,
    importance: 0.5,
    confidence: 0.7,
    trust: 0.6,
    privacy_class: 'private',
    retention_policy: 'permanent',
    tenant_id: 'frank',
    observed_at: c.observed_at || importedAt,
    source: c.source,
    sourceId: `"${String(c.sourceId).replace(/"/g, "'")}"`,
    importedAt,
    contentHash: `sha256:${hash}`,
  };
  return stringifyFrontmatter(data, c.body);
}

function countBySource(candidates, items) {
  const counts = {};
  for (const c of candidates) counts[c.source] ??= { read: 0, kept: 0, dup: 0, 'skipped-trivial': 0, 'skipped-secret': 0, reasons: {} };
  for (const it of items) {
    const row = counts[it.source];
    row.read++;
    row[it.decision]++;
    if (it.reason) row.reasons[`${it.decision}:${it.reason}`] = (row.reasons[`${it.decision}:${it.reason}`] || 0) + 1;
  }
  return counts;
}

// ---- entry point ----

export async function runImport({ vault, out = null, sources = DEFAULT_SOURCES, includeGrokArchive = false, importedAt } = {}) {
  const vaultRecords = await loadVault(vault);
  const candidates = [
    ...(await readMemoryBus(sources.bus)),
    ...(await readSisVaults(sources.sisDir)),
    ...(await readGrokMemory(sources.grokDir, { includeArchive: includeGrokArchive })),
  ];
  const plan = planImport(candidates, vaultRecords, { importedAt });
  const report = {
    importedAt: importedAt || new Date().toISOString(),
    vault, vaultAtoms: vaultRecords.length, out, includeGrokArchive,
    sources, counts: plan.counts,
    items: plan.items.map(({ atom, ...rest }) => rest),
  };
  if (out) {
    const resolvedOut = path.resolve(out);
    const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const rel = path.relative(fold(path.resolve(vault)), fold(resolvedOut));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`--out ${resolvedOut} is inside the vault; stage elsewhere and review first`);
    for (const it of plan.items.filter((i) => i.decision === 'kept')) {
      const dir = path.join(resolvedOut, 'imported', it.source, it.sameNameAs ? '_same-name-as-vault' : '');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${it.memory_id}.md`), it.atom, 'utf8');
    }
    await fs.writeFile(path.join(resolvedOut, 'import-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return report;
}
