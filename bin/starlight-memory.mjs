#!/usr/bin/env node
// starlight-memory — portable, zero-dependency CLI to wire an agent's file-based
// memory dirs into a single versioned git vault and sync it across machines.
//
// Cross-OS by construction:
//   - linking uses fs.symlink(type='junction') on Windows (no admin) and 'dir' on POSIX
//   - paths are computed per-machine from a shared, logical-name config
//   - sync is plain git (any remote), no OS scheduler, no gh dependency
//
// Commands: discover | wire | unwire | status | sync | register | doctor | mcp serve | help
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveVault, writeVaultPointer } from '../src/mcp/home.mjs';

const HOME = os.homedir();
const CONFIG_NAMES = ['starlight-memory.config.json', '.starlight-memory.json'];

// ---- Claude Code path encoding -------------------------------------------------
// Claude stores per-project memory at ~/.claude/projects/<hash>/memory, where
// <hash> is the workspace absolute path with separators and the drive colon
// replaced by '-'. Verified: C:\Users\frank\starlight -> C--Users-frank-starlight
function claudeProjectHash(workspaceAbs) {
  return path.resolve(workspaceAbs).replace(/[\\/:]/g, '-');
}
function claudeMemoryDir(workspaceAbs) {
  return path.join(HOME, '.claude', 'projects', claudeProjectHash(workspaceAbs), 'memory');
}

const AGENTS = {
  'claude-code': (t) => t.memoryDir || claudeMemoryDir(t.workspace),
};

// ---- helpers -------------------------------------------------------------------
function die(msg) { console.error(`✖ ${msg}`); process.exit(1); }
function ok(msg) { console.log(`✓ ${msg}`); }
function info(msg) { console.log(`  ${msg}`); }

function git(vault, args, { quiet = false } = {}) {
  const r = spawnSync('git', ['-C', vault, ...args], { encoding: 'utf8' });
  if (!quiet && r.stdout) process.stdout.write(r.stdout);
  if (!quiet && r.stderr) process.stderr.write(r.stderr);
  return r;
}
function isGitRepo(vault) {
  return git(vault, ['rev-parse', '--is-inside-work-tree'], { quiet: true }).status === 0;
}

async function loadConfig(explicit) {
  const candidates = explicit ? [explicit] : CONFIG_NAMES.map((n) => path.resolve(n));
  for (const c of candidates) {
    if (existsSync(c)) {
      const cfg = JSON.parse(await fs.readFile(c, 'utf8'));
      cfg.__dir = path.dirname(c);
      cfg.vault = path.resolve(cfg.__dir, cfg.vault || '.');
      return cfg;
    }
  }
  die(`no config found (looked for ${CONFIG_NAMES.join(', ')}). Run inside your vault or pass --config <path>.`);
}

function resolveAgentMemDir(target) {
  const fn = AGENTS[target.agent];
  if (!fn) die(`unknown agent "${target.agent}" (supported: ${Object.keys(AGENTS).join(', ')})`);
  return fn(target);
}

async function linkKind(p) {
  try {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) return 'link';
    if (st.isDirectory()) return 'dir';
    return 'other';
  } catch { return 'missing'; }
}
async function linkTarget(p) {
  try { return path.resolve(await fs.readlink(p)); } catch { return null; }
}

async function createLink(target, linkPath) {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(path.resolve(target), linkPath, type);
}

async function copyDirInto(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  await fs.cp(src, dest, { recursive: true, force: true, errorOnExist: false });
}

// ---- commands ------------------------------------------------------------------
// Harness-level instruction files. These are not memory stores, but they carry
// standing context and live outside every vault, so losing one loses real work.
const HARNESS_FILES = [
  ['Claude Code', ['.claude', 'CLAUDE.md']],
  ['Codex', ['.codex', 'AGENTS.md']],
  ['Cursor', ['.cursor', 'AGENTS.md']],
  ['Gemini', ['.gemini', 'AGENTS.md']],
  ['Antigravity', ['.antigravity', 'AGENTS.md']],
];

