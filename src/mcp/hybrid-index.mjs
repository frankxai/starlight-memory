// hybrid-index — L2 derived retrieval (rebuildable from L1, disposable).
// BM25 lexical (always) + optional local embeddings, fused with Reciprocal Rank
// Fusion. Lexical is the floor; embeddings are a second signal (per SIS doctrine).
// Only optional dependency: @huggingface/transformers (lazy). Falls back to
// lexical-only if the embedder is not installed.
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MEMORY_HOME } from './home.mjs';

const STOP = new Set('the a an and or of to in is are was for on at by with as it this that be from into your you our we they i'.split(' '));
const CACHE_DIR = MEMORY_HOME;
export const EMB_CACHE = path.join(CACHE_DIR, 'embeddings.jsonl');
// Compact only when the file carries more dead lines than live ones. Compaction
// rewrites the whole file, so it runs at startup only, never on a write path.
const COMPACT_RATIO = 2;
const STALE_LOCK_MS = 5 * 60 * 1000;
const RRF_K = 60;

export function tokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
}
function docText(r) {
  return [r.summary, r.raw_content, r.normalized_fact, r.memory_type, r.vault, ...(r.tags || []), ...((r.entities || []).map((e) => e.name))].filter(Boolean).join(' ');
}
function contentHash(r) { return crypto.createHash('sha1').update(docText(r)).digest('hex').slice(0, 16); }

export class HybridIndex {
  constructor(records, { embeddings = 'auto', embedSource = 'summary' } = {}) {
    this.records = records;
    this.embeddingsMode = embeddings; // 'auto' | 'on' | 'off'
    this.embedSource = embedSource;   // 'summary' | 'full' — what text is embedded
    this.embedder = null;
    this.vectors = new Map();   // memory_id -> Float32Array
    this._buildLexical();
  }

  _embedText(r) {
    if (this.embedSource === 'full') return docText(r);
    return [r.summary, (r.raw_content || '').slice(0, 280), ...(r.tags || [])].filter(Boolean).join('\n');
  }

