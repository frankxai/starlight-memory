// starlight-memory MCP server — exposes the vault (L1) + hybrid index (L2) to any
// coding agent over stdio. This is the cross-agent unlock: one server, one vault,
// every harness config points here. All diagnostics go to stderr (stdout is the
// JSON-RPC channel).
import path from 'node:path';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadVault, writeAtom, deleteAtom } from './vault-store.mjs';
import { HybridIndex } from './hybrid-index.mjs';
import { auditWrite, auditForget, auditRecall, auditSummary, readAudit } from './audit-log.mjs';
import { CodeSymbolIndex } from '../../dist/code-symbol-index.js';
import { resolveVault } from './home.mjs';

const VAULTS = ['strategic', 'technical', 'creative', 'operational', 'wisdom', 'horizon'];
const MEM_TYPES = ['working', 'episodic', 'semantic', 'procedural', 'profile', 'policy', 'aspirational'];
const PRIVACY = ['public', 'private-shareable', 'private', 'secret', 'regulated'];
// Classes that must never be mirrored to any external provider, at any tier.
const LOCAL_ONLY = new Set(['secret', 'regulated']);

function log(...a) { console.error('[starlight-memory]', ...a); }

function resolveConfig(opts) {
  const { vault, source, config } = resolveVault(opts.vault);
  if (config && config.mcp) opts = { ...config.mcp, ...opts };
  const profile = opts.profile || 'all';
  // A writes-only process never answers a query, so loading an embedding
  // model into it is pure RAM cost per harness session.
  const embeddings = profile === 'writes' ? 'off' : (opts.embeddings || 'auto');
  return { vaultRoot: vault, vaultSource: source, writeDir: opts.writeDir || 'atoms', tenant: opts.tenant || 'frank', embeddings, profile };
}

class VaultManager {
  constructor(cfg) { this.cfg = cfg; this.signature = null; this.checkedAt = 0; }
  async load() {
    this.records = await loadVault(this.cfg.vaultRoot, this.cfg.tenant);
    this.index = new HybridIndex(this.records, { embeddings: this.cfg.embeddings });
    await this.index.build();
    this.signature = await vaultSignature(this.cfg.vaultRoot);
    this.checkedAt = Date.now();
    log(`indexed ${this.records.length} atoms from ${this.cfg.vaultRoot}`, this.index.stats());
  }
  /**
   * Several servers can sit over one vault (the pooled plane process plus a
   * native one per harness), and git sync or a human edits files directly.
   * A process that only ever indexes its own writes serves stale memory for
   * its whole lifetime, so every read checks whether the vault moved.
   */
  /**
   * No throttle: a remember on the writes-only process followed by a recall
   * on the pooled one is the normal shape of a single agent turn, and a 2s
   * window turned that into a silent "No matching memories". The walk is a
   * stat per file (a few ms for a few hundred atoms); the cost is reported.
   */
  async refreshIfChanged() {
    const t0 = Date.now();
    const sig = await vaultSignature(this.cfg.vaultRoot);
    this.lastSignatureMs = Date.now() - t0;
    this.checkedAt = Date.now();
    if (sig === this.signature) return false;
    log('vault changed on disk; reindexing');
    await this.load();
    return true;
  }
  byId(id) { return this.records.find((r) => r.memory_id === id); }
}

/**
 * Change detector over every atom's path, size and mtime. Count plus newest
 * mtime missed a delete-and-add of a file restored with an old timestamp;
 * hashing the sorted list catches renames and equal-count swaps too.
 */
async function vaultSignature(root) {
  const rows = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      try { const st = await fs.stat(p); rows.push(`${path.relative(root, p)}:${st.size}:${st.mtimeMs}`); } catch { /* vanished mid-walk */ }
    }
  }
  await walk(root);
  return createHash('sha1').update(rows.sort().join('\n')).digest('hex');
}

