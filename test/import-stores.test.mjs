import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeContent, contentHash, findSecret, planImport, substantiveText,
  readMemoryBus, readSisVaults, readGrokMemory, runImport,
} from '../src/mcp/import-stores.mjs';
import { loadVault, parseFrontmatter } from '../src/mcp/vault-store.mjs';

const LONG = 'The vault is the single source of truth and every index is rebuildable from it.';
const cand = (over = {}) => ({ source: 'memory-bus', sourceId: 'a1', body: LONG, summary: 'vault truth', ...over });
const vaultRec = (id, body, extra = {}) => ({ memory_id: id, raw_content: body, _path: `/v/${id}.md`, ...extra });
// Assembled at runtime so no credential-shaped literal sits in the source file.
const fake = (...parts) => parts.join('');

test('normalizer strips the indexer tag and frontmatter so a bus copy matches its vault original', () => {
  const bus = `[xrepo_9920cd53fca540f4] ---\nname: x\ndescription: "y"\n---\n\n  ${LONG.toUpperCase()}\n`;
  assert.equal(normalizeContent(bus), LONG.toLowerCase());
  assert.equal(contentHash(bus), contentHash(LONG));
  assert.equal(normalizeContent('a\n\n  b\tc'), 'a b c');
});

test('secret detector fires on credential shapes and stays quiet on prose about them', () => {
  const fakes = [
    fake('key sk-', 'ant-', 'a'.repeat(30)),
    fake('gh', 'p_', 'A'.repeat(36)),
    fake('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
    fake('AI', 'za', 'b'.repeat(35)),
    fake('-----BEGIN RSA ', 'PRIVATE KEY-----', '\nabc'),
    fake('Authorization: Bea', 'rer ', 'x'.repeat(24)),
    fake('api_key', ' = "', 'k'.repeat(24), '"'),
    fake('ey', 'J', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3', '.', 'dozjgNryP4J3jVmNHl0w5N'),
  ];
  for (const f of fakes) assert.ok(findSecret(f), `should flag: ${f.slice(0, 12)}`);
  const clean = [
    'secret scan (no `AKIA`/`ghp_`/`sk-`/`BEGIN PRIVATE` literals)',
    'token: ${STARLIGHT_MEMORY_MCP_TOKEN}',
    'the sk-launch-train skill and sk-liveness checks',
    'password rotation happens through Infisical',
  ];
  for (const c of clean) assert.equal(findSecret(c), null, `false positive: ${c}`);
});

test('plan: exact vault copy, batch repeat and vault-contained snippet are dups; new content is kept', () => {
  const vault = [vaultRec('existing', `${LONG}\n\nMore context lives here in the original atom.`)];
  const plan = planImport([
    cand({ sourceId: 'exact', body: `[xrepo_ab] ${LONG}\n\nMore context lives here in the original atom.` }),
    cand({ sourceId: 'contained', body: LONG }),
    cand({ sourceId: 'new1', body: 'A genuinely new memory about embedding caches being append-only logs.' }),
    cand({ sourceId: 'new2', body: 'A GENUINELY new memory about embedding caches being   append-only logs.' }),
  ], vault);
  const by = Object.fromEntries(plan.items.map((i) => [i.sourceId, i]));
  assert.equal(by.exact.decision, 'dup'); assert.equal(by.exact.reason, 'vault-exact'); assert.equal(by.exact.dupOf, 'existing');
  assert.equal(by.contained.decision, 'dup'); assert.equal(by.contained.reason, 'vault-contains');
  assert.equal(by.new1.decision, 'kept');
  assert.equal(by.new2.decision, 'dup'); assert.equal(by.new2.reason, 'batch-exact'); assert.equal(by.new2.dupOf, by.new1.memory_id);
  assert.deepEqual(plan.counts['memory-bus'], { read: 4, kept: 1, dup: 3, 'skipped-trivial': 0, 'skipped-secret': 0, reasons: { 'dup:vault-exact': 1, 'dup:vault-contains': 1, 'dup:batch-exact': 1 } });
});

test('plan: trivial, heading-only, boilerplate and reader-flagged skips never become atoms', () => {
  const plan = planImport([
    cand({ sourceId: 'short', body: 'too short to matter' }),
    cand({ sourceId: 'stub', body: '# Project Memory — C:\\Users\\frank\\generated\\nightly\n\n> Auto-populated by dream consolidation. Edit freely.' }),
    cand({ sourceId: 'pointer', body: LONG, skip: 'index-pointer' }),
  ], []);
  assert.deepEqual(plan.items.map((i) => [i.decision, i.reason]), [
    ['skipped-trivial', 'short'], ['skipped-trivial', 'heading-or-boilerplate-only'], ['skipped-trivial', 'index-pointer'],
  ]);
  assert.equal(substantiveText('## Decisions\n- chose BM25 as the floor because it needs no model at all'), '- chose BM25 as the floor because it needs no model at all');
});

test('plan: a secret wins over every other decision and its content never reaches the report', () => {
  const secretBody = `${LONG} ${fake('gh', 'p_', 'Z'.repeat(36))}`;
  const plan = planImport([cand({ sourceId: 's', body: secretBody }), cand({ sourceId: 's2', body: secretBody, skip: 'fixture' })], [vaultRec('v', secretBody)]);
  assert.deepEqual(plan.items.map((i) => i.decision), ['skipped-secret', 'skipped-secret']);
  assert.ok(!JSON.stringify(plan.items).includes('ZZZZ'));
});

test('plan: a secret hiding in tags or the source name is caught too', () => {
  const tok = fake('gh', 'p_', 'Q'.repeat(36));
  const plan = planImport([cand({ sourceId: 't', tags: ['imported', tok] }), cand({ sourceId: 'n', name: tok, body: `${LONG} other` })], []);
  assert.deepEqual(plan.items.map((i) => i.decision), ['skipped-secret', 'skipped-secret']);
});

test('dedupe sees vault facts stored only in normalized_fact, and tags that follow frontmatter', () => {
  const plan = planImport([cand({ body: LONG })], [vaultRec('fact-only', '', { normalized_fact: LONG })]);
  assert.equal(plan.items[0].decision, 'dup');
  assert.equal(plan.items[0].dupOf, 'fact-only');
  assert.equal(normalizeContent(`---\nname: x\n---\n[xrepo_12ab] ${LONG}`), LONG.toLowerCase());
});

test('plan: another version of a vault memory is kept but flagged for a human', () => {
  const plan = planImport([cand({ name: 'feedback_file_review', body: 'When I create one essential file, summarize it inline or open it in Notepad, 2026 version.' })],
    [vaultRec('feedback_file_review', 'When I create one essential file, summarize it inline.')]);
  assert.equal(plan.items[0].decision, 'kept');
  assert.equal(plan.items[0].sameNameAs, 'feedback_file_review');
});

test('kept atoms carry provenance frontmatter the vault loader reads back', () => {
  const plan = planImport([cand({ sourceId: 'atom_17.5', summary: 'has "quotes": and a colon', tags: ['imported', 'a,b'] })], [], { importedAt: '2026-09-26T00:00:00.000Z' });
  const { data, body } = parseFrontmatter(plan.items[0].atom);
  assert.equal(data.source, 'memory-bus');
  assert.equal(data.sourceId, 'atom_17.5');
  assert.equal(data.importedAt, '2026-09-26T00:00:00.000Z');
  assert.equal(data.contentHash, `sha256:${contentHash(LONG)}`);
  assert.equal(data.summary, "has 'quotes': and a colon");
  assert.equal(data.privacy_class, 'private');
  assert.deepEqual(data.tags, ['imported', 'a b']);
  assert.equal(body, LONG);
});

async function fixtureStores() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-import-'));
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault, { recursive: true });
  await fs.writeFile(path.join(vault, 'existing.md'), `---\nname: existing\n---\n\n${LONG}\n`);
  const bus = path.join(root, 'atoms.jsonl');
  await fs.writeFile(bus, [
    { id: 'b1', text: `[xrepo_aa] ---\nname: existing\n---\n\n${LONG}\n`, namespace: 'cross-repo/frankx/other', timestamp: '2026-05-27T22:45:32' },
    { id: 'b2', text: '[xrepo_bb] - [Voice](voice.md) — strategic rules for the developer persona voice', namespace: 'cross-repo/frankx/index', timestamp: '2026-05-27T22:45:32' },
    { id: 'b3', text: '[xrepo_cc] # Kura\n\nKura is a Chrome extension that harvests Suno tracks into the catalog.', namespace: 'cross-repo/kura/other', timestamp: '2026-05-27T22:45:32' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n{not json\n');
  const sis = path.join(root, 'vaults');
  await fs.mkdir(sis);
  await fs.writeFile(path.join(sis, 'creative.jsonl'), [
    { id: 'w', content: 'Welcome to your creative vault — add memories with the MCP tool whenever you like.', source: 'seed', createdAt: '2026-06-03T00:41:31Z' },
    { id: 'c1', insight: 'NEVER use Cinzel font — Inter for body, Space Grotesk for display.', category: 'design', tags: ['type'], createdAt: '2026-04-02T12:00:00Z' },
    { id: 'c2', meditation: 'Creation is water; it finds its own path if you stop damming it.', context: 'written on an ordinary day', createdAt: '2026-04-02T12:00:00Z' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const grok = path.join(root, 'grok');
  const ws = path.join(grok, 'workspaces', 'w1');
  for (const d of ['topics', 'observations/_inbox', 'archive/dream_1']) await fs.mkdir(path.join(ws, d), { recursive: true });
  await fs.writeFile(path.join(ws, 'MEMORY.md'), '# Workspace memory index\n\n- **Topic** — something long enough to pass the trivial filter');
  await fs.writeFile(path.join(ws, 'topics', 't.md'), '# Grok hooks\nGrok Windows hooks cannot use LASTEXITCODE; they must exit explicitly.');
  await fs.writeFile(path.join(ws, 'observations', '_inbox', 'o.md'), '---\nschema_version: 2\ntype: user\nkeywords: ["codex","cleanup"]\ncreated_at: 1790431430\n---\n\n# The user wants idle Codex runtimes cleaned up without killing live work.\n\nDetails.');
  await fs.writeFile(path.join(ws, 'archive', 'dream_1', 'a.md'), '---\ntype: user\n---\n\n# An archived observation already folded into a topic long ago.');
  return { root, vault, sources: { bus, sisDir: sis, grokDir: grok } };
}

test('readers normalise each store into candidates with provenance and reader-level skips', async () => {
  const { sources } = await fixtureStores();
  const bus = await readMemoryBus(sources.bus);
  assert.deepEqual(bus.map((c) => [c.sourceId, c.skip]), [['b1', null], ['b2', 'index-pointer'], ['b3', null], ['line:4', 'unparseable']]);
  assert.equal(bus[0].name, 'existing');
  assert.equal(bus[2].summary, 'Kura: Kura is a Chrome extension that harvests Suno tracks into the catalog.');

  const sis = await readSisVaults(sources.sisDir);
  assert.deepEqual(sis.map((c) => c.skip), ['seed', null, null]);
  assert.equal(sis[1].vault, 'creative');
  assert.ok(sis[1].tags.includes('design') && sis[1].tags.includes('type'));
  assert.equal(sis[2].summary, 'Creation is water; it finds its own path if you stop damming it.');
  assert.match(sis[2].body, /context: written on an ordinary day/);

  const grok = await readGrokMemory(sources.grokDir);
  assert.deepEqual(grok.map((c) => c.origin).sort(), ['index', 'observation', 'topic']);
  const obs = grok.find((c) => c.origin === 'observation');
  assert.equal(obs.memory_type, 'profile');
  assert.equal(obs.observed_at, new Date(1790431430 * 1000).toISOString());
  assert.ok(obs.tags.includes('codex'));
  assert.equal((await readGrokMemory(sources.grokDir, { includeArchive: true })).length, 4);
});

test('runImport: dry run writes nothing; --out stages loadable atoms; --out inside the vault is refused', async () => {
  const { root, vault, sources } = await fixtureStores();
  const dry = await runImport({ vault, sources });
  assert.equal(dry.counts['memory-bus'].dup, 1);
  assert.equal(dry.counts['memory-bus'].kept, 1);
  assert.equal(dry.counts['sis-vault'].kept, 2);
  assert.equal(dry.counts['grok-memory-v2'].kept, 2);
  assert.deepEqual((await fs.readdir(root)).sort(), ['atoms.jsonl', 'grok', 'vault', 'vaults']);

  const out = path.join(root, 'staging');
  await runImport({ vault, out, sources });
  const staged = await loadVault(out);
  assert.equal(staged.length, 5);
  assert.ok(JSON.parse(await fs.readFile(path.join(out, 'import-report.json'), 'utf8')).items.every((i) => !('atom' in i)));

  await assert.rejects(runImport({ vault, out: path.join(vault, 'imported'), sources }), /inside the vault/);
  if (process.platform === 'win32') await assert.rejects(runImport({ vault, out: path.join(vault.toUpperCase(), 'imported'), sources }), /inside the vault/);
  assert.deepEqual(await fs.readdir(vault), ['existing.md']);
});
