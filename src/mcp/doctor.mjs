// doctor — every question a user would otherwise have to ask a human.
// Each check states what it found and, on failure, the exact command that
// fixes it. A check that reports a problem without a fix is not finished.
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadVault } from './vault-store.mjs';
import { auditSummary } from './audit-log.mjs';
import { EMB_CACHE } from './hybrid-index.mjs';
import { registrationState } from './register.mjs';

const PRIVACY = ['public', 'private-shareable', 'private', 'secret', 'regulated'];
const VAULTS = ['strategic', 'technical', 'creative', 'operational', 'wisdom', 'horizon'];

const PASS = 'pass', WARN = 'warn', FAIL = 'fail';

function r(status, label, detail, fix) {
  return { status, label, detail, fix };
}

/** Counts .md files whose frontmatter the loader will silently skip. */
async function scanRaw(root) {
  const seen = { files: 0, withFrontmatter: 0, skipped: [] };
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      seen.files++;
      const text = await fs.readFile(p, 'utf8').catch(() => '');
      if (/^---\r?\n/.test(text)) seen.withFrontmatter++;
      else seen.skipped.push(path.relative(root, p));
    }
  }
  await walk(root);
  return seen;
}

export async function runDoctor(cfg) {
  const checks = [];
  const vault = cfg.vault || cfg.vaultRoot;

  // ── vault reachable ─────────────────────────────────────
  if (!vault || !existsSync(vault)) {
    checks.push(r(FAIL, 'Vault', `not found at ${vault || '(unset)'}${cfg.source ? ` (resolved from ${cfg.source})` : ''}`,
      `Create it: mkdir <path> && git -C <path> init, add a starlight-memory.config.json (see starlight-memory help), then run starlight-memory wire from inside it — wire records the path so every command finds it.`));
    return { checks, vault };
  }
  checks.push(r(PASS, 'Vault', cfg.source ? `${vault}  (from ${cfg.source})` : vault));

  // A second checkout of the same vault remote on this machine is how the
  // server ended up indexing a frozen copy while the junctions fed another.
  const legacy = path.join(os.homedir(), 'starlight-memory-vault');
  if (existsSync(legacy) && path.resolve(legacy) !== path.resolve(vault)) {
    checks.push(r(WARN, 'Second vault', `${legacy} also exists and is NOT the canonical vault; anything written there is invisible here`,
      `Move any atoms you want out of it into ${vault}, then remove it. Every entry point now resolves the vault through the pointer written by wire/register.`));
  }

  // ── atoms parse ─────────────────────────────────────────
  const raw = await scanRaw(vault);
  const records = await loadVault(vault, cfg.tenant || 'frank');
  if (raw.skipped.length) {
    const shown = raw.skipped.slice(0, 4).join(', ');
    checks.push(r(PASS, 'Atom parsing',
      `${records.length} atoms; ${raw.skipped.length} have no frontmatter and index with defaults (private, summary from first heading): ${shown}${raw.skipped.length > 4 ? ', …' : ''}`));
  } else {
    checks.push(r(PASS, 'Atom parsing', `${records.length} atoms, all parsed`));
  }

  // ── duplicate ids ───────────────────────────────────────
  // ids are slug+random, so a collision means one atom shadows another in
  // byId() lookups and forget() would delete the wrong file.
  const byId = new Map();
  for (const rec of records) {
    if (!byId.has(rec.memory_id)) byId.set(rec.memory_id, []);
    byId.get(rec.memory_id).push(rec._path);
  }
  const dupes = [...byId.entries()].filter(([, paths]) => paths.length > 1);
  const pathIds = records.filter((rec) => rec._id_from_path);
  const declared = [...new Set(pathIds.filter((rec) => rec._explicit_id).map((rec) => rec._declared_id))];
  if (dupes.length) {
    checks.push(r(FAIL, 'Unique ids', `${dupes.length} id(s) still collide after path disambiguation: ${dupes.slice(0, 3).map(([id]) => id).join(', ')}`,
      `Two files at the same vault path cannot both exist; this is a loader bug — report it with the paths above.`));
  } else if (declared.length) {
    checks.push(r(WARN, 'Unique ids', `${byId.size} distinct ids; ${declared.length} frontmatter id(s) are declared in more than one file and are keyed by path instead: ${declared.slice(0, 3).join(', ')}`,
      `Both copies are reachable (as <folder>/<file>), so nothing is shadowed. Path ids hold only while the collision exists: forget one copy and the survivor answers to its declared id again.`));
  } else {
    checks.push(r(PASS, 'Unique ids', `${byId.size} distinct ids${pathIds.length ? ` (${pathIds.length} same-named files keyed by their vault path, e.g. ${pathIds[0].memory_id})` : ''}`));
  }

  // ── privacy classes valid ───────────────────────────────
  const privacyCounts = {};
  const badPrivacy = [];
  for (const rec of records) {
    const c = rec.privacy_class || '(unset)';
    privacyCounts[c] = (privacyCounts[c] || 0) + 1;
    if (!PRIVACY.includes(rec.privacy_class)) badPrivacy.push(rec.memory_id);
  }
  checks.push(badPrivacy.length
    ? r(FAIL, 'Privacy classes',
        `${badPrivacy.length} atom(s) carry an unrecognised privacy_class: ${badPrivacy.slice(0, 3).join(', ')}`,
        `Set privacy_class to one of ${PRIVACY.join(' | ')}. An unrecognised class is not treated as restrictive — these atoms are not protected.`)
    : r(PASS, 'Privacy classes', Object.entries(privacyCounts).map(([k, v]) => `${k}:${v}`).join('  ') || 'none yet'));

  const badVault = records.filter((rec) => rec.vault && !VAULTS.includes(rec.vault));
  if (badVault.length) {
    checks.push(r(WARN, 'Vault names', `${badVault.length} atom(s) use a vault outside the canonical six`,
      `Canonical vaults: ${VAULTS.join(', ')}. Non-canonical names still index but will not group.`));
  }

  // ── embeddings ──────────────────────────────────────────
  let embedderAvailable = false;
  try { await import('@huggingface/transformers'); embedderAvailable = true; } catch { /* optional dep */ }
  if (!embedderAvailable) {
    checks.push(r(WARN, 'Semantic recall', 'off — @huggingface/transformers is not installed, so recall is BM25 keyword-only',
      `npm i @huggingface/transformers    (adds local on-device embeddings; no API key, nothing leaves the machine)`));
  } else {
    // The cache is an append-only log: count atoms with a cached key, not
    // lines, or dead rewrites inflate coverage to a false 100%.
    const cachedIds = new Set();
    let corrupt = 0, lines = 0;
    if (existsSync(EMB_CACHE)) {
      const text = await fs.readFile(EMB_CACHE, 'utf8').catch(() => '');
      for (const l of text.split(/\r?\n/).filter(Boolean)) {
        lines++;
        try { cachedIds.add(JSON.parse(l).k.split(':')[0]); } catch { corrupt++; }
      }
    }
    const covered = records.filter((rec) => cachedIds.has(rec.memory_id)).length;
    const coverage = records.length ? Math.round((covered / records.length) * 100) : 100;
    const corruptNote = corrupt ? `; ${corrupt} unparseable line(s), dropped at the next compaction` : '';
    checks.push(coverage >= 90
      ? r(PASS, 'Semantic recall', `on — ${covered}/${records.length} atoms have a cached vector (${lines} lines${corruptNote})`)
      : r(WARN, 'Semantic recall', `on, but only ${coverage}% of atoms have a cached vector (${covered}/${records.length}${corruptNote})`,
          `Start the server once and run any recall; missing vectors are embedded and cached on first build.`));
  }

  // ── audit log ───────────────────────────────────────────
  const audit = await auditSummary();
  checks.push(audit.events
    ? r(PASS, 'Audit log', `${audit.events} events, last ${audit.last} — ${audit.path}`)
    : r(WARN, 'Audit log', 'empty — no reads or writes recorded yet',
        `Expected on a fresh install. If the vault has atoms but the log is empty, they were written outside the MCP server and were never audited.`));

  // ── harness wiring ──────────────────────────────────────
  const reg = await registrationState({ vault });
  const wired = reg.filter((h) => h.registered).map((h) => h.name);
  const present = reg.filter((h) => h.exists && !h.registered).map((h) => h.name);
  const pending = reg.filter((h) => h.registered && h.needsRestart).map((h) => h.name);
  const mismatched = reg.filter((h) => h.vaultMismatch);
  if (mismatched.length) {
    checks.push(r(FAIL, 'Harness wiring', `${mismatched.map((h) => `${h.name} serves ${h.vault}`).join('; ')} — not the canonical vault`,
      `starlight-memory register --apply      (rewrites each registration to the canonical vault; until then that server keeps serving the old path)`));
  } else if (!wired.length) {
    checks.push(r(WARN, 'Harness wiring', `not registered anywhere; configs found for: ${present.join(', ') || 'none'}`,
      `starlight-memory register --apply      (dry run without --apply; --plane targets the shared tool plane)`));
  } else if (pending.length) {
    checks.push(r(WARN, 'Harness wiring', `registered in: ${wired.join(', ')} — ${pending.join(', ')} loads its policy at start and has not restarted since`,
      `Restart the shared tool plane (its launcher is ~/.starlight/tool-plane/run-plane.cmd) so the backend is actually served.`));
  } else {
    checks.push(r(PASS, 'Harness wiring', `registered in: ${wired.join(', ')}${present.length ? `  (not in: ${present.join(', ')})` : ''}`));
  }

  return { checks, vault, atoms: records.length };
}

export function renderDoctor({ checks, atoms }) {
  const icon = { pass: '✓', warn: '!', fail: '✖' };
  const lines = checks.map((c) => {
    const head = `${icon[c.status]} ${c.label.padEnd(16)} ${c.detail}`;
    return c.fix && c.status !== PASS ? `${head}\n      fix: ${c.fix}` : head;
  });
  const failed = checks.filter((c) => c.status === FAIL).length;
  const warned = checks.filter((c) => c.status === WARN).length;
  const verdict = failed ? `${failed} failing, ${warned} warning`
    : warned ? `healthy with ${warned} warning${warned > 1 ? 's' : ''}`
    : 'healthy';
  return `${lines.join('\n')}\n\n${verdict}${atoms !== undefined ? ` · ${atoms} atoms` : ''}`;
}
