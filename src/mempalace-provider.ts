import { DEFAULT_PROVIDER_CAPABILITIES } from "./resources.js";
import type {
  ForgetRequest,
  MemoryProvider,
  ProviderCapabilities,
  RecallRequest,
  RecallResult,
  SISMemoryRecord,
} from "./types.js";

/**
 * MemPalace (github.com/MemPalace/mempalace, MIT) is a local, verbatim-first
 * store: wings (tenant/project) → rooms (topic) → drawers (verbatim text), with
 * a pluggable vector backend (Chroma by default). It answers "what was said".
 *
 * This adapter is client-injected: the caller wraps ONE MemPalace MCP server per
 * machine and hands it in, so every coding agent fans in through the SIS gateway
 * instead of each harness hook spawning its own palace writer.
 */
export interface MemPalaceDrawer {
  id: string;
  content: string;
  score?: number;
  wing?: string;
  room?: string;
  metadata?: Record<string, unknown>;
}

export interface MemPalaceClient {
  addDrawer(input: { wing: string; room: string; content: string; metadata: Record<string, unknown> }): Promise<{ id: string }>;
  search(input: { query: string; wing?: string; room?: string; limit: number }): Promise<MemPalaceDrawer[]>;
  deleteDrawer(input: { id: string }): Promise<boolean>;
}

export interface MemPalaceProviderOptions {
  client: MemPalaceClient;
  flush_batch_size?: number;
  /** Send raw_content when present. MemPalace is local, so verbatim is the point; secret stays blocked. */
  verbatim?: boolean;
  allow_regulated_local_mirror?: boolean;
}

interface PendingDrawer {
  record: SISMemoryRecord;
  wing: string;
  room: string;
  content: string;
  metadata: Record<string, unknown>;
}

export class MemPalaceProvider implements MemoryProvider {
  readonly name = "mempalace";
  readonly capabilities: ProviderCapabilities = DEFAULT_PROVIDER_CAPABILITIES.mempalace;
  private readonly client: MemPalaceClient;
  private readonly flushBatchSize: number;
  private readonly verbatim: boolean;
  private readonly allowRegulatedLocalMirror: boolean;
  private readonly pending: PendingDrawer[] = [];

  constructor(options: MemPalaceProviderOptions) {
    this.client = options.client;
    this.flushBatchSize = Math.max(1, options.flush_batch_size ?? 25);
    this.verbatim = options.verbatim ?? true;
    this.allowRegulatedLocalMirror = options.allow_regulated_local_mirror ?? false;
  }

  async remember(record: SISMemoryRecord): Promise<SISMemoryRecord> {
    if (this.isBlocked(record)) {
      return withMemPalaceRef(record, {
        provider_record_id: "blocked_by_policy",
        last_synced_at: new Date().toISOString(),
        sync_state: "failed",
      });
    }

    const content = (this.verbatim ? record.raw_content : undefined) ?? record.normalized_fact ?? record.summary ?? "";
    if (!content.trim()) {
      return withMemPalaceRef(record, {
        provider_record_id: "missing_content",
        last_synced_at: new Date().toISOString(),
        sync_state: "failed",
      });
    }

    const wing = wingFor(record.tenant_id);
    const room = record.vault ?? record.memory_type;
    this.pending.push({ record, wing, room, content, metadata: metadataFor(record) });
    return withMemPalaceRef(record, {
      provider_record_id: "pending",
      container: `${wing}/${room}`,
      last_synced_at: new Date().toISOString(),
      sync_state: "pending",
    });
  }

  async recall(request: RecallRequest): Promise<RecallResult[]> {
    const rows = await this.client.search({
      query: request.query,
      wing: wingFor(request.tenant_id),
      limit: Math.max(1, request.limit ?? 10),
    });

    const minScore = request.min_score ?? 0;
    return rows
      .map((row) => {
        const score = row.score ?? 0;
        const sisId = typeof row.metadata?.sis_memory_id === "string" ? row.metadata.sis_memory_id : `mempalace_shadow_${row.id}`;
        const record: SISMemoryRecord = {
          memory_id: sisId,
          tenant_id: request.tenant_id,
          source: { system: "mempalace", event_id: row.id },
          modality: "text",
          memory_type: "episodic",
          raw_content: row.content,
          entities: [],
          relations: [],
          importance: score,
          confidence: score || 0.5,
          trust: 0.5,
          privacy_class: "private",
          retention_policy: "permanent",
          provenance: [{ event_id: row.id, transform: "provider_imported", at: new Date().toISOString() }],
          provider_shadow_refs: {
            mempalace: {
              provider_record_id: row.id,
              container: row.wing && row.room ? `${row.wing}/${row.room}` : undefined,
              last_synced_at: new Date().toISOString(),
              sync_state: "synced",
            },
          },
        };
        return { record, score, matched_terms: [] } satisfies RecallResult;
      })
      .filter((result) => result.score >= minScore);
  }

  async forget(request: ForgetRequest): Promise<boolean> {
    return this.client.deleteDrawer({ id: request.memory_id });
  }

  async flush(): Promise<{ attempted: number; written: number; failed: number }> {
    const batch = this.pending.splice(0, this.flushBatchSize);
    let written = 0;
    let failed = 0;
    for (const item of batch) {
      try {
        await this.client.addDrawer({ wing: item.wing, room: item.room, content: item.content, metadata: item.metadata });
        written++;
      } catch {
        failed++;
      }
    }
    return { attempted: batch.length, written, failed };
  }

  pendingCount(): number {
    return this.pending.length;
  }

  private isBlocked(record: SISMemoryRecord): boolean {
    if (record.privacy_class === "secret") return true;
    if (record.privacy_class === "regulated" && !this.allowRegulatedLocalMirror) return true;
    return false;
  }
}

function wingFor(tenantId: string): string {
  return `sis_${tenantId}`;
}

function metadataFor(record: SISMemoryRecord): Record<string, unknown> {
  return {
    sis_memory_id: record.memory_id,
    tenant_id: record.tenant_id,
    workspace_id: record.workspace_id,
    memory_type: record.memory_type,
    vault: record.vault,
    privacy_class: record.privacy_class,
    source_system: record.source.system,
    session_id: record.source.session_id,
  };
}

function withMemPalaceRef(record: SISMemoryRecord, ref: SISMemoryRecord["provider_shadow_refs"][string]): SISMemoryRecord {
  return {
    ...record,
    provider_shadow_refs: {
      ...record.provider_shadow_refs,
      mempalace: ref,
    },
  };
}
