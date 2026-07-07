// vault-store — filesystem-native L1 canon (A2-compliant).
// Reads ANY markdown+frontmatter file in the vault into an SISMemoryRecord-shaped
// object (including existing Claude-Code memory files), and writes new atoms back
// as human-readable, grep-able, git-diffable markdown. Zero dependencies.
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---- minimal, tolerant frontmatter parser (flat keys + one nested map + arrays) ----
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  let curKey = null; // for nested map / list accumulation
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indented = /^\s+/.test(raw);
    if (indented && curKey) {
      const listItem = /^\s*-\s+(.*)$/.exec(raw);
      if (listItem) {
        if (!Array.isArray(data[curKey])) data[curKey] = [];
        data[curKey].push(coerce(listItem[1]));
        continue;
      }
      const kv = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
      if (kv) {
        if (typeof data[curKey] !== 'object' || Array.isArray(data[curKey])) data[curKey] = {};
        data[curKey][kv[1]] = coerce(kv[2]);
        continue;
      }
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (kv) {
      const key = kv[1];
      const val = kv[2];
      if (val === '') { data[key] = {}; curKey = key; }         // opens nested map or list
      else if (/^\[.*\]$/.test(val)) { data[key] = val.slice(1, -1).split(',').map((s) => coerce(s.trim())).filter((s) => s !== ''); curKey = null; }
      else { data[key] = coerce(val); curKey = key; }
    }
  }
  // collapse empty nested objects that were actually scalars-with-no-children
  for (const k of Object.keys(data)) if (data[k] && typeof data[k] === 'object' && !Array.isArray(data[k]) && Object.keys(data[k]).length === 0) data[k] = '';
  return { data, body: (m[2] || '').trim() };
}

function coerce(v) {
  if (v == null) return v;
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s !== '' && !isNaN(Number(s))) return Number(s);
  return s;
}

export function stringifyFrontmatter(data, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) { lines.push(`${k}: [${v.join(', ')}]`); }
    else if (typeof v === 'object') { lines.push(`${k}:`); for (const [ik, iv] of Object.entries(v)) if (iv != null && iv !== '') lines.push(`  ${ik}: ${iv}`); }
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', body || '', '');
  return lines.join('\n');
}

// ---- Claude memory type -> SIS memory_type ----
const TYPE_MAP = { user: 'profile', feedback: 'policy', project: 'episodic', reference: 'semantic' };

export function fileToRecord(filePath, text, tenant = 'frank') {
  const { data, body } = parseFrontmatter(text);
  const base = path.basename(filePath, '.md');
  const memId = String(data.memory_id || data.name || base);
  const declaredType = data.memory_type || (data.metadata && data.metadata.type) || null;
  return {
    memory_id: memId,
    tenant_id: String(data.tenant_id || tenant),
    source: { system: 'vault-file', uri: filePath },
    modality: 'text',
    memory_type: data.memory_type || TYPE_MAP[declaredType] || 'semantic',
    vault: data.vault || undefined,
    raw_content: body,
    normalized_fact: data.normalized_fact || undefined,
    summary: data.summary || data.description || firstLine(body),
    entities: Array.isArray(data.entities) ? data.entities.map((n) => ({ name: String(n) })) : [],
    relations: [],
    tags: Array.isArray(data.tags) ? data.tags : [],
    time_range: { observed_at: data.observed_at || data.created_at || undefined },
    importance: num(data.importance, 0.5),
    confidence: num(data.confidence, 0.8),
    trust: num(data.trust, 0.7),
    privacy_class: data.privacy_class || 'private',
    retention_policy: data.retention_policy || 'permanent',
    provenance: [],
    provider_shadow_refs: {},
    _path: filePath,
  };
}

export function recordToFile(record) {
  const data = {
    memory_id: record.memory_id,
    summary: record.summary,
    memory_type: record.memory_type,
    vault: record.vault,
    tags: record.tags && record.tags.length ? record.tags : undefined,
    importance: record.importance,
    confidence: record.confidence,
    trust: record.trust,
    privacy_class: record.privacy_class,
    retention_policy: record.retention_policy,
    tenant_id: record.tenant_id,
    observed_at: (record.time_range && record.time_range.observed_at) || new Date().toISOString(),
  };
  return stringifyFrontmatter(data, record.raw_content || record.normalized_fact || '');
}

// ---- vault IO ----
export async function loadVault(rootDir, tenant = 'frank') {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.md')) {
        const text = await fs.readFile(p, 'utf8');
        if (/^---\r?\n/.test(text)) out.push(fileToRecord(p, text, tenant));
      }
    }
  }
  await walk(rootDir);
  return out;
}

export async function writeAtom(rootDir, writeDir, record) {
  if (!record.memory_id) record.memory_id = slug(record.summary || 'atom') + '-' + crypto.randomBytes(3).toString('hex');
  const dir = path.join(rootDir, writeDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${record.memory_id}.md`);
  await fs.writeFile(file, recordToFile(record), 'utf8');
  record._path = file;
  return file;
}

export async function deleteAtom(record) {
  if (record && record._path && existsSync(record._path)) { await fs.rm(record._path, { force: true }); return true; }
  return false;
}

function firstLine(s) { return String(s || '').split(/\r?\n/).find((l) => l.trim())?.slice(0, 200) || ''; }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'atom'; }
