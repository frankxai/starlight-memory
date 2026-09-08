// register — put the memory server in front of every harness on this machine.
//
// Two shapes, because a per-session stdio child is the wrong shape for a
// server that loads an embedding model: N harness sessions = N models in RAM.
//   native : an mcpServers entry (or [mcp_servers.*] TOML table) per harness.
//   plane  : one backend block in the shared tool plane's policy, so every
//            harness that already talks to the plane gets one pooled process.
// Nothing is written without {apply:true}; every write leaves a timestamped
// backup beside the file it changed.
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const SERVER_NAME = 'starlight-memory';
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'starlight-memory.mjs');

export const HARNESSES = {
  'claude-code': { name: 'Claude Code', file: path.join(HOME, '.claude.json'), fmt: 'json', key: 'mcpServers' },
  codex: { name: 'Codex', file: path.join(HOME, '.codex', 'config.toml'), fmt: 'toml', table: 'mcp_servers' },
  cursor: { name: 'Cursor', file: path.join(HOME, '.cursor', 'mcp.json'), fmt: 'json', key: 'mcpServers' },
  gemini: { name: 'Gemini', file: path.join(HOME, '.gemini', 'settings.json'), fmt: 'json', key: 'mcpServers' },
  antigravity: { name: 'Antigravity', file: path.join(HOME, '.antigravity', 'mcp.json'), fmt: 'json', key: 'mcpServers' },
  grok: { name: 'Grok', file: path.join(HOME, '.grok', 'config.toml'), fmt: 'toml', table: 'mcp_servers' },
};

export const PLANE = {
  name: 'Shared tool plane',
  root: path.join(HOME, '.starlight', 'tool-plane'),
  activeRelease: path.join(HOME, '.starlight', 'tool-plane', 'active-release.json'),
  status: path.join(HOME, '.starlight', 'tool-plane', 'status.json'),
};

// What the plane may call. Reads only: the plane (release 2.0.0) stamps
// readOnlyHint:true on every tool it exposes regardless of backend policy, so
// a vault-deleting memory_forget would reach every harness tagged as safe and
// skip approval gating. Writes go through a native registration, where the
// server's own annotations are honoured. code_* tools stay off too: they index
// relative to the server cwd, not the caller's workspace.
const PLANE_ALLOW = ['memory_recall', 'memory_search', 'vault_read', 'vault_list', 'memory_stats', 'memory_audit'];

// Harnesses that already talk to the plane get reads there; their native
// entry only carries the audited writes and loads no model. The rest get the
// whole server natively.
export const PLANE_CLIENTS = new Set(['claude-code', 'codex']);
export function defaultProfile(harness, planeHere) { return planeHere && PLANE_CLIENTS.has(harness) ? 'writes' : 'all'; }

function serverArgs(vault, embeddings, profile) { return [BIN, 'mcp', 'serve', '--vault', vault, '--embeddings', embeddings, '--profile', profile]; }

export function nativeEntry({ vault, embeddings = 'auto', profile = 'all' }) {
  return { command: 'node', args: serverArgs(vault, embeddings, profile) };
}
function profileOfArgs(args) {
  const i = Array.isArray(args) ? args.indexOf('--profile') : -1;
  return i >= 0 && args[i + 1] ? args[i + 1] : 'all';
}

export function planeBackend({ vault, embeddings = 'auto' }) {
  return {
    id: SERVER_NAME,
    kind: 'stdio',
    singleton: true,
    command: 'node',
    script: BIN,
    args: ['mcp', 'serve', '--vault', vault, '--embeddings', embeddings],
    namespace: 'memory',
    policy: 'read-only',
    toolTimeoutMs: 120000,
    timeoutRationale: 'First recall after an idle shutdown reloads the embedding model from disk (~10-40s on this laptop); later calls are sub-second.',
    allowTools: PLANE_ALLOW,
    rationale: 'One vault, one index, one embedding model for every harness on the machine. Reads only: the plane marks every exposed tool readOnlyHint:true, so memory_remember/memory_forget would bypass approval gating if admitted here; writes use a native per-harness registration. code_* tools stay off the plane: they index relative to the server cwd, which is not the caller’s workspace.',
  };
}

async function planePolicyPath() {
  if (!existsSync(PLANE.activeRelease)) return null;
  try {
    const rel = JSON.parse(await fs.readFile(PLANE.activeRelease, 'utf8'));
    const p = path.join(rel.releaseRoot, 'ops', 'shared-tool-plane.policy.json');
    return existsSync(p) ? p : null;
  } catch { return null; }
}

const stripBom = (t) => t.replace(/^﻿/, '');

