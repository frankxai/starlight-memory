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
