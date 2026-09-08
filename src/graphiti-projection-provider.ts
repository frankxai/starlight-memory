import { DEFAULT_PROVIDER_CAPABILITIES } from "./resources.js";
import { isExternalMirrorAllowed } from "./external-privacy.js";
import {
  emptyGraphitiProjectionOutboxState,
  type GraphitiEpisodeInput,
  type GraphitiProjectionOutbox,
  type GraphitiQueuedDelete,
  type GraphitiQueuedProjection,
} from "./graphiti-projection-outbox.js";
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
  addEpisode(input: GraphitiEpisodeInput): Promise<{ id: string }>;
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
  /** Remote is fail-closed; private records may use an explicitly local daemon. */
  deployment?: "local_shared_daemon" | "remote_api";
  allowPrivateExternalMirror?: boolean;
  /** Required only for regulated data; secret data is never externally mirrored. */
  allowExternalMirror?: boolean;
  /** Optional durable, sanitized queue owned by the one shared gateway. */
  outbox?: GraphitiProjectionOutbox;
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
  private readonly deployment: "local_shared_daemon" | "remote_api";
  private readonly allowPrivateExternalMirror: boolean;
  private readonly allowExternalMirror: boolean;
  private readonly outbox?: GraphitiProjectionOutbox;
  private pending: GraphitiQueuedProjection[] = [];
  private pendingDeletes: GraphitiQueuedDelete[] = [];
  private readonly tombstoned = new Set<string>();
  private readonly inFlight = new Set<string>();
  private hydratePromise?: Promise<void>;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: GraphitiProjectionProviderOptions) {
    this.client = options.client;
    this.flushBatchSize = Math.max(1, options.flush_batch_size ?? 25);
    this.deployment = options.deployment ?? "remote_api";
    this.allowPrivateExternalMirror = options.allowPrivateExternalMirror ?? false;
    this.allowExternalMirror = options.allowExternalMirror ?? false;
    this.outbox = options.outbox;
  }

  async remember(record: SISMemoryRecord): Promise<SISMemoryRecord> {
    await this.ensureHydrated();
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
      tenant_id: record.tenant_id,
      memory_id: record.memory_id,
      input: {
        group_id: record.tenant_id,
        name: record.memory_id,
        episode_body: episodeBody,
        source: "text",
        reference_time: record.time_range?.observed_at,
        metadata: metadataFor(record),
      },
    });
    await this.persist();

    return withGraphitiRef(record, {
      provider_record_id: "pending",
      container: record.tenant_id,
      last_synced_at: new Date().toISOString(),
      sync_state: "pending",
    });
  }

  async flush(): Promise<{ attempted: number; written: number; failed: number }> {
    await this.ensureHydrated();
    const deleteBatch = this.pendingDeletes.splice(0, this.flushBatchSize);
    const retryDeletes: GraphitiQueuedDelete[] = [];
    let written = 0;
    let failed = 0;
    for (const pendingDelete of deleteBatch) {
      try {
        const deleted = await this.client.deleteByMemoryId({
          group_id: pendingDelete.tenant_id,
          sis_memory_id: pendingDelete.memory_id,
        });
        if (deleted) {
          written++;
          this.tombstoned.delete(projectionKey(pendingDelete.tenant_id, pendingDelete.memory_id));
        }
        else { retryDeletes.push(pendingDelete); failed++; }
      } catch {
        retryDeletes.push(pendingDelete);
        failed++;
      }
    }
    if (retryDeletes.length) this.pendingDeletes.unshift(...retryDeletes);

    const capacity = this.flushBatchSize - deleteBatch.length;
    const batch = capacity > 0 ? this.pending.splice(0, capacity) : [];
    for (const projection of batch) this.inFlight.add(projectionKey(projection.tenant_id, projection.memory_id));
    const retry: GraphitiQueuedProjection[] = [];
    for (const projection of batch) {
      const key = projectionKey(projection.tenant_id, projection.memory_id);
      try {
        if (this.tombstoned.has(key)) continue;
        await this.client.addEpisode(projection.input);
        // A forget may have run while the remote add was in flight. Delete after
        // the add completes so a tombstone can never be resurrected by ordering.
        if (this.tombstoned.has(key)) {
          const deleted = await this.client.deleteByMemoryId({
            group_id: projection.tenant_id,
            sis_memory_id: projection.memory_id,
          });
          if (deleted) {
            written++;
            this.tombstoned.delete(key);
          } else {
            this.enqueueDelete(projection.tenant_id, projection.memory_id);
            failed++;
          }
        } else {
          written++;
        }
      } catch {
        if (this.tombstoned.has(key)) this.enqueueDelete(projection.tenant_id, projection.memory_id);
        else retry.push(projection);
        failed++;
      } finally {
        this.inFlight.delete(key);
      }
    }
    if (retry.length) this.pending.unshift(...retry);
    await this.persist();
    return { attempted: deleteBatch.length + batch.length, written, failed };
  }

  async hydrate(): Promise<number> {
    await this.ensureHydrated();
    return this.pendingCount();
  }

  pendingCount(): number {
    return this.pending.length + this.pendingDeletes.length;
  }

  async recall(request: RecallRequest): Promise<RecallResult[]> {
    await this.ensureHydrated();
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
    await this.ensureHydrated();
    const key = projectionKey(request.tenant_id, request.memory_id);
    this.tombstoned.add(key);
    // A tombstoned canonical record must not be resurrected by a later flush.
    this.pending = this.pending.filter((projection) => !(
      projection.tenant_id === request.tenant_id && projection.memory_id === request.memory_id
    ));
    this.enqueueDelete(request.tenant_id, request.memory_id);
    await this.persist();
    try {
      const deleted = await this.client.deleteByMemoryId({
        group_id: request.tenant_id,
        sis_memory_id: request.memory_id,
      });
      if (deleted) {
        this.pendingDeletes = this.pendingDeletes.filter((item) => !(
          item.tenant_id === request.tenant_id && item.memory_id === request.memory_id
        ));
        if (!this.inFlight.has(key)) this.tombstoned.delete(key);
        await this.persist();
        return true;
      }
    } catch {
      // The canonical tombstone still wins; the outbox retains the retry.
    }
    return false;
  }

  private async ensureHydrated(): Promise<void> {
    if (!this.hydratePromise) {
      this.hydratePromise = (async () => {
        if (!this.outbox) return;
        const state = await this.outbox.load();
        this.pending = state.projections;
        this.pendingDeletes = state.deletes;
        this.tombstoned.clear();
        for (const key of state.tombstones) this.tombstoned.add(key);
      })();
    }
    await this.hydratePromise;
  }

  private async persist(): Promise<void> {
    const outbox = this.outbox;
    if (!outbox) return;
    const state = emptyGraphitiProjectionOutboxState();
    state.projections = structuredClone(this.pending);
    state.deletes = structuredClone(this.pendingDeletes);
    state.tombstones = [...this.tombstoned].sort();
    const queued = this.persistChain.then(() => outbox.save(state));
    this.persistChain = queued.catch(() => undefined);
    await queued;
  }

  private isBlocked(record: SISMemoryRecord): boolean {
    if (record.privacy_class === "private" && this.deployment === "local_shared_daemon") {
      return false;
    }
    return !isExternalMirrorAllowed(record.privacy_class, {
      allowPrivateExternalMirror: this.allowPrivateExternalMirror,
      allowRegulatedExternalMirror: this.allowExternalMirror,
    });
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
    memory_type: record.memory_type,
    privacy_class: record.privacy_class,
    importance: record.importance,
    confidence: record.confidence,
    trust: record.trust,
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