function tomlHasTable(text, table) {
  return new RegExp(`^\\[${table.replace('.', '\\.')}\\.${SERVER_NAME}\\]`, 'm').test(text);
}
function tomlBlock(table, entry) {
  const q = (s) => JSON.stringify(s);
  return `\n[${table}.${SERVER_NAME}]\ncommand = ${q(entry.command)}\nargs = [${entry.args.map(q).join(', ')}]\n`;
}
// The table runs from its header to the next line that opens another table.
// `[^\[]*` is wrong here: the args array itself opens with `[`, and cutting
// there once left an orphaned args line in a real config.
// A boundary is any `[...]` header line; a character class that forgot digits
// once made `[mcp_servers.v0]` part of our table and deleted it.
function tomlTableRe(table) {
  return new RegExp(`\\n?^\\[${table.replace('.', '\\.')}\\.${SERVER_NAME}\\]\\n(?:(?!\\[{1,2}[^\\]\\r\\n]+\\]{1,2}\\s*$).*(?:\\n|$))*`, 'm');
}
function vaultOfArgs(args) {
  const i = Array.isArray(args) ? args.indexOf('--vault') : -1;
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : null;
}
function tomlArgs(text, table) {
  const block = tomlTableRe(table).exec(text)?.[0] || '';
  const m = /^args\s*=\s*\[([^\]]*)\]/m.exec(block);
  if (!m) return null;
  try { return m[1].split(',').map((s) => JSON.parse(s.trim())); } catch { return null; }
}
function tomlVault(text, table) { return vaultOfArgs(tomlArgs(text, table)); }
function tomlProfile(text, table) { return profileOfArgs(tomlArgs(text, table)); }

/**
 * Per-harness: does the config exist, is the server in it, does its baked
 * --vault still match the canonical vault, and (plane) is it actually served.
 * A registration that names a vault other than the current one is the exact
 * five-week divergence the pointer file exists to end, so it is reported.
 */
export async function registrationState({ vault } = {}) {
  const canonical = vault ? path.resolve(vault) : null;
  const out = [];
  for (const [id, h] of Object.entries(HARNESSES)) {
    const row = { id, name: h.name, file: h.file, exists: existsSync(h.file), registered: false, vault: null, vaultMismatch: false };
    if (row.exists) {
      try {
        const text = await fs.readFile(h.file, 'utf8');
        if (h.fmt === 'toml') { row.registered = tomlHasTable(text, h.table); if (row.registered) { row.vault = tomlVault(text, h.table); row.profile = tomlProfile(text, h.table); } }
        else { const entry = (JSON.parse(text)[h.key] || {})[SERVER_NAME]; row.registered = Boolean(entry); if (entry) { row.vault = vaultOfArgs(entry.args); row.profile = profileOfArgs(entry.args); } }
      } catch { row.unreadable = true; }
    }
    row.vaultMismatch = Boolean(row.registered && canonical && row.vault && row.vault !== canonical);
    out.push(row);
  }
  const policy = await planePolicyPath();
  const plane = { id: 'plane', name: PLANE.name, file: policy, exists: Boolean(policy), registered: false, needsRestart: false, vault: null, vaultMismatch: false };
  if (policy) {
    try {
      const pol = JSON.parse(stripBom(await fs.readFile(policy, 'utf8')));
      const b = (pol.backends || []).find((x) => x.id === SERVER_NAME);
      plane.registered = Boolean(b);
      if (b) plane.vault = vaultOfArgs(b.args);
      plane.vaultMismatch = Boolean(b && canonical && plane.vault && plane.vault !== canonical);
      if (plane.registered && existsSync(PLANE.status)) {
        const st = JSON.parse(await fs.readFile(PLANE.status, 'utf8'));
        plane.needsRestart = !(st.backends || []).some((x) => x.id === SERVER_NAME);
      }
    } catch { plane.unreadable = true; }
  }
  out.push(plane);
  return out;
}

/**
 * Computes every edit. Each plan item is {target, file, action, preview, write}
 * where write() performs it. Callers print previews on a dry run and call
 * write() on --apply, so what is shown is exactly what lands. An existing
 * registration that names a different vault, or a different tool list on the
 * plane, is an 'update', never an 'already'.
 */