  _buildLexical() {
    this.docs = this.records.map((r) => ({ id: r.memory_id, terms: tokenize(docText(r)), record: r }));
    this.df = new Map();
    let totalLen = 0;
    for (const d of this.docs) {
      d.len = d.terms.length; totalLen += d.len;
      d.tf = new Map();
      for (const t of d.terms) d.tf.set(t, (d.tf.get(t) || 0) + 1);
      for (const t of new Set(d.terms)) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgdl = this.docs.length ? totalLen / this.docs.length : 0;
    this.N = this.docs.length;
  }

  bm25(queryTerms, d, k1 = 1.5, b = 0.75) {
    let score = 0;
    for (const t of queryTerms) {
      const tf = d.tf.get(t); if (!tf) continue;
      const idf = Math.log(1 + (this.N - this.df.get(t) + 0.5) / (this.df.get(t) + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (d.len / (this.avgdl || 1))));
    }
    return score;
  }

  async build() {
    if (this.embeddingsMode === 'off') return this;
    try { await this._loadEmbedder(); } catch (e) {
      if (this.embeddingsMode === 'on') throw e;
      this.embedder = null; // lexical-only fallback
      return this;
    }
    await this._loadCache();
    const fresh = [];
    for (const r of this.records) {
      const text = this._embedText(r);
      const key = `${r.memory_id}:${this.embedSource}:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
      if (this.cache.has(key)) { this.vectors.set(r.memory_id, this.cache.get(key)); continue; }
      const v = await this._embed(text);
      this.vectors.set(r.memory_id, v);
      this.cache.set(key, v); fresh.push([key, v]);
    }
    if (fresh.length) await this._appendCache(fresh);
    if (this.cacheLines > COMPACT_RATIO * Math.max(this.cache.size, 1)) await this._compactCache();
    return this;
  }

  async _loadEmbedder() {
    const { pipeline } = await import('@huggingface/transformers');
    this._extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    this.embedder = true;
  }
  async _embed(text) {
    const out = await this._extractor(text, { pooling: 'mean', normalize: true });
    return Float32Array.from(out.data);
  }
  /**
   * The cache is an append-only log: last line for a key wins. N stdio servers
   * (one per harness session) share this file, and the previous whole-file
   * rewrite on every remember() let one process clobber another's vectors.
   * Appends of distinct lines are safe under O_APPEND; a torn line is skipped
   * and counted, not swallowed.
   */
  async _loadCache() {
    this.cache = new Map();
    this.cacheLines = 0;
    this.cacheCorrupt = 0;
    if (!existsSync(EMB_CACHE)) return;
    const lines = (await fs.readFile(EMB_CACHE, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const l of lines) {
      this.cacheLines++;
      try { const o = JSON.parse(l); this.cache.set(o.k, Float32Array.from(o.v)); } catch { this.cacheCorrupt++; }
    }
  }
  async _appendCache(entries) {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const body = entries.map(([k, v]) => JSON.stringify({ k, v: Array.from(v) })).join('\n') + '\n';
    await fs.appendFile(EMB_CACHE, body, 'utf8');
    this.cacheLines += entries.length;
  }
  /**
   * Compaction rewrites the file, so it must not work from the snapshot taken
   * at load: another server may have appended during the embed loop, and a
   * rename over that would erase its vectors. Re-read under an exclusive lock
   * and merge; if the lock is held, skip — dead lines are only a size cost.
   */
  async _compactCache() {
    const lock = `${EMB_CACHE}.lock`;
    let handle;
    try { handle = await fs.open(lock, 'wx'); } catch {
      // A process that died mid-compaction leaves its lock behind; without
      // this the file would grow forever and nothing would say why.
      let age = 0;
      try { age = Date.now() - (await fs.stat(lock)).mtimeMs; } catch { /* vanished: retry below */ }
      if (age > STALE_LOCK_MS || age === 0) {
        await fs.rm(lock, { force: true });
        try { handle = await fs.open(lock, 'wx'); } catch { this.cacheCompactionBlocked = 'lock held'; return false; }
      } else {
        this.cacheCompactionBlocked = `lock held ${Math.round(age / 1000)}s`;
        console.error(`[starlight-memory] embedding cache compaction skipped: ${lock} held for ${Math.round(age / 1000)}s`);
        return false;
      }
    }
    this.cacheCompactionBlocked = null;
    try {
      const merged = new Map();
      let corrupt = 0;
      for (const l of (await fs.readFile(EMB_CACHE, 'utf8')).split(/\r?\n/).filter(Boolean)) {
        try { const o = JSON.parse(l); merged.set(o.k, Float32Array.from(o.v)); } catch { corrupt++; }
      }
      // What is on disk is newer than what we loaded; ours only fill gaps.
      for (const [k, v] of this.cache) if (!merged.has(k)) merged.set(k, v);
      const tmp = `${EMB_CACHE}.${process.pid}.tmp`;
      const lines = [...merged.entries()].map(([k, v]) => JSON.stringify({ k, v: Array.from(v) }));
      await fs.writeFile(tmp, lines.join('\n') + '\n', 'utf8');
      await fs.rename(tmp, EMB_CACHE);
      this.cache = merged;
      this.cacheLines = merged.size;
      this.cacheCorrupt = 0;
      this.cacheCompactedDropped = corrupt;
      return true;
    } finally {
      await handle.close().catch(() => {});
      await fs.rm(lock, { force: true });
    }
  }

  searchLexical(query, limit = 10, tenant) {
    const qt = tokenize(query);
    const qset = new Set(qt);
    return this.docs
      .filter((d) => !tenant || d.record.tenant_id === tenant)
      .map((d) => ({ record: d.record, score: this.bm25(qt, d), matched_terms: [...new Set(d.terms.filter((t) => qset.has(t)))] }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.record.importance - a.record.importance)
      .slice(0, limit);
  }

  async searchSemantic(query, limit = 10, tenant) {
    if (!this.embedder) return [];
    const qv = await this._embed(query);
    return this.records
      .filter((r) => (!tenant || r.tenant_id === tenant) && this.vectors.has(r.memory_id))
      .map((r) => ({ record: r, score: cosine(qv, this.vectors.get(r.memory_id)), matched_terms: [] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async recall(query, limit = 10, tenant) {
    const lex = this.searchLexical(query, Math.max(limit * 3, 30), tenant);
    if (!this.embedder) return lex.slice(0, limit).map((r) => ({ ...r, lexical: r.score, semantic: null }));

    const qv = await this._embed(query);
    const sem = this.records
      .filter((r) => (!tenant || r.tenant_id === tenant) && this.vectors.has(r.memory_id))
      .map((r) => ({ record: r, sim: cosine(qv, this.vectors.get(r.memory_id)) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, Math.max(limit * 3, 30));

    // Reciprocal Rank Fusion
    const rank = new Map();
    lex.forEach((r, i) => rank.set(r.record.memory_id, { record: r.record, rrf: 1 / (RRF_K + i + 1), lexical: r.score, matched_terms: r.matched_terms, semantic: null }));
    sem.forEach((r, i) => {
      const e = rank.get(r.record.memory_id) || { record: r.record, rrf: 0, lexical: 0, matched_terms: [], semantic: null };
      e.rrf += 1 / (RRF_K + i + 1); e.semantic = Number(r.sim.toFixed(4));
      rank.set(r.record.memory_id, e);
    });
    return [...rank.values()]
      .sort((a, b) => b.rrf - a.rrf || b.record.importance - a.record.importance)
      .slice(0, limit)
      .map((e) => ({ record: e.record, score: Number(e.rrf.toFixed(6)), matched_terms: e.matched_terms, lexical: Number((e.lexical || 0).toFixed(4)), semantic: e.semantic }));
  }

  /**
   * Incremental insert. A full rebuild re-embeds every atom, so remembering N
   * facts costs O(N^2) embeddings — unusable past a few hundred atoms.
   */
  async addRecord(r) {
    this.removeRecord(r.memory_id);
    this.records.push(r);

    const terms = tokenize(docText(r));
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of new Set(terms)) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.docs.push({ id: r.memory_id, terms, record: r, len: terms.length, tf });
    this._recomputeLengths();

    if (!this.embedder) return this;
    const text = this._embedText(r);
    const key = `${r.memory_id}:${this.embedSource}:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
    const cached = this.cache?.get(key);
    const v = cached ?? (await this._embed(text));
    this.vectors.set(r.memory_id, v);
    if (!cached && this.cache) { this.cache.set(key, v); await this._appendCache([[key, v]]); }
    return this;
  }

  /**
   * Removing an unknown id is a no-op, which is what addRecord's replace needs.
   * Every doc carrying the id goes, not just the first: an id that got past
   * disambiguation twice must not leave a ghost the index still scores.
   */
  removeRecord(id) {
    let removed = 0;
    for (let i = this.docs.length - 1; i >= 0; i--) {
      if (this.docs[i].id !== id) continue;
      for (const t of new Set(this.docs[i].terms)) {
        const next = (this.df.get(t) || 1) - 1;
        if (next <= 0) this.df.delete(t); else this.df.set(t, next);
      }
      this.docs.splice(i, 1);
      removed++;
    }
    if (!removed) return this;
    for (let j = this.records.length - 1; j >= 0; j--) if (this.records[j].memory_id === id) this.records.splice(j, 1);
    this.vectors.delete(id);
    this._recomputeLengths();
    return this;
  }

  _recomputeLengths() {
    this.N = this.docs.length;
    this.avgdl = this.N ? this.docs.reduce((s, d) => s + d.len, 0) / this.N : 0;
  }

  stats() {
    return {
      atoms: this.N, avg_doc_len: Number(this.avgdl.toFixed(1)), unique_terms: this.df.size,
      embeddings: this.embedder ? 'on' : 'lexical-only', vectors: this.vectors.size,
      ...(this.cache ? { cache_entries: this.cache.size, cache_lines: this.cacheLines, cache_corrupt_lines: this.cacheCorrupt, cache_compaction_blocked: this.cacheCompactionBlocked || null } : {}),
    };
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
