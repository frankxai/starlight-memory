// End-to-end smoke over real stdio JSON-RPC against a throwaway vault.
// Not in the unit suite: it spawns a process and touches the filesystem.
// Everything the server writes for itself (audit log, embedding cache, vault
// pointer) goes to a throwaway home too, so a test run never lands in the
// user's real audit log.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const vault = await mkdtemp(path.join(tmpdir(), 'sm-smoke-vault-'));
const home = await mkdtemp(path.join(tmpdir(), 'sm-smoke-home-'));
process.env.STARLIGHT_MEMORY_HOME = home;

// Two projects, each with a MEMORY.md — the shape every Claude Code vault has.
await mkdir(path.join(vault, 'alpha'), { recursive: true });
await mkdir(path.join(vault, 'beta'), { recursive: true });
await writeFile(path.join(vault, 'alpha', 'MEMORY.md'), '---\nsummary: alpha project index about kestrel deploys\nprivacy_class: private\n---\nKestrel deploys on Fridays.\n');
await writeFile(path.join(vault, 'beta', 'MEMORY.md'), '---\nsummary: beta project index about heron billing\nprivacy_class: private\n---\nHeron billing runs monthly.\n');
// No frontmatter at all — the shape of every Claude Code MEMORY.md index.
await writeFile(path.join(vault, 'README.md'), '# Plover vault index\n\n- [Plover migration](plover.md) — cutover notes\n');

const child = spawn(process.execPath, ['src/mcp/server.mjs', '--vault', vault, '--embeddings', 'off'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, STARLIGHT_MEMORY_HOME: home },
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    } catch { /* server logs go to stderr; ignore anything unparseable */ }
  }
});

let id = 0;
function rpc(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 20000).unref();
  });
}
const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const say = (m) => console.log(`  ${m}`);