export async function planRegistration({ vault, embeddings = 'auto', harnesses = [], plane = false, profiles = {} }) {
  const plans = [];
  const canonical = path.resolve(vault);
  const planeHere = existsSync(PLANE.activeRelease);
  for (const id of harnesses) {
    const h = HARNESSES[id];
    if (!h) { plans.push({ target: id, action: 'skip', preview: `unknown harness "${id}" (known: ${Object.keys(HARNESSES).join(', ')})` }); continue; }
    if (!existsSync(h.file)) { plans.push({ target: h.name, file: h.file, action: 'skip', preview: 'config file not present on this machine' }); continue; }
    const profile = profiles[id] || profiles['*'] || defaultProfile(id, planeHere);
    const entry = nativeEntry({ vault, embeddings, profile });
    const target = `${h.name} (${profile})`;
    const text = await fs.readFile(h.file, 'utf8');
    if (h.fmt === 'toml') {
      const block = tomlBlock(h.table, entry);
      if (tomlHasTable(text, h.table)) {
        const cur = tomlVault(text, h.table);
        const curProfile = tomlProfile(text, h.table);
        if (cur === canonical && curProfile === profile) { plans.push({ target, file: h.file, action: 'already', preview: `[${h.table}.${SERVER_NAME}] present, same vault and profile` }); continue; }
        plans.push({ target, file: h.file, action: 'update', preview: `(registered: vault ${cur}, profile ${curProfile})\n${block.trim()}`, write: () => writeWithBackup(h.file, text.replace(tomlTableRe(h.table), '\n').replace(/\s*$/, '\n') + block, text) });
        continue;
      }
      plans.push({ target, file: h.file, action: 'append', preview: block.trim(), write: () => writeWithBackup(h.file, text.replace(/\s*$/, '\n') + block, text) });
      continue;
    }
    let json;
    try { json = JSON.parse(text); } catch (e) { plans.push({ target, file: h.file, action: 'skip', preview: `not valid JSON (${e.message}); not touching it` }); continue; }
    const servers = json[h.key] || {};
    const existing = servers[SERVER_NAME];
    const next = { ...json, [h.key]: { ...servers, [SERVER_NAME]: entry } };
    const write = () => writeWithBackup(h.file, JSON.stringify(next, null, 2) + '\n', text);
    const preview = JSON.stringify({ [h.key]: { [SERVER_NAME]: entry } }, null, 2);
    if (existing && vaultOfArgs(existing.args) === canonical && profileOfArgs(existing.args) === profile) { plans.push({ target, file: h.file, action: 'already', preview: `${h.key}.${SERVER_NAME} present, same vault and profile` }); continue; }
    if (existing) { plans.push({ target, file: h.file, action: 'update', preview: `(registered: vault ${vaultOfArgs(existing.args)}, profile ${profileOfArgs(existing.args)})\n${preview}`, write }); continue; }
    plans.push({ target, file: h.file, action: 'merge', preview, write });
  }
  if (plane) {
    const policy = await planePolicyPath();
    if (!policy) plans.push({ target: PLANE.name, action: 'skip', preview: `no active release under ${PLANE.root}` });
    else {
      const raw = await fs.readFile(policy, 'utf8');
      const pol = JSON.parse(stripBom(raw));
      const backend = planeBackend({ vault, embeddings });
      const cur = (pol.backends || []).find((b) => b.id === SERVER_NAME);
      const same = cur && vaultOfArgs(cur.args) === canonical && JSON.stringify(cur.allowTools) === JSON.stringify(backend.allowTools);
      if (same) plans.push({ target: PLANE.name, file: policy, action: 'already', preview: `backend "${SERVER_NAME}" present, same vault and tool list` });
      else {
        const next = { ...pol, backends: [...pol.backends.filter((b) => b.id !== SERVER_NAME), backend] };
        plans.push({ target: PLANE.name, file: policy, action: cur ? 'update' : 'merge', preview: JSON.stringify(backend, null, 2), restart: 'the plane loads its policy once at start; restart it (~/.starlight/tool-plane/run-plane.cmd) to serve the backend', write: () => writeWithBackup(policy, JSON.stringify(next, null, 2) + '\n', raw) });
      }
    }
  }
  return plans;
}

/**
 * `expect` is the file's content as read when the plan was computed. These
 * configs are rewritten by live harness sessions (~/.claude.json is 100KB and
 * every running Claude Code writes it), so a plan built minutes earlier can
 * silently discard someone else's change. Re-read and refuse on a mismatch;
 * the backup would make that recoverable, not noticed.
 */
async function writeWithBackup(file, content, expect) {
  if (expect !== undefined) {
    const now = await fs.readFile(file, 'utf8').catch(() => null);
    if (now !== expect) throw new Error(`${file} changed since this plan was computed (a live session probably rewrote it). Nothing written — re-run register to plan against the current file.`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${file}.bak-${stamp}`;
  await fs.copyFile(file, bak);
  await fs.writeFile(file, content, 'utf8');
  return bak;
}
