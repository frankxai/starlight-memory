import Database from "better-sqlite3";
import { DEFAULT_PROVIDER_CAPABILITIES } from "./resources.js";
import type {
  ForgetRequest,
  MemoryProvider,
  ProviderCapabilities,
  RecallRequest,
  RecallResult,
  SISMemoryRecord,
} from "./types.js";

export interface PersistentLocalCoreOptions {
  dbPath: string;
  maxRecordsPerTenant?: number;
}

export class PersistentLocalCoreProvider implements MemoryProvider {
  readonly name = "local_core";
  readonly capabilities: ProviderCapabilities = DEFAULT_PROVIDER_CAPABILITIES.local_core;
  private readonly db: Database.Database;
  private readonly maxRecordsPerTenant: number;

  constructor(options: PersistentLocalCoreOptions) {
    this.db = new Database(options.dbPath);
    this.maxRecordsPerTenant = options.maxRecordsPerTenant ?? 50_000;
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        memory_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tenant ON records(tenant_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
        memory_id UNINDEXED,
        tenant_id UNINDEXED,
        content,
        tokenize='porter'
      );
    `);
  }

  async remember(record: SISMemoryRecord): Promise<SISMemoryRecord> {
    const countRow = this.db.prepare("SELECT COUNT(*) as c FROM records WHERE tenant_id = ?").get(record.tenant_id) as { c: number };
    const count = countRow.c;
    if (count >= this.maxRecordsPerTenant) {
      // Simple eviction of oldest
      this.db.prepare("DELETE FROM records WHERE tenant_id = ? ORDER BY created_at ASC LIMIT 1").run(record.tenant_id);
    }

    const json = JSON.stringify(record);
    this.db.prepare(`
      INSERT OR REPLACE INTO records (memory_id, tenant_id, record_json)
      VALUES (?, ?, ?)
    `).run(record.memory_id, record.tenant_id, json);

    // FTS update
    this.db.prepare(`
      INSERT OR REPLACE INTO records_fts (memory_id, tenant_id, content)
      VALUES (?, ?, ?)
    `).run(record.memory_id, record.tenant_id, this.buildFtsContent(record));

    return record;
  }

  async recall(request: RecallRequest): Promise<RecallResult[]> {
    const limit = Math.max(1, request.limit ?? 10);
    const minScore = request.min_score ?? 0;
    const queryTerms = this.tokenize(request.query);

    const rows = this.db.prepare(`
      SELECT r.record_json
      FROM records r
      JOIN records_fts f ON r.memory_id = f.memory_id
      WHERE r.tenant_id = ? AND f.content MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(request.tenant_id, queryTerms.join(" "), limit * 2); // over-fetch for scoring

    const results: RecallResult[] = rows
      .map((row: any) => {
        const rec: SISMemoryRecord = JSON.parse(row.record_json);
        const scoreRes = this.scoreRecord(rec, queryTerms);
        return scoreRes;
      })
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score || b.record.importance - a.record.importance)
      .slice(0, limit);

    return results;
  }

  async forget(request: ForgetRequest): Promise<boolean> {
    const info = this.db.prepare("DELETE FROM records WHERE memory_id = ? AND tenant_id = ?").run(request.memory_id, request.tenant_id);
    this.db.prepare("DELETE FROM records_fts WHERE memory_id = ?").run(request.memory_id);
    return info.changes > 0;
  }

  private buildFtsContent(record: SISMemoryRecord): string {
    return [
      record.normalized_fact,
      record.summary,
      record.raw_content,
      record.vault,
      record.memory_type,
      ...record.entities.map(e => e.name),
      ...record.relations.flatMap(r => [r.subject, r.predicate, r.object]),
    ].filter(Boolean).join(" ");
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(t => t.length > 2);
  }

  private scoreRecord(record: SISMemoryRecord, queryTerms: string[]): RecallResult {
    const haystack = this.buildFtsContent(record);
    const haystackTerms = new Set(this.tokenize(haystack));
    const matched = queryTerms.filter((term) => haystackTerms.has(term));
    const lexical = queryTerms.length === 0 ? 0 : matched.length / queryTerms.length;
    const weighted = lexical * 0.7 + record.importance * 0.15 + record.confidence * 0.1 + record.trust * 0.05;
    return { record, score: Number(weighted.toFixed(6)), matched_terms: matched };
  }
}
