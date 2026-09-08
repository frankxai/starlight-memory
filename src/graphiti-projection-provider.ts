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
 * Minimal Graphiti boundary. The application supplies the SDK/HTTP client so
 * this package remains dependency-free and never creates a Graphiti runtime.
 */
export interface GraphitiClient {
  addEpisode(input: {
    group_id: string;
    name: string;
    episode_body: string;
    source: "message" | "text" | "json";
    reference_time?: string;
    metadata: Record<string, unknown>;
  }): Promise<{ id: string }>;
  searchFacts(input: {
    query: string;
    group_ids: string[];
    limit: number;
  }): Promise<Array<{
    id: string;
    fact: string;
    score?: number;
    valid_at?: string;
    invalid_at?: string;
    metadata?: Record<string, unknown>;
  }>>;
  /** Delete by the canonical SIS memory id, not a vendor-only episode id. */
  deleteByMemoryId(input: { group_id: string; sis_memory_id: string }): Promise<boolean>;
}

export interface GraphitiProjectionProviderOptions {
  client: GraphitiClient;
  flush_batch_size?: number;
  /** Required only for regulated data; secret data is never externally mirrored. */
  allowExternalMirror?: boolean;
}

interface PendingProjection {
  record: SISMemoryRecord;
  input: Parameters<GraphitiClient["addEpisode"]>[0];
}

interface PendingDelete {
  tenant_id: string;
  memory_id: string;
}

/**
 * Optional temporal knowledge-graph projection. Graphiti never owns canonical
 * memory: it receives a redacted fact/summary after SIS local_core has written.
 * One injected client is shared by all agents through the Starlight gateway.
 */
export class GraphitiProjectionProvider implements MemoryProvider {
  readonly name = "graphiti";
  readonly capabilities: ProviderCapabilities = DEFAULT_PROVIDER_CAPABILITIES.graphiti;
  private readonly client: GraphitiClient;
  private readonly flushBatchSize: number;
  private readonly allowExternalMirror: boolean;
  private pending: PendingProjection[] = [];
  private pendingDeletes: PendingDelete[] = [];
  private readonly tombstoned = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(options: GraphitiProjectionProviderOptions) {
    this.client = options.client;
    this.flushBatchSize = Math.max(1, options.flush_batch_size ?? 25);
    this.allowExternalMirror = options.allowExternalMirror ?? false;
  }

  async remember(record: SISMemoryRecord): Promise<SISMemoryRecord> {
    if (this.isBlocked(record)) {
      return withGraphitiRef(record, {
        provider_record_id: "blocked_by_policy",
        last_synced_at: new Date().toISOString(),
        sync_state: "failed",
      });
    }

    // Never fall back to raw_content: graph mirrors receive a normalized fact or
    // summary only, even when Graphiti runs on infrastructure we control.
    const episodeBody = record.normalized_fact ?? record.summary ?? "";
    if (!episodeBody.trim()) {
      return withGraphitiRef(record, {
        provider_record_id: "missing_redacted_text",
        last_synced_at: new Date().toISOString(),
        sync_state: "failed",
      });
    }

    this.pending.push({
      record,
      input: {
        group_id: record.tenant_id,
        name: record.memory_id,
        episode_body: episodeBody,
        source: "text",
        reference_time: record.time_range?.observed_at,
        metadata: metadataFor(record),
      },
    });

    return withGraphitiRef(record, {
      provider_record_id: "pending",
      container: record.tenant_id,
      last_synced_at: new Date().toISOString(),
      sync_state: "pending",
    });
  }

  async flush(): Promise<{ attempted: number; written: number; failed: number }> {
    const deleteBatch = this.pendingDeletes.splice(0, this.flushBatchSize);
    const retryDeletes: PendingDelete[] = [];
    let written = 0;
    let failed = 0;
    for (const pendingDelete of deleteBatch) {
      try {
        const deleted = await this.client.deleteByMemoryId({
          group_id: pendingDelete.tenant_id,
          sis_memory_id: pendingDelete.memory_id,
        });
        if (deleted) written++;
        else { retryDeletes.push(pendingDelete); failed++; }
      } catch {
        retryDeletes.push(pendingDelete);
        failed++;
      }
    }
    if (retryDeletes.length) this.pendingDeletes.unshift(...retryDeletes);

    const capacity = this.flushBatchSize - deleteBatch.length;
    const batch = capacity > 0 ? this.pending.splice(0, capacity) : [];
    for (const projection of batch) this.inFlight.add(projectionKey(projection.record.tenant_id, projection.record.memory_id));
    const retry: PendingProjection[] = [];
    for (const projection of batch) {
      const key = projectionKey(projection.record.tenant_id, projection.record.memory_id);
      try {
        if (this.tombstoned.has(key)) continue;
        await this.client.addEpisode(projection.input);
        // A forget may have run while the remote add was in flight. Delete after
        // the add completes so a tombstone can never be resurrected by ordering.
        if (this.tombstoned.has(key)) {
          const deleted = await this.client.deleteByMemoryId({
            group_id: projection.record.tenant_id,
            sis_memory_id: projection.record.memory_id,
          });
          if (deleted) written++;
          else { this.enqueueDelete(projection.record.tenant_id, projection.record.memory_id); failed++; }
        } else {
          written++;
        }
      } catch {
        if (this.tombstoned.has(key)) this.enqueueDelete(projection.record.tenant_id, projection.record.memory_id);
        else retry.push(projection);
        failed++;
      } finally {
        this.inFlight.delete(key);
      }
    }
    if (retry.length) this.pending.unshift(...retry);
    return { attempted: deleteBatch.length + batch.length, written, failed };
  }

