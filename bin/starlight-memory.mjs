#!/usr/bin/env node
// starlight-memory — portable, zero-dependency CLI to wire an agent's file-based
// memory dirs into a single versioned git vault and sync it across machines.
//
// Cross-OS by construction:
//   - linking uses fs.symlink(type='junction') on Windows (no admin) and 'dir' on POSIX
//   - paths are computed per-machine from a shared, logical-name config
//   - sync is plain git (any remote), no OS scheduler, no gh dependency
//
// Commands: discover | wire | unwire | status | sync | help
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
async function cmdDiscover() {
  const root = path.join(HOME, '.claude', 'projects');
  if (!existsSync(root)) return die(`no Claude projects dir at ${root}`);
  const entries = await fs.readdir(root, { withFileTypes: true });
  console.log('Discovered Claude project memory dirs:\n');
  let n = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const mem = path.join(root, e.name, 'memory');
    if (existsSync(mem)) {
      const kind = await linkKind(mem);
      const files = (await fs.readdir(mem)).filter((f) => f.endsWith('.md')).length;
      console.log(`  ${e.name}\n    memoryDir: ${mem}\n    (${kind}, ${files} md)`);
      n++;
    }
  }
  console.log(`\n${n} memory dir(s). Add the ones you want to your config "targets".`);
}

