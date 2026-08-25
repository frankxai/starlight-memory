// starlight-memory MCP server — exposes the vault (L1) + hybrid index (L2) to any
// coding agent over stdio. This is the cross-agent unlock: one server, one vault,
// every harness config points here. All diagnostics go to stderr (stdout is the
// JSON-RPC channel).
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadVault, writeAtom, deleteAtom } from './vault-store.mjs';
import { HybridIndex } from './hybrid-index.mjs';
import { CodeSymbolIndex } from '../../dist/code-symbol-index.js';
import { PGLiteVectorProvider } from '../../dist/pglite-provider.js';

const VAULTS = ['strategic', 'technical', 'creative', 'operational', 'wisdom', 'horizon'];
const MEM_TYPES = ['working', 'episodic', 'semantic', 'procedural', 'profile', 'policy', 'aspirational'];
const PRIVACY = ['public', 'private-shareable', 'private', 'secret', 'regulated'];

function log(...a) { console.error('[starlight-memory]', ...a); }

async function resolveConfig(opts) {
  let vaultRoot = opts.vault;
  if (!vaultRoot) {
    for (const c of ['starlight-memory.config.json', '.starlight-memory.json']) {
      const p = path.resolve(c);
      if (existsSync(p)) { try { const cfg = JSON.parse(await fs.readFile(p, 'utf8')); vaultRoot = path.resolve(path.dirname(p), (cfg.mcp && cfg.mcp.vaultRoot) || cfg.vault || '.'); opts = { ...(cfg.mcp || {}), ...opts }; } catch {} break; }
    }
  }
  vaultRoot = vaultRoot || path.join(os.homedir(), 'starlight-memory-vault');
  return { vaultRoot, writeDir: opts.writeDir || 'atoms', tenant: opts.tenant || 'frank', embeddings: opts.embeddings || 'auto' };
}

class VaultManager {
  constructor(cfg) { this.cfg = cfg; }
  async load() {
    this.records = await loadVault(this.cfg.vaultRoot, this.cfg.tenant);
    this.index = new HybridIndex(this.records, { embeddings: this.cfg.embeddings });
    await this.index.build();
    log(`indexed ${this.records.length} atoms from ${this.cfg.vaultRoot}`, this.index.stats());
  }
  byId(id) { return this.records.find((r) => r.memory_id === id); }
}

const TOOLS = [
  { name: 'memory_recall', description: 'Hybrid (lexical + semantic) recall over the memory vault. Use to retrieve prior context, decisions, facts, and notes before acting.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'max results (default 8)' } }, required: ['query'] } },
  { name: 'memory_search', description: 'Fast lexical (BM25) search over the vault. Use for keyword/exact-term lookups.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'memory_remember', description: 'Persist a durable memory atom to the vault as filesystem-native markdown. Use when a fact, decision, or preference should survive across sessions and agents.', inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'one-line summary' }, content: { type: 'string', description: 'the fact/body' }, vault: { type: 'string', enum: VAULTS }, memory_type: { type: 'string', enum: MEM_TYPES }, privacy_class: { type: 'string', enum: PRIVACY }, importance: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'content'] } },
  { name: 'memory_forget', description: 'Delete a memory atom by id.', inputSchema: { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] } },
  { name: 'vault_read', description: 'Read the full content of one memory atom by id.', inputSchema: { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] } },
  { name: 'vault_list', description: 'List all memory atoms (id + summary + vault).', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'memory_stats', description: 'Index + vault statistics (atom count, embeddings status).', inputSchema: { type: 'object', properties: {} } },
  { name: 'code_index', description: 'AST-aware indexer: scan a directory for code symbols, functions, classes, interfaces, and call graphs.', inputSchema: { type: 'object', properties: { directory: { type: 'string', description: 'directory path (default: current workspace)' } } } },
  { name: 'code_def', description: 'AST symbol definition lookup. Returns the exact declaration file, line, and signature of a symbol.', inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'symbol name to locate' } }, required: ['symbol'] } },
  { name: 'code_refs', description: 'Find all references and call sites of a symbol across the indexed codebase.', inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'symbol name' } }, required: ['symbol'] } },
  { name: 'code_callers', description: 'Find all callers and invocation sites of a function or method.', inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'function or method name' } }, required: ['symbol'] } },
  { name: 'vector_recall', description: 'In-process PGLite vector similarity recall across stored memories using cosine embeddings.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
];

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function fmt(results) {
  if (!results.length) return 'No matching memories.';
  return results.map((r, i) => {
    const sem = r.semantic == null ? '' : ` sem=${r.semantic}`;
    return `${i + 1}. [${r.record.memory_id}]${r.record.vault ? ' ('+r.record.vault+')' : ''}  score=${r.score.toFixed(4)}${sem}\n   ${r.record.summary || ''}`;
  }).join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(3)); // after: node bin ... mcp serve
  const cfg = await resolveConfig(opts);
  const mgr = new VaultManager(cfg);
  await mgr.load();

  const codeIndex = new CodeSymbolIndex();
  const pglite = new PGLiteVectorProvider();

  const server = new Server({ name: 'starlight-memory', version: '0.2.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      switch (name) {
        case 'memory_recall': {
          const res = await mgr.index.recall(args.query, args.limit || 8, cfg.tenant);
          return text(fmt(res));
        }
        case 'memory_search': {
          const res = mgr.index.searchLexical(args.query, args.limit || 8, cfg.tenant);
          return text(fmt(res));
        }
        case 'memory_remember': {
          const now = new Date().toISOString();
          const record = {
            memory_id: undefined, tenant_id: cfg.tenant, source: { system: 'mcp' }, modality: 'text',
            memory_type: args.memory_type || 'semantic', vault: args.vault,
            raw_content: args.content, summary: args.summary,
            entities: [], relations: [], tags: args.tags || [],
            time_range: { observed_at: now },
            importance: typeof args.importance === 'number' ? args.importance : 0.6, confidence: 0.9, trust: 0.9,
            privacy_class: args.privacy_class || 'private', retention_policy: 'permanent', provenance: [{ event_id: now, transform: 'raw', at: now }], provider_shadow_refs: {},
          };
          // privacy gate: secret/regulated stay local (local_core authoritative); no mirrors exist yet.
          const file = await writeAtom(cfg.vaultRoot, cfg.writeDir, record);
          await mgr.load(); // reindex (cheap; embeddings cached)
          return text(`Remembered [${record.memory_id}] -> ${path.relative(cfg.vaultRoot, file)}\nprivacy=${record.privacy_class} vault=${record.vault || '-'}`);
        }
        case 'memory_forget': {
          const r = mgr.byId(args.memory_id);
          if (!r) return text(`No atom with id "${args.memory_id}".`);
          const ok = await deleteAtom(r);
          await mgr.load();
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
          return text(JSON.stringify({ vaultRoot: cfg.vaultRoot, tenant: cfg.tenant, ...mgr.index.stats() }, null, 2));
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
        case 'vector_recall': {
          const results = await pglite.recall({ tenant_id: cfg.tenant, query: args.query, limit: args.limit || 8 });
          return text(fmt(results));
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

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') o.vault = argv[++i];
    else if (a === '--write-dir') o.writeDir = argv[++i];
    else if (a === '--tenant') o.tenant = argv[++i];
    else if (a === '--embeddings') o.embeddings = argv[++i];
  }
  return o;
}

main().catch((e) => { console.error('[starlight-memory] fatal', e); process.exit(1); });