async function cmdDiscover() {
  const root = path.join(HOME, '.claude', 'projects');
  if (!existsSync(root)) return die(`no Claude projects dir at ${root}`);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const { vault, source } = resolveVault(null);

  const linked = [];
  const elsewhere = [];
  const loose = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const mem = path.join(root, e.name, 'memory');
    if (!existsSync(mem)) continue;
    let files = [];
    try { files = (await fs.readdir(mem)).filter((f) => f.endsWith('.md')); } catch { continue; }
    let bytes = 0;
    for (const f of files) {
      try { bytes += (await fs.stat(path.join(mem, f))).size; } catch { /* unreadable file still counts as present */ }
    }
    const kind = await linkKind(mem);
    const row = { project: e.name, dir: mem, files: files.length, bytes, kind };
    if (kind !== 'link') { loose.push(row); continue; }
    // "It is a link" is not "it is in the vault": a link into a second
    // checkout of the same remote looked synced while five weeks went unpushed.
    const tgt = await linkTarget(mem);
    row.target = tgt;
    const inside = tgt && !path.relative(vault, tgt).startsWith('..') && !path.isAbsolute(path.relative(vault, tgt));
    (inside ? linked : elsewhere).push(row);
  }

  const kb = (b) => `${(b / 1024).toFixed(1)}kb`;
  console.log('Claude Code keeps memory per project, on one machine, in a folder no other tool reads.');
  console.log(`This is where yours is.  vault: ${vault}  (from ${source})\n`);

  if (linked.length) {
    console.log(`IN THE VAULT — ${linked.length} project(s), synced and portable`);
    for (const r of linked) console.log(`  ✓ ${r.project}  (${r.files} md, ${kb(r.bytes)})`);
    console.log('');
  }
  if (elsewhere.length) {
    console.log(`LINKED SOMEWHERE ELSE — ${elsewhere.length} project(s), not into this vault`);
    for (const r of elsewhere) console.log(`  ✗ ${r.project}  → ${r.target}  (${r.files} md, ${kb(r.bytes)})`);
    console.log('  Either that path is the real vault (fix the pointer: starlight-memory wire from there), or re-wire these.');
    console.log('');
  }

  // An empty memory dir is a project Claude Code touched but never wrote to.
  // Listing them buries the ones that hold actual work.
  const atRisk = loose.filter((r) => r.files > 0);
  const empty = loose.length - atRisk.length;
  if (atRisk.length) {
    const totalFiles = atRisk.reduce((s, r) => s + r.files, 0);
    const totalBytes = atRisk.reduce((s, r) => s + r.bytes, 0);
    console.log(`NOT IN THE VAULT — ${atRisk.length} project(s), ${totalFiles} files, ${kb(totalBytes)}`);
    console.log('  Local to this machine only. Not synced, not portable, not backed up.');
    for (const r of atRisk.sort((a, b) => b.bytes - a.bytes)) {
      console.log(`  ! ${r.project}  (${r.files} md, ${kb(r.bytes)})`);
    }
    if (empty) console.log(`  · plus ${empty} project dir(s) with no memory written yet`);
    console.log('');
  }

  const harness = [];
  for (const [name, rel] of HARNESS_FILES) {
    const p = path.join(HOME, ...rel);
    if (!existsSync(p)) continue;
    const { size } = await fs.stat(p);
    harness.push(`  ${name.padEnd(13)} ${path.join('~', ...rel)}  (${kb(size)})`);
  }
  if (harness.length) {
    console.log(`HARNESS INSTRUCTIONS — ${harness.length} file(s), outside every vault`);
    console.log(harness.join('\n'));
    console.log('');
  }

  if (atRisk.length) {
    console.log(`Next: add the projects you want to keep to "targets" in starlight-memory.config.json,`);
    console.log(`then run  starlight-memory wire  to move them into the vault and link them back.`);
  } else if (linked.length) {
    console.log('Every project memory dir on this machine is already in the vault.');
  } else {
    console.log('No project memory dirs found yet — Claude Code creates one the first time it writes a memory.');
  }
}