const TOOLS = [
  { name: 'memory_recall', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, description: 'Hybrid (lexical + semantic) recall over the memory vault. Use to retrieve prior context, decisions, facts, and notes before acting.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'max results (default 8)' } }, required: ['query'] } },
  { name: 'memory_search', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, description: 'Fast lexical (BM25) search over the vault. Use for keyword/exact-term lookups.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'memory_remember', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, description: 'Persist a durable memory atom to the vault as filesystem-native markdown. Use when a fact, decision, or preference should survive across sessions and agents.', inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'one-line summary' }, content: { type: 'string', description: 'the fact/body' }, vault: { type: 'string', enum: VAULTS }, memory_type: { type: 'string', enum: MEM_TYPES }, privacy_class: { type: 'string', enum: PRIVACY }, importance: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'content'] } },
  { name: 'memory_forget', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, description: 'Delete a memory atom by id.', inputSchema: { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] } },
  { name: 'vault_read', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, description: 'Read the full content of one memory atom by id.', inputSchema: { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] } },
  { name: 'vault_list', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, description: 'List all memory atoms (id + summary + vault).', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'memory_stats', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, description: 'Index + vault statistics (atom count, embeddings status).', inputSchema: { type: 'object', properties: {} } },
  { name: 'memory_audit', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, description: 'Read the append-only log of every read and write against this vault: what was remembered, what was forgotten, and which privacy classes were surfaced into a model context. Queries are logged as fingerprints, never as text.', inputSchema: { type: 'object', properties: { summary: { type: 'boolean', description: 'true (default) returns counts; false returns raw events' }, limit: { type: 'number', description: 'raw events to return (default 50)' } } } },
  { name: 'code_index', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, description: 'AST-aware indexer: scan a directory for code symbols, functions, classes, interfaces, and call graphs.', inputSchema: { type: 'object', properties: { directory: { type: 'string', description: 'directory path (default: current workspace)' } } } },
  { name: 'code_def', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, description: 'AST symbol definition lookup. Returns the exact declaration file, line, and signature of a symbol.', inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'symbol name to locate' } }, required: ['symbol'] } },
  { name: 'code_refs', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, description: 'Find all references and call sites of a symbol across the indexed codebase.', inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'symbol name' } }, required: ['symbol'] } },
  { name: 'code_callers', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, description: 'Find all callers and invocation sites of a function or method.', inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'function or method name' } }, required: ['symbol'] } },
];

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function bad(t) { return { content: [{ type: 'text', text: t }], isError: true }; }
/** Which privacy classes actually crossed into the model's context, counted. */
function surfacedClasses(results) {
  const out = {};
  for (const r of results) {
    const c = r.record?.privacy_class || 'unknown';
    out[c] = (out[c] || 0) + 1;
  }
  return out;
}
function fmt(results) {
  if (!results.length) return 'No matching memories.';
  return results.map((r, i) => {
    const sem = r.semantic == null ? '' : ` sem=${r.semantic}`;
    return `${i + 1}. [${r.record.memory_id}]${r.record.vault ? ' ('+r.record.vault+')' : ''}  score=${r.score.toFixed(4)}${sem}\n   ${r.record.summary || ''}`;
  }).join('\n');
}