async function cmdWire(cfg, { repairBroken = false, repointExisting = false } = {}) {
  for (const t of cfg.targets) {
    const memDir = resolveAgentMemDir(t);
    const vaultSub = path.join(cfg.vault, t.name);
    await fs.mkdir(vaultSub, { recursive: true });

    const kind = await linkKind(memDir);
    if (kind === 'link') {
      const tgt = await linkTarget(memDir);
      if (tgt && path.resolve(tgt) === path.resolve(vaultSub)) { ok(`${t.name}: already linked`); continue; }
      if ((repairBroken && tgt && !existsSync(tgt)) || repointExisting) {
        await fs.unlink(memDir);
        info(`${t.name}: removed existing link to ${tgt}; target contents were left untouched`);
      } else {
        die(`${t.name}: ${memDir} is a link to ${tgt}, not the vault. Use --repair-broken for a missing target or --repoint-existing after syncing the old target.`);
      }
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

async function cmdSync(cfg) {
  if (!isGitRepo(cfg.vault)) die(`vault is not a git repo: ${cfg.vault}\n  init it first:  git init && git remote add origin <url> && git push -u origin main`);
  info('pull --rebase --autostash');
  git(cfg.vault, ['pull', '--rebase', '--autostash']);
  git(cfg.vault, ['add', '-A'], { quiet: true });
  const staged = git(cfg.vault, ['diff', '--cached', '--quiet'], { quiet: true });
  if (staged.status === 0) { ok('no local changes'); return; }
  const stamp = new Date().toISOString().slice(0, 16) + 'Z';
  git(cfg.vault, ['commit', '-m', `memory: ${stamp} ${os.hostname()}`], { quiet: true });
  const push = git(cfg.vault, ['push']);
  if (push.status === 0) ok('pushed'); else die('push failed (see git output above)');
}

// harness -> where its MCP config lives + format
const HARNESSES = {
  'claude-code': { path: '~/.claude.json', fmt: 'json', key: 'mcpServers' },
  codex: { path: '~/.codex/config.toml', fmt: 'toml' },
  cursor: { path: '~/.cursor/mcp.json', fmt: 'json', key: 'mcpServers' },
  gemini: { path: '~/.gemini/settings.json', fmt: 'json', key: 'mcpServers' },
  antigravity: { path: '~/.antigravity/mcp.json', fmt: 'json', key: 'mcpServers' },
  grok: { path: '~/.grok/config.toml', fmt: 'toml' },
};

async function cmdInit(cfg, rest) {
  const hi = rest.indexOf('--harness');
  const sel = hi >= 0 ? rest[hi + 1] : 'all';
  const names = sel === 'all' ? Object.keys(HARNESSES) : sel.split(',');
  const binPath = path.resolve(process.argv[1]);
  const jsonBlock = { 'starlight-memory': { command: 'node', args: [binPath, 'mcp', 'serve', '--vault', cfg.vault] } };
  const tomlBlock = `[mcp_servers.starlight-memory]\ncommand = "node"\nargs = ["${binPath.replace(/\\/g, '\\\\')}", "mcp", "serve", "--vault", "${cfg.vault.replace(/\\/g, '\\\\')}"]`;

  const outDir = path.join(cfg.vault, 'mcp-configs');
  await fs.mkdir(outDir, { recursive: true });
  console.log(`Memory MCP config for the shared vault:\n  ${cfg.vault}\n`);
  console.log('Published form (after npm publish):  "command": "npx", "args": ["-y","@starlight-intelligence/memory","mcp","serve","--vault","<vault>"]\n');
  for (const n of names) {
    const h = HARNESSES[n];
    if (!h) { console.log(`  ? unknown harness "${n}"`); continue; }
    const snippet = h.fmt === 'toml' ? tomlBlock : JSON.stringify({ [h.key]: jsonBlock }, null, 2);
    const file = path.join(outDir, `${n}.${h.fmt === 'toml' ? 'toml' : 'json'}`);
    await fs.writeFile(file, snippet + '\n', 'utf8');
    console.log(`▸ ${n}  →  merge into ${h.path}   (wrote ${path.relative(cfg.vault, file)})`);
  }
  console.log(`\nApplying these edits harness configs is a self-modifying action — apply manually or approve it explicitly (auto-mode blocks it).`);
}

async function cmdExportCloud(cfg, rest) {
  const value = (flag) => {
    const index = rest.indexOf(flag);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const sourceVault = value('--vault') || cfg?.vault;
  const outputVault = value('--out');
  if (!sourceVault || !outputVault) die('usage: starlight-memory mcp export-cloud --vault <canonical-vault> --out <projection-vault> [--tenant <tenant>]');
  const { exportCloudProjection } = await import('../src/mcp/cloud-projection.mjs');
  const signingKeyEnv = value('--signing-key-env') || 'STARLIGHT_MEMORY_PROJECTION_SIGNING_KEY';
  const signingKey = process.env[signingKeyEnv];
  if (!signingKey) die(`${signingKeyEnv} must contain the Ed25519 PEM private key used to sign cloud projections`);
  const result = await exportCloudProjection({
    sourceVault,
    outputVault,
    tenant: value('--tenant') || 'frank',
    allowPrivateShareable: rest.includes('--allow-private-shareable'),
    signingKey,
  });
  ok(`cloud projection ${result.projection_id.slice(0, 12)}: ${result.projected_records}/${result.source_records} records exported to ${result.output_vault}`);
  info(`${result.excluded_records} records excluded by privacy policy (public only unless --allow-private-shareable is explicitly set).`);
}

function help() {
  console.log(`starlight-memory — portable memory vault: wiring, sync, and cross-agent MCP

Usage: starlight-memory <command> [--config <path>]

  discover   list this machine's Claude memory dirs (to fill config targets)
  wire       symlink each target's memory dir into the vault (cross-OS, no admin)
             add --repair-broken to replace only links whose targets do not exist
             add --repoint-existing to retarget links after the old vault is synced
  unwire     restore memory dirs to real folders (reverses wire)
  status     show link state + git status
  sync       git pull --rebase, then commit + push any changes
  mcp serve  run the full local memory MCP server over the vault (stdio) [--vault --embeddings]
  mcp gateway  run the authenticated read-only Streamable HTTP MCP gateway [--vault --host --port --token-env]
  mcp export-cloud  build a privacy-filtered, summary-only projection for the cloud gateway [--vault --out]
  init       emit MCP config snippets per harness [--harness all|claude-code,codex,...]
  help       this text

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
const repairBroken = rest.includes('--repair-broken');
const repointExisting = rest.includes('--repoint-existing');

(async () => {
  switch (cmd) {
    case 'discover': return cmdDiscover();
    case 'wire': return cmdWire(await loadConfig(cfgFlag), { repairBroken, repointExisting });
    case 'unwire': return cmdUnwire(await loadConfig(cfgFlag));
    case 'status': return cmdStatus(await loadConfig(cfgFlag));
    case 'sync': return cmdSync(await loadConfig(cfgFlag));
    case 'mcp':
      if (rest[0] === 'serve') { await import('../src/mcp/server.mjs'); return; }
      if (rest[0] === 'gateway') { const { main } = await import('../src/mcp/cloud-gateway.mjs'); await main(); return; }
      if (rest[0] === 'export-cloud') { await cmdExportCloud(null, rest.slice(1)); return; }
      return die('usage: starlight-memory mcp <serve|gateway|export-cloud> [--vault <path>]');
    case 'init': return cmdInit(await loadConfig(cfgFlag), rest);
    case 'help': case undefined: case '--help': case '-h': return help();
    default: die(`unknown command "${cmd}" (try: starlight-memory help)`);
  }
})().catch((e) => die(e.message));