async function cmdWire(cfg) {
  for (const t of cfg.targets) {
    const memDir = resolveAgentMemDir(t);
    const vaultSub = path.join(cfg.vault, t.name);
    await fs.mkdir(vaultSub, { recursive: true });

    const kind = await linkKind(memDir);
    if (kind === 'link') {
      const tgt = await linkTarget(memDir);
      if (tgt && path.resolve(tgt) === path.resolve(vaultSub)) { ok(`${t.name}: already linked`); continue; }
      die(`${t.name}: ${memDir} is a link to ${tgt}, not the vault. Remove it first.`);
    }
    if (kind === 'dir') {
      await copyDirInto(memDir, vaultSub);          // preserve existing memory into the vault
      const bak = `${memDir}._pre_vault_bak`;
      if (existsSync(bak)) await fs.rm(bak, { recursive: true, force: true });
      await fs.rename(memDir, bak);
      info(`${t.name}: backed up existing memory -> ${path.basename(bak)}`);
    }
    await createLink(vaultSub, memDir);
    ok(`${t.name}: linked ${memDir} -> ${vaultSub}`);
  }
  const ptr = await writeVaultPointer(cfg.vault);
  ok(`canonical vault recorded at ${ptr}`);
  console.log(`\nWired ${cfg.targets.length} target(s). Run "starlight-memory sync" to push.`);
}

async function cmdUnwire(cfg) {
  for (const t of cfg.targets) {
    const memDir = resolveAgentMemDir(t);
    if (await linkKind(memDir) === 'link') {
      await fs.rm(memDir, { recursive: true, force: true });
      await copyDirInto(path.join(cfg.vault, t.name), memDir);
      ok(`${t.name}: unlinked; memory restored as a real dir at ${memDir}`);
    } else {
      info(`${t.name}: not a link, skipped`);
    }
  }
}

async function cmdStatus(cfg) {
  console.log(`vault: ${cfg.vault}\n`);
  for (const t of cfg.targets) {
    const memDir = resolveAgentMemDir(t);
    const vaultSub = path.join(cfg.vault, t.name);
    const kind = await linkKind(memDir);
    let state = kind;
    if (kind === 'link') {
      const tgt = await linkTarget(memDir);
      state = (tgt && path.resolve(tgt) === path.resolve(vaultSub)) ? 'linked ✓' : `link→${tgt} ✗`;
    }
    console.log(`  ${t.name.padEnd(32)} ${state}`);
  }
  console.log('\ngit:');
  if (isGitRepo(cfg.vault)) git(cfg.vault, ['status', '--short', '--branch']);
  else info('(vault is not a git repo — run: git init && git remote add origin <url>)');
}

async function cmdSync(cfg, rest) {
  if (!isGitRepo(cfg.vault)) die(`vault is not a git repo: ${cfg.vault}\n  init it first:  git init && git remote add origin <url> && git push -u origin main`);
  const noPush = rest.includes('--no-push');
  if (!noPush) {
    info('pull --rebase --autostash');
    git(cfg.vault, ['pull', '--rebase', '--autostash']);
  }
  git(cfg.vault, ['add', '-A'], { quiet: true });
  const staged = git(cfg.vault, ['diff', '--cached', '--quiet'], { quiet: true });
  if (staged.status === 0) { ok('no local changes'); return; }
  const stamp = new Date().toISOString().slice(0, 16) + 'Z';
  git(cfg.vault, ['commit', '-m', `memory: ${stamp} ${os.hostname()}`], { quiet: true });
  if (noPush) { ok('committed locally (--no-push); run "starlight-memory sync" to push'); return; }
  const push = git(cfg.vault, ['push']);
  if (push.status === 0) ok('pushed'); else die('push failed (see git output above)');
}