  pendingCount(): number {
    return this.pending.length + this.pendingDeletes.length;
  }

  async recall(request: RecallRequest): Promise<RecallResult[]> {
    const { query, limit } = boundedRecallRequest(request);
    const rows = await this.client.searchFacts({
      query,
      group_ids: [request.tenant_id],
      limit,
    });
    const minScore = request.min_score ?? 0;

    return rows
      // Defense in depth: never trust an upstream service to enforce group IDs.
      .filter((row) => row.metadata?.tenant_id === request.tenant_id)
      .map((row) => toRecallResult(request.tenant_id, row))
      .filter((result) => result.score >= minScore)
      .slice(0, limit);
  }

  private enqueueDelete(tenant_id: string, memory_id: string): void {
    if (!this.pendingDeletes.some((item) => item.tenant_id === tenant_id && item.memory_id === memory_id)) {
      this.pendingDeletes.push({ tenant_id, memory_id });
    }
  }

  async forget(request: ForgetRequest): Promise<boolean> {
    const key = projectionKey(request.tenant_id, request.memory_id);
    this.tombstoned.add(key);
    // A tombstoned canonical record must not be resurrected by a later flush.
    this.pending = this.pending.filter(({ record }) => !(
      record.tenant_id === request.tenant_id && record.memory_id === request.memory_id
    ));
    const pendingDelete = { tenant_id: request.tenant_id, memory_id: request.memory_id };
    try {
      const deleted = await this.client.deleteByMemoryId({
        group_id: request.tenant_id,
        sis_memory_id: request.memory_id,
      });
      if (deleted) return true;
    } catch {
      // The canonical tombstone still wins. Retain an in-process retry; SIS is
      // responsible for durable outbox/reconciliation across process restarts.
    }
    this.enqueueDelete(pendingDelete.tenant_id, pendingDelete.memory_id);
    return false;
  }

  private isBlocked(record: SISMemoryRecord): boolean {
    return record.privacy_class === "secret" || (
      record.privacy_class === "regulated" && !this.allowExternalMirror
    );
  }
}

const MAX_RECALL_QUERY_CHARS = 512;
const MAX_RECALL_LIMIT = 20;

function boundedRecallRequest(request: RecallRequest): { query: string; limit: number } {
  if (typeof request.query !== "string" || !request.query.trim()) throw new Error("Graphiti recall query must be non-empty text");
  if (request.query.length > MAX_RECALL_QUERY_CHARS) throw new Error(`Graphiti recall query exceeds ${MAX_RECALL_QUERY_CHARS} characters`);
  const requested = typeof request.limit === "number" && Number.isFinite(request.limit)
    ? Math.floor(request.limit)
    : 10;
  return { query: request.query, limit: Math.max(1, Math.min(requested, MAX_RECALL_LIMIT)) };
}

function projectionKey(tenantId: string, memoryId: string): string {
  return `${tenantId}\u0000${memoryId}`;
}

function metadataFor(record: SISMemoryRecord): Record<string, unknown> {
  return {
    sis_memory_id: record.memory_id,
    tenant_id: record.tenant_id,
    workspace_id: record.workspace_id,
    agent_id: record.agent_id,
    memory_type: record.memory_type,
    vault: record.vault,
    privacy_class: record.privacy_class,
    importance: record.importance,
    confidence: record.confidence,
    trust: record.trust,
    entities: record.entities,
    relations: record.relations,
  };
}

function toRecallResult(
  tenantId: string,
  row: Awaited<ReturnType<GraphitiClient["searchFacts"]>>[number],
): RecallResult {
  const now = new Date().toISOString();
  const score = row.score ?? 0.5;
  const memoryId =
    typeof row.metadata?.sis_memory_id === "string"
      ? row.metadata.sis_memory_id
      : `graphiti_shadow_${row.id}`;
  const record: SISMemoryRecord = {
    memory_id: memoryId,
    tenant_id: tenantId,
    source: { system: "graphiti", event_id: row.id },
    modality: "text",
    memory_type: "semantic",
    normalized_fact: row.fact,
    entities: [],
    relations: [],
    time_range: { start: row.valid_at, end: row.invalid_at },
    importance: score,
    confidence: score || 0.5,
    trust: 0.5,
    privacy_class: "private-shareable",
    retention_policy: "permanent",
    provenance: [{ event_id: row.id, transform: "provider_imported", at: now }],
    provider_shadow_refs: {
      graphiti: {
        provider_record_id: row.id,
        container: tenantId,
        last_synced_at: now,
        sync_state: "synced",
      },
    },
  };
  return { record, score, matched_terms: [] };
}

function withGraphitiRef(
  record: SISMemoryRecord,
  ref: SISMemoryRecord["provider_shadow_refs"][string],
): SISMemoryRecord {
  return {
    ...record,
    provider_shadow_refs: {
      ...record.provider_shadow_refs,
      graphiti: ref,
    },
  };
}