let failures = 0;
function check(label, fn) {
  try { fn(); say(`PASS  ${label}`); }
  catch (e) { failures++; say(`FAIL  ${label} — ${e.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); say(`PASS  ${label}`); }
  catch (e) { failures++; say(`FAIL  ${label} — ${e.message}`); }
}

try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });

  const tools = await rpc('tools/list', {});
  const names = tools.result.tools.map((t) => t.name);

  check('vector_recall is gone (it could only ever return nothing)', () => {
    assert.ok(!names.includes('vector_recall'), `still present: ${names.join(', ')}`);
  });
  check('memory_audit is exposed', () => {
    assert.ok(names.includes('memory_audit'), `missing from: ${names.join(', ')}`);
  });

  // ── duplicate filenames across folders ──────────────────
  const list0 = (await call('vault_list')).result.content[0].text;
  check('same-named files in different folders get distinct, path-derived ids', () => {
    assert.match(list0, /\[alpha\/MEMORY\]/);
    assert.match(list0, /\[beta\/MEMORY\]/);
  });
  const readBeta = (await call('vault_read', { memory_id: 'beta/MEMORY' })).result.content[0].text;
  check('vault_read resolves the path-derived id to the right file', () => {
    assert.match(readBeta, /Heron billing/);
    assert.doesNotMatch(readBeta, /Kestrel/);
  });
  await call('memory_forget', { memory_id: 'alpha/MEMORY' });
  await checkAsync('forgetting one of them deletes only that file', async () => {
    assert.equal((await readdir(path.join(vault, 'alpha'))).length, 0);
    assert.equal((await readdir(path.join(vault, 'beta'))).length, 1);
  });
  const afterForget = (await call('memory_search', { query: 'kestrel deploys' })).result.content[0].text;
  check('the forgotten atom no longer scores in the index', () => {
    assert.doesNotMatch(afterForget, /alpha\/MEMORY/);
  });

  // ── validation ─────────────────────────────────────────
  const badPrivacy = await call('memory_remember', {
    summary: 'x', content: 'y', privacy_class: 'kinda-private',
  });
  check('unknown privacy_class is rejected, not silently stored', () => {
    assert.equal(badPrivacy.result.isError, true);
    assert.match(badPrivacy.result.content[0].text, /privacy_class must be one of/);
  });

  const blank = await call('memory_remember', { summary: '   ', content: 'y' });
  check('blank summary is rejected', () => {
    assert.equal(blank.result.isError, true);
  });

  const ok = await call('memory_remember', {
    summary: 'Voyage voyage-4 is free to 200M tokens',
    content: 'After that it is $0.06 per 1M tokens. Reranking is $0.05 per 1M.',
    vault: 'technical', privacy_class: 'public', memory_type: 'semantic',
  });
  check('a valid atom is written', () => {
    assert.notEqual(ok.result.isError, true);
    assert.match(ok.result.content[0].text, /^Remembered \[/);
  });

  const sealed = await call('memory_remember', {
    summary: 'Vault seal check', content: 'Secret content.', privacy_class: 'secret',
  });
  check('secret atoms are marked sealed on write', () => {
    assert.match(sealed.result.content[0].text, /sealed: never mirrored/);
  });

  const recall = await call('memory_recall', { query: 'voyage tokens pricing' });
  check('the atom is retrievable immediately, without a full reindex', () => {
    assert.match(recall.result.content[0].text, /voyage-4/i);
  });

  const stats = JSON.parse((await call('memory_stats')).result.content[0].text);
  check('index reflects the writes and the forget incrementally', () => {
    assert.equal(stats.atoms, 4, `expected 4 atoms (beta + README + 2 remembered), got ${stats.atoms}`);
  });
  const plover = (await call('memory_search', { query: 'plover migration cutover' })).result.content[0].text;
  check('a file with no frontmatter is indexed, with its first heading as the summary', () => {
    assert.match(plover, /\[README\]/);
    assert.match(plover, /Plover vault index/);
  });
  const rmReadme = await call('memory_forget', { memory_id: 'README' });
  await checkAsync('forgetting a frontmatter-less file is refused and the file survives', async () => {
    assert.equal(rmReadme.result.isError, true);
    assert.match(rmReadme.result.content[0].text, /not an authored atom/);
    await readFile(path.join(vault, 'README.md'));
  });
  check('memory_stats names the vault and where that path came from', () => {
    assert.equal(path.resolve(stats.vaultRoot), path.resolve(vault));
    assert.equal(stats.vaultSource, 'flag');
  });

  // ── audit ──────────────────────────────────────────────
  const audit = JSON.parse((await call('memory_audit')).result.content[0].text);
  check('audit log recorded the writes and the recall', () => {
    assert.ok(audit.by_event.remember >= 2, `remember events: ${audit.by_event.remember}`);
    assert.ok(audit.by_event.recall >= 1, `recall events: ${audit.by_event.recall}`);
  });
  check('audit distinguishes privacy classes', () => {
    assert.ok(audit.by_privacy_class.secret >= 1, JSON.stringify(audit.by_privacy_class));
    assert.ok(audit.by_privacy_class.public >= 1, JSON.stringify(audit.by_privacy_class));
  });
  check('the audit log lives under the test home, not the real one', () => {
    assert.equal(path.dirname(path.resolve(audit.path)), path.resolve(home));
  });

  const raw = (await call('memory_audit', { summary: false, limit: 20 })).result.content[0].text;
  check('raw audit logs a query fingerprint, never the query text', () => {
    assert.ok(raw.includes('query_fp'), 'no fingerprint field');
    assert.ok(!raw.includes('voyage tokens pricing'), 'the raw query text leaked into the log');
  });

  // ── another writer changes the vault under a running server ──
  // No sleeps: a write on one process and a recall on another is one agent
  // turn, so the change check must not be time-gated.
  await writeFile(path.join(vault, 'beta', 'osprey.md'), '---\nsummary: osprey telemetry pipeline notes\nprivacy_class: private\n---\nOsprey ships telemetry hourly.\n');
  const external = (await call('memory_search', { query: 'osprey telemetry' })).result.content[0].text;
  check('a file written by another process is recalled on the very next call, with no delay', () => {
    assert.match(external, /osprey/);
  });
  await rm(path.join(vault, 'beta', 'osprey.md'));
  const gone = (await call('memory_search', { query: 'osprey telemetry' })).result.content[0].text;
  check('a file deleted by another process stops being recalled immediately', () => {
    assert.doesNotMatch(gone, /osprey/);
  });
  // Count unchanged and the replacement backdated: what a git checkout or a
  // restic restore looks like on disk.
  const { utimes } = await import('node:fs/promises');
  const swapped = path.join(vault, 'beta', 'ibis.md');
  await writeFile(swapped, '---\nsummary: ibis rollback procedure\nprivacy_class: private\n---\nIbis rolls back in one command.\n');
  const old = new Date(Date.now() - 86400000);
  await utimes(swapped, old, old);
  const backdated = (await call('memory_search', { query: 'ibis rollback' })).result.content[0].text;
  check('an equal-count swap whose replacement carries an older timestamp is still detected', () => {
    assert.match(backdated, /ibis/);
  });
  await rm(swapped);
} finally {
  child.kill();
}

// ── writes-only profile: the per-session shape for harnesses that read via the plane ──
{
  const w = spawn(process.execPath, ['src/mcp/server.mjs', '--vault', vault, '--profile', 'writes'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, STARLIGHT_MEMORY_HOME: home } });
  let wbuf = ''; const wpending = new Map(); let wid = 0; let wlog = '';
  w.stderr.on('data', (d) => { wlog += d; });
  w.stdout.on('data', (d) => { wbuf += d; let i; while ((i = wbuf.indexOf('\n')) !== -1) { const l = wbuf.slice(0, i).trim(); wbuf = wbuf.slice(i + 1); try { const m = JSON.parse(l); wpending.get(m.id)?.(m); } catch {} } });
  const wrpc = (method, params) => new Promise((res, rej) => { const my = ++wid; wpending.set(my, res); w.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n'); setTimeout(() => rej(new Error('timeout ' + method)), 20000).unref(); });
  try {
    await wrpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    const wnames = (await wrpc('tools/list', {})).result.tools.map((t) => t.name).sort();
    check('writes profile exposes only remember, forget and stats', () => {
      assert.deepEqual(wnames, ['memory_forget', 'memory_remember', 'memory_stats']);
    });
    const denied = await wrpc('tools/call', { name: 'memory_recall', arguments: { query: 'x' } });
    check('a read called on a writes-only server is refused, not silently served', () => {
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /not available in profile "writes"/);
    });
    const wstats = JSON.parse((await wrpc('tools/call', { name: 'memory_stats', arguments: {} })).result.content[0].text);
    check('writes profile never loads an embedding model', () => {
      assert.equal(wstats.embeddings, 'lexical-only');
      assert.match(wlog, /profile writes: 3 tools/);
    });
  } finally { w.kill(); }
}

// ── embedding cache: append-only, torn lines counted, compaction atomic ───
// Exercised in-process with a stub embedder so it needs no model download.
const { HybridIndex, EMB_CACHE } = await import('../src/mcp/hybrid-index.mjs');
const { resolveVault, writeVaultPointer, VAULT_POINTER } = await import('../src/mcp/home.mjs');
const { planRegistration } = await import('../src/mcp/register.mjs');

function stubIndex(records) {
  const ix = new HybridIndex(records, { embeddings: 'on' });
  ix._loadEmbedder = async () => { ix.embedder = true; };
  ix._embed = async (t) => Float32Array.from([t.length, 1, 0]);
  return ix;
}
const rec = (idn, summary) => ({ memory_id: idn, tenant_id: 'frank', summary, raw_content: summary, tags: [], entities: [], importance: 0.5, privacy_class: 'private' });

await checkAsync('remember appends one line and keeps a line another process appended after this one loaded', async () => {
  const a = stubIndex([rec('a1', 'first atom')]);
  await a.build();
  const before = (await readFile(EMB_CACHE, 'utf8')).split('\n').filter(Boolean);
  assert.equal(before.length, 1);
  // Appended by a second server after `a` took its in-memory snapshot.
  await appendFile(EMB_CACHE, JSON.stringify({ k: 'other-process:summary:deadbeef', v: [9, 9, 9] }) + '\n');
  await a.addRecord(rec('a2', 'second atom'));
  const after = (await readFile(EMB_CACHE, 'utf8')).split('\n').filter(Boolean);
  assert.equal(after.length, 3, `expected 3 lines, got ${after.length}`);
  assert.ok(after.some((l) => l.includes('other-process')), 'another process’s line was clobbered');
});

await checkAsync('a torn last line is counted as corrupt, and the entry glued onto it is lost with it (not silently kept)', async () => {
  await appendFile(EMB_CACHE, '{"k":"torn","v":[1,2');
  // What a crash mid-append followed by a healthy append looks like on disk.
  await appendFile(EMB_CACHE, JSON.stringify({ k: 'glued:summary:0', v: [1, 1, 1] }) + '\n');
  const b = stubIndex([rec('a1', 'first atom')]);
  await b.build();
  assert.equal(b.stats().cache_corrupt_lines, 1);
  assert.ok(!b.cache.has('glued:summary:0'), 'a line glued onto a torn one is not a valid entry and must not be trusted');
  assert.ok(b.cache.has('other-process:summary:deadbeef'));
});

await checkAsync('compaction merges what another process appended during the embed loop instead of erasing it', async () => {
  // Twelve rewrites of one key: one live entry, eleven dead lines → triggers compaction.
  for (let i = 0; i < 12; i++) await appendFile(EMB_CACHE, JSON.stringify({ k: 'a1:summary:rewritten', v: [i, 0, 0] }) + '\n');
  const c = stubIndex([rec('a1', 'first atom'), rec('a3', 'third atom')]);
  // While `c` is embedding a3, a second server appends its own vector.
  const embed = c._embed;
  c._embed = async (t) => { await appendFile(EMB_CACHE, JSON.stringify({ k: 'concurrent:summary:beef', v: [7, 7, 7] }) + '\n'); return embed(t); };
  await c.build();
  const lines = (await readFile(EMB_CACHE, 'utf8')).split('\n').filter(Boolean);
  assert.ok(lines.some((l) => l.includes('"concurrent:summary:beef"')), 'the concurrent append was erased by compaction');
  assert.ok(lines.some((l) => l.includes('"a3:')), 'own fresh vector missing after compaction');
  assert.equal(lines.filter((l) => l.includes('"a1:summary:rewritten"')).length, 1, 'dead rewrites not collapsed');
  assert.equal(c.stats().cache_corrupt_lines, 0);
  const left = await readdir(home);
  assert.ok(!left.some((f) => f.endsWith('.tmp') || f.endsWith('.lock')), `temp or lock file left behind: ${left}`);
});

await checkAsync('compaction is skipped and reported while a fresh lock is held by another process', async () => {
  await writeFile(`${EMB_CACHE}.lock`, '');
  for (let i = 0; i < 12; i++) await appendFile(EMB_CACHE, JSON.stringify({ k: 'a1:summary:again', v: [i, 0, 0] }) + '\n');
  const d = stubIndex([rec('a1', 'first atom')]);
  await d.build();
  const lines = (await readFile(EMB_CACHE, 'utf8')).split('\n').filter(Boolean);
  assert.ok(lines.filter((l) => l.includes('"a1:summary:again"')).length === 12, 'compacted despite a held lock');
  assert.match(String(d.stats().cache_compaction_blocked), /lock held/);
});

await checkAsync('a lock left by a crashed process (older than 5 min) is broken and compaction proceeds', async () => {
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(`${EMB_CACHE}.lock`, old, old);
  const e = stubIndex([rec('a1', 'first atom')]);
  await e.build();
  const lines = (await readFile(EMB_CACHE, 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.filter((l) => l.includes('"a1:summary:again"')).length, 1, 'stale lock was not broken');
  assert.equal(e.stats().cache_compaction_blocked, null);
  assert.ok(!(await readdir(home)).some((f) => f.endsWith('.lock')), 'lock left behind after compaction');
});

await checkAsync('removeRecord drops every doc carrying the id, not just the first', async () => {
  const d = new HybridIndex([rec('dup', 'one'), rec('dup', 'two'), rec('keep', 'three')], { embeddings: 'off' });
  d.removeRecord('dup');
  assert.equal(d.stats().atoms, 1);
  assert.equal(d.searchLexical('one two').length, 0);
});

// ── vault resolution + registration dry run ───────────────
await checkAsync('the vault pointer written by wire/register wins over the legacy default', async () => {
  await writeVaultPointer(vault);
  const r = resolveVault(null);
  assert.equal(path.resolve(r.vault), path.resolve(vault));
  assert.match(r.source, /pointer/);
  assert.equal(path.dirname(path.resolve(VAULT_POINTER)), path.resolve(home));
});

await checkAsync('register plans a merge for a JSON harness and leaves unknown keys intact', async () => {
  const fake = path.join(home, 'fake-claude.json');
  await writeFile(fake, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
  const { HARNESSES } = await import('../src/mcp/register.mjs');
  const saved = HARNESSES['claude-code'].file;
  HARNESSES['claude-code'].file = fake;
  try {
    const plans = await planRegistration({ vault, harnesses: ['claude-code'] });
    assert.equal(plans[0].action, 'merge');
    await plans[0].write();
    const j = JSON.parse(await readFile(fake, 'utf8'));
    assert.equal(j.theme, 'dark');
    assert.ok(j.mcpServers.other, 'existing server dropped');
    assert.equal(j.mcpServers['starlight-memory'].command, 'node');
    assert.ok(j.mcpServers['starlight-memory'].args.includes('--vault'));
    assert.ok((await readdir(home)).some((f) => f.startsWith('fake-claude.json.bak-')), 'no backup written');
    const again = await planRegistration({ vault, harnesses: ['claude-code'] });
    assert.equal(again[0].action, 'already');
    // The canonical vault moved: a registration baked with the old path is an update, and doctor-state flags it.
    const other = path.join(home, 'other-vault');
    await mkdir(other, { recursive: true });
    const moved = await planRegistration({ vault: other, harnesses: ['claude-code'] });
    assert.equal(moved[0].action, 'update');
    const { registrationState } = await import('../src/mcp/register.mjs');
    const state = (await registrationState({ vault: other })).find((h) => h.id === 'claude-code');
    assert.equal(state.vaultMismatch, true);
    assert.equal(path.resolve(state.vault), path.resolve(vault));
  } finally { HARNESSES['claude-code'].file = saved; }
});

await checkAsync('a config rewritten by a live session between plan and write is refused, not clobbered', async () => {
  const fake = path.join(home, 'live-claude.json');
  await writeFile(fake, JSON.stringify({ mcpServers: {}, projects: { a: 1 } }));
  const { HARNESSES } = await import('../src/mcp/register.mjs');
  const saved = HARNESSES['claude-code'].file;
  HARNESSES['claude-code'].file = fake;
  try {
    const plans = await planRegistration({ vault, harnesses: ['claude-code'] });
    // A live Claude Code session writes the file after the plan was computed.
    await writeFile(fake, JSON.stringify({ mcpServers: {}, projects: { a: 1, b: 2 } }));
    await assert.rejects(() => plans[0].write(), /changed since this plan was computed/);
    const after = JSON.parse(await readFile(fake, 'utf8'));
    assert.equal(after.projects.b, 2, 'the concurrent write was clobbered');
    assert.ok(!after.mcpServers['starlight-memory'], 'wrote anyway after detecting the change');
  } finally { HARNESSES['claude-code'].file = saved; }
});

await checkAsync('register appends a TOML table for Codex without disturbing the file', async () => {
  const fake = path.join(home, 'fake-codex.toml');
  await writeFile(fake, 'model = "x"\n\n[mcp_servers.n8n]\ncommand = "npx"\n');
  const { HARNESSES } = await import('../src/mcp/register.mjs');
  const saved = HARNESSES.codex.file;
  HARNESSES.codex.file = fake;
  try {
    const plans = await planRegistration({ vault, harnesses: ['codex'] });
    assert.equal(plans[0].action, 'append');
    await plans[0].write();
    const t = await readFile(fake, 'utf8');
    assert.match(t, /^\[mcp_servers\.n8n\]/m);
    assert.match(t, /^\[mcp_servers\.starlight-memory\]/m);
    assert.match(t, /"--vault"/);
    // Update path: the table is replaced whole, even though its args line opens with `[`,
    // and a table that follows it is untouched.
    // Tables with digits and nested env tables follow ours, as in the real Codex config.
    await writeFile(fake, t + '\n[mcp_servers.v0]\ncommand = "v"\n\n[mcp_servers.v0.env_http_headers]\nX = "1"\n\n[mcp_servers.after]\ncommand = "z"\n');
    const other = path.join(home, 'other-vault-toml');
    await mkdir(other, { recursive: true });
    const upd = await planRegistration({ vault: other, harnesses: ['codex'] });
    assert.equal(upd[0].action, 'update');
    await upd[0].write();
    const u = await readFile(fake, 'utf8');
    assert.equal((u.match(/^\[mcp_servers\.starlight-memory\]/mg) || []).length, 1, 'table duplicated');
    assert.equal((u.match(/^args\s*=/mg) || []).length, 1, `orphaned args line: \n${u}`);
    assert.match(u, /^\[mcp_servers\.after\]\ncommand = "z"/m);
    assert.match(u, /^\[mcp_servers\.v0\]\ncommand = "v"/m, 'a table with a digit in its name was swallowed');
    assert.match(u, /^\[mcp_servers\.v0\.env_http_headers\]\nX = "1"/m, 'a nested table was swallowed');
    assert.match(u, /other-vault-toml/);
    assert.match(u, /^\[mcp_servers\.n8n\]\ncommand = "npx"/m);
  } finally { HARNESSES.codex.file = saved; }
});

await rm(vault, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