async function cmdRegister(rest) {
  const { planRegistration, HARNESSES } = await import('../src/mcp/register.mjs');
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
  const apply = rest.includes('--apply');
  const plane = rest.includes('--plane');
  const { vault, source } = resolveVault(flag('--vault'));
  if (!existsSync(vault)) die(`vault not found at ${vault} (from ${source}); run starlight-memory doctor`);
  const sel = flag('--harness');
  const { PLANE } = await import('../src/mcp/register.mjs');
  const planeHere = existsSync(PLANE.activeRelease);
  // With no selection: the plane when this machine has one (one pooled process
  // for reads), plus native entries for the harnesses that do not talk to it.
  // Native and plane over one vault is fine: servers reindex when the vault changes.
  const usePlane = plane || (!sel && planeHere);
  const harnesses = sel ? sel.split(',') : (plane ? [] : Object.keys(HARNESSES));
  // --profile reads|writes|all applies to every selected harness; without it,
  // plane clients get a writes-only native entry and the rest get everything.
  const profiles = flag('--profile') ? { '*': flag('--profile') } : {};
  const plans = await planRegistration({ vault, embeddings: flag('--embeddings') || 'auto', harnesses, plane: usePlane, profiles });

  console.log(`register starlight-memory  vault: ${vault}  (from ${source})\n`);
  let changes = 0;
  let failed = 0;
  for (const p of plans) {
    const tag = { skip: '·', already: '✓', merge: apply ? '＋' : '→', append: apply ? '＋' : '→', update: apply ? '↻' : '→' }[p.action];
    console.log(`${tag} ${p.target}${p.file ? `  ${p.file}` : ''}`);
    if (p.action === 'skip' || p.action === 'already') { console.log(`    ${p.preview}`); continue; }
    console.log(p.preview.split('\n').map((l) => `    ${l}`).join('\n'));
    if (p.restart) console.log(`    after: ${p.restart}`);
    if (apply) {
      // One config changing under us must not abort the others.
      try { const bak = await p.write(); console.log(`    written; backup ${path.basename(bak)}`); }
      catch (e) { console.log(`    ✖ skipped: ${e.message}`); failed++; continue; }
    }
    changes++;
  }
  if (!apply && changes) console.log(`\nDry run: ${changes} change(s) shown, nothing written. Re-run with --apply.`);
  if (apply && changes) { await writeVaultPointer(vault); console.log(`\nApplied ${changes} change(s). Harness sessions pick the server up on their next start.`); }
  if (!changes) console.log('\nNothing to do.');
}

async function cmdDoctor(rest) {
  const { runDoctor, renderDoctor } = await import('../src/mcp/doctor.mjs');
  const i = rest.indexOf('--vault');
  // doctor must run on a broken install, so it never calls loadConfig — that
  // exits the process when no config exists, which is exactly when you need it.
  const { vault, source } = resolveVault(i >= 0 ? rest[i + 1] : null);
  const report = await runDoctor({ vault, source });
  console.log(renderDoctor(report));
  if (report.checks.some((c) => c.status === 'fail')) process.exit(1);
}

function help() {
  console.log(`starlight-memory — portable memory vault: wiring, sync, and cross-agent MCP

Usage: starlight-memory <command> [--config <path>]

  discover   list this machine's Claude memory dirs (to fill config targets)
  wire       symlink each target's memory dir into the vault (cross-OS, no admin)
  unwire     restore memory dirs to real folders (reverses wire)
  status     show link state + git status
  sync       git pull --rebase, then commit + push any changes [--no-push]
  doctor     check the vault end to end; every failure names its own fix [--vault]
  register   put the MCP server in front of each harness; dry run unless --apply
             [--harness claude-code,codex,cursor,gemini,antigravity,grok] [--plane] [--embeddings auto|on|off]
             [--profile reads|writes|all]  (default: writes-only for plane clients, all for the rest)
  mcp serve  run the memory MCP server over the vault (stdio) [--vault --embeddings --profile]
  help       this text

Vault resolution (all commands): --vault > config in cwd > ~/.starlight/memory/vault.json
(written by wire/register) > $STARLIGHT_MEMORY_VAULT > ~/starlight-memory-vault.

Config (starlight-memory.config.json in the vault root):
  {
    "vault": ".",
    "targets": [
      { "name": "starlight", "agent": "claude-code", "workspace": "<abs workspace path>" }
    ]
  }
Each target may use "workspace" (Claude dir is computed) or an explicit "memoryDir".`);
}

// ---- main ----------------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const cfgFlag = (() => { const i = rest.indexOf('--config'); return i >= 0 ? rest[i + 1] : null; })();

(async () => {
  switch (cmd) {
    case 'doctor': return cmdDoctor(rest);
    case 'discover': return cmdDiscover();
    case 'wire': return cmdWire(await loadConfig(cfgFlag));
    case 'unwire': return cmdUnwire(await loadConfig(cfgFlag));
    case 'status': return cmdStatus(await loadConfig(cfgFlag));
    case 'sync': return cmdSync(await loadConfig(cfgFlag), rest);
    case 'mcp':
      if (rest[0] === 'serve') { await import('../src/mcp/server.mjs'); return; }
      return die('usage: starlight-memory mcp serve [--vault <path>] [--embeddings auto|on|off]');
    case 'register': return cmdRegister(rest);
    case 'init': return cmdRegister(rest);
    case 'help': case undefined: case '--help': case '-h': return help();
    default: die(`unknown command "${cmd}" (try: starlight-memory help)`);
  }
})().catch((e) => die(e.message));