async function main() {
  const opts = parseArgs(process.argv);
  const cfg = resolveConfig(opts);
  if (!existsSync(cfg.vaultRoot)) {
    log(`fatal: vault not found at ${cfg.vaultRoot} (resolved from ${cfg.vaultSource}); run: starlight-memory doctor`);
    process.exit(1);
  }
  log(`vault ${cfg.vaultRoot} (from ${cfg.vaultSource})`);
  const mgr = new VaultManager(cfg);
  await mgr.load();

  const codeIndex = new CodeSymbolIndex();

  // Profiles split one server into the two shapes a machine needs: the pooled
  // plane process serves reads (and must load the embedder once), while a
  // per-session native process serves only the audited writes and stays light.
  const PROFILES = {
    all: TOOLS,
    reads: TOOLS.filter((t) => t.annotations.readOnlyHint),
    writes: TOOLS.filter((t) => ['memory_remember', 'memory_forget', 'memory_stats'].includes(t.name)),
  };
  const exposed = PROFILES[cfg.profile];
  if (!exposed) { log(`fatal: unknown --profile ${cfg.profile} (reads|writes|all)`); process.exit(1); }
  log(`profile ${cfg.profile}: ${exposed.length} tools`);

  const server = new Server({ name: 'starlight-memory', version: '0.2.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposed }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      if (!exposed.some((t) => t.name === name)) return bad(`Tool "${name}" is not available in profile "${cfg.profile}".`);
      if (name.startsWith('memory_') || name.startsWith('vault_')) await mgr.refreshIfChanged();
      switch (name) {
        case 'memory_recall': {
          const res = await mgr.index.recall(args.query, args.limit || 8, cfg.tenant);
          await auditRecall({ query: args.query, tenant: cfg.tenant, hits: res.length, surfaced: surfacedClasses(res) });
          return text(fmt(res));
        }
        case 'memory_search': {
          const res = mgr.index.searchLexical(args.query, args.limit || 8, cfg.tenant);
          await auditRecall({ query: args.query, tenant: cfg.tenant, hits: res.length, surfaced: surfacedClasses(res) });
          return text(fmt(res));
        }
        case 'memory_audit': {
          if (args.summary === false) {
            const rows = await readAudit(args.limit || 50);
            return text(rows.map((r) => JSON.stringify(r)).join('\n') || 'No audit events recorded yet.');
          }
          return text(JSON.stringify(await auditSummary(), null, 2));
        }
        case 'memory_remember': {
          const now = new Date().toISOString();
          const privacy = args.privacy_class || 'private';
          // Reject unknown enum values rather than storing them. An unrecognised
          // privacy class defaulting to permissive is how a vault leaks quietly.
          if (!PRIVACY.includes(privacy)) return bad(`privacy_class must be one of: ${PRIVACY.join(', ')}`);
          if (args.vault && !VAULTS.includes(args.vault)) return bad(`vault must be one of: ${VAULTS.join(', ')}`);
          if (args.memory_type && !MEM_TYPES.includes(args.memory_type)) return bad(`memory_type must be one of: ${MEM_TYPES.join(', ')}`);
          if (!String(args.summary || '').trim()) return bad('summary is required and cannot be blank.');
          if (!String(args.content || '').trim()) return bad('content is required and cannot be blank.');

          const record = {
            memory_id: undefined, tenant_id: cfg.tenant, source: { system: 'mcp' }, modality: 'text',
            memory_type: args.memory_type || 'semantic', vault: args.vault,
            raw_content: args.content, summary: args.summary,
            entities: [], relations: [], tags: args.tags || [],
            time_range: { observed_at: now },
            importance: typeof args.importance === 'number' ? args.importance : 0.6, confidence: 0.9, trust: 0.9,
            privacy_class: privacy, retention_policy: 'permanent', provenance: [{ event_id: now, transform: 'raw', at: now }], provider_shadow_refs: {},
          };
          const file = await writeAtom(cfg.vaultRoot, cfg.writeDir, record);
          // The atom is on disk from here. Indexing can still fail (the embedder
          // is a moving part), but the write happened — so it must be audited and
          // reported as a write, never surfaced as an error that implies nothing
          // was stored. Degraded recall is the honest thing to report instead.
          let indexNote = '';
          try {
            await mgr.index.addRecord(record);
          } catch (e) {
            indexNote = `\nwarning: stored, but indexing failed (${e.message}) — recall may miss this atom until the server restarts`;
          }
          await auditWrite({ memory_id: record.memory_id, tenant: cfg.tenant, privacy_class: privacy, vault: record.vault, memory_type: record.memory_type });
          const sealed = LOCAL_ONLY.has(privacy) ? '\nsealed: never mirrored to any external provider' : '';
          return text(`Remembered [${record.memory_id}] -> ${path.relative(cfg.vaultRoot, file)}\nprivacy=${privacy} vault=${record.vault || '-'}${sealed}${indexNote}`);
        }
        case 'memory_forget': {
          const r = mgr.byId(args.memory_id);
          if (!r) return text(`No atom with id "${args.memory_id}".`);
          // A README or a project's MEMORY.md index is indexed for recall but
          // was never authored through this server; deleting it is not "forgetting".
          if (r._no_frontmatter) return bad(`[${args.memory_id}] is a plain markdown file without frontmatter, not an authored atom; delete it by hand if you mean it.`);
          const ok = await deleteAtom(r);
          if (ok) mgr.index.removeRecord(args.memory_id);
          await auditForget({ memory_id: args.memory_id, tenant: cfg.tenant, privacy_class: r.privacy_class, ok });
          return text(ok ? `Forgot [${args.memory_id}].` : `Could not delete [${args.memory_id}] (source may be read-only).`);
        }
        case 'vault_read': {
          const r = mgr.byId(args.memory_id);
          if (!r) return text(`No atom with id "${args.memory_id}".`);
          return text(`# ${r.memory_id}\nvault: ${r.vault || '-'} | type: ${r.memory_type} | privacy: ${r.privacy_class}\nsummary: ${r.summary || ''}\n\n${r.raw_content || ''}`);
        }
        case 'vault_list': {
          const lim = args.limit || 200;
          const list = mgr.records.slice(0, lim).map((r) => `- [${r.memory_id}]${r.vault ? ' ('+r.vault+')' : ''} ${r.summary || ''}`).join('\n');
          return text(`${mgr.records.length} atoms:\n${list}`);
        }
        case 'memory_stats':
          return text(JSON.stringify({ vaultRoot: cfg.vaultRoot, vaultSource: cfg.vaultSource, tenant: cfg.tenant, profile: cfg.profile, change_check_ms: mgr.lastSignatureMs ?? null, ...mgr.index.stats() }, null, 2));
        case 'code_index': {
          const targetDir = args.directory ? path.resolve(args.directory) : process.cwd();
          const summary = await codeIndex.indexDirectory(targetDir);
          return text(`Indexed ${summary.totalFilesIndexed} files in ${targetDir}:\n- ${summary.totalDefinitions} definitions\n- ${summary.totalReferences} references\n- ${summary.totalCallGraphEdges} call edges`);
        }
        case 'code_def': {
          const defs = codeIndex.getDefinitions(args.symbol);
          if (!defs.length) return text(`No definition found for symbol "${args.symbol}". Tip: run code_index first.`);
          return text(defs.map((d) => `[${d.kind}] ${d.name}\n  file: ${d.file}:${d.line}:${d.column}\n  signature: ${d.signature || '-'}`).join('\n\n'));
        }
        case 'code_refs': {
          const refs = codeIndex.getReferences(args.symbol);
          if (!refs.length) return text(`No references found for symbol "${args.symbol}".`);
          return text(refs.map((r) => `  ${r.file}:${r.line}:${r.column} -> ${r.contextSnippet}`).join('\n'));
        }
        case 'code_callers': {
          const callers = codeIndex.getCallers(args.symbol);
          if (!callers.length) return text(`No callers found for symbol "${args.symbol}".`);
          return text(callers.map((c) => `  ${c.file}:${c.line}:${c.column} -> ${c.contextSnippet}`).join('\n'));
        }
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (e) {
      log('tool error', name, e.message);
      return { content: [{ type: 'text', text: `Error in ${name}: ${e.message}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  log('server ready (stdio)');
}

/**
 * Scans for flags wherever they appear. A fixed offset broke depending on entry
 * point — launched directly, `--vault` was dropped and writes silently went to
 * the default vault instead of the requested one.
 */
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') o.vault = argv[++i];
    else if (a === '--profile') o.profile = argv[++i];
    else if (a === '--write-dir') o.writeDir = argv[++i];
    else if (a === '--tenant') o.tenant = argv[++i];
    else if (a === '--embeddings') o.embeddings = argv[++i];
  }
  return o;
}

main().catch((e) => { console.error('[starlight-memory] fatal', e); process.exit(1); });
