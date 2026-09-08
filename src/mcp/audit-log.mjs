// audit-log — append-only record of every read and write against the vault.
//
// What this guarantees, precisely:
//   - Every event carries {pid, seq}. seq is monotonic per process, so a gap in
//     a pid's sequence is detectable evidence that a line was lost.
//   - An append that fails is counted and reported on the NEXT successful line
//     as `dropped_before`, and to stderr immediately. audit() resolves to a
//     status object, so a caller that cares can check it.
//
// What it does NOT guarantee, and must not be sold as:
//   - Tamper-evidence. This is a plain mode-default file. Any process with
//     filesystem access can rewrite it. There is no hash chain yet.
//   - Cross-process ordering. stdio MCP servers are spawned per client, so N
//     harnesses append to one path from N processes. Line atomicity rests on
//     O_APPEND, not on this code.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { MEMORY_HOME } from './home.mjs';

const AUDIT_DIR = MEMORY_HOME;
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.jsonl');
// auditSummary must not read an unbounded file into memory. Past this, only the
// tail is parsed and the summary says so.
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** Queries can carry secrets. Log a stable fingerprint, never the text. */
function fingerprint(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 12);
}

const PID = process.pid;
let seq = 0;
let dropped = 0;
let queue = Promise.resolve();

/**
 * Appends one event. Serialized within this process so concurrent tool calls
 * cannot interleave partial lines. Resolves to {written, seq, dropped} — it
 * never throws, because a memory operation must not fail on a logging fault.
 */
export function audit(event, fields = {}) {
  const mine = ++seq;
  queue = queue.then(async () => {
    const entry = {
      at: new Date().toISOString(),
      pid: PID,
      seq: mine,
      event,
      ...fields,
    };
    if (dropped) entry.dropped_before = dropped;
    try {
      await fs.mkdir(AUDIT_DIR, { recursive: true });
      await fs.appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8');
      dropped = 0;
      return { written: true, seq: mine, dropped: 0 };
    } catch (e) {
      dropped++;
      // Loud, because a silently incomplete privacy log is worse than no log.
      console.error(`[starlight-memory] AUDIT WRITE FAILED (${dropped} pending) ${event}: ${e.message}`);
      return { written: false, seq: mine, dropped };
    }
  });
  return queue;
}

export const auditPath = AUDIT_FILE;

export function auditRecall({ query, tenant, hits, surfaced }) {
  return audit('recall', {
    tenant,
    query_fp: fingerprint(query),
    hits,
    // Which privacy classes actually crossed into the model's context.
    surfaced,
  });
}

export function auditWrite({ memory_id, tenant, privacy_class, vault, memory_type }) {
  return audit('remember', { memory_id, tenant, privacy_class, vault, memory_type });
}

export function auditForget({ memory_id, tenant, privacy_class, ok }) {
  return audit('forget', { memory_id, tenant, privacy_class, ok });
}

/** A record deliberately withheld from an external provider, and which one. */
export function auditWithheld({ memory_id, tenant, privacy_class, provider }) {
  return audit('mirror_withheld', { memory_id, tenant, privacy_class, provider });
}

async function readTail() {
  let handle;
  try {
    handle = await fs.open(AUDIT_FILE, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_SCAN_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // A partial first line after seeking mid-file is not an event.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: start > 0, size };
  } catch {
    return { text: '', truncated: false, size: 0 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readAudit(limit = 100) {
  const { text } = await readTail();
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return { at: null, event: 'unparseable', raw: l }; }
  });
}

export async function auditSummary() {
  const { text, truncated, size } = await readTail();
  const rows = text.split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { event: 'unparseable' }; }
  });

  const byEvent = {};
  const byPrivacy = {};
  // A gap in any pid's sequence means a line was lost or the file was edited.
  const seqByPid = new Map();
  let gaps = 0;
  let declaredDrops = 0;

  for (const r of rows) {
    byEvent[r.event] = (byEvent[r.event] || 0) + 1;
    if (r.privacy_class) byPrivacy[r.privacy_class] = (byPrivacy[r.privacy_class] || 0) + 1;
    if (r.dropped_before) declaredDrops += r.dropped_before;
    if (typeof r.pid === 'number' && typeof r.seq === 'number') {
      const prev = seqByPid.get(r.pid);
      if (prev !== undefined && r.seq !== prev + 1) gaps++;
      seqByPid.set(r.pid, r.seq);
    }
  }

  return {
    path: AUDIT_FILE,
    bytes: size,
    events: rows.length,
    scanned: truncated ? `tail ${MAX_SCAN_BYTES} bytes only` : 'whole file',
    first: rows[0]?.at ?? null,
    last: rows[rows.length - 1]?.at ?? null,
    by_event: byEvent,
    by_privacy_class: byPrivacy,
    // Non-zero means this log is not complete. Do not read it as one.
    sequence_gaps: truncated ? null : gaps,
    events_declared_lost: declaredDrops,
    tamper_evident: false,
  };
}
