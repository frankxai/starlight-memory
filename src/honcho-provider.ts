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
 * Honcho is a reasoning-first peer/theory-of-mind service from Plastic Labs.
 * Honcho itself is AGPL-3.0; this adapter only defines the SIS-facing client
 * boundary and keeps local_core authoritative.
 */
export interface HonchoMessage {
  id?: string;
  content: string;
  is_user: boolean;
  metadata?: Record<string, unknown>;
}

export interface HonchoDialecticMemory {
  id: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface HonchoDialecticResult {
  content: string;
  memories?: HonchoDialecticMemory[];
}

export interface HonchoClient {
  addMessages(input: {
    workspace_id: string;
    peer_id: string;
    session_id: string;
    messages: HonchoMessage[];
  }): Promise<{ message_ids?: string[] }>;
  peerChat(input: {
    workspace_id: string;
    peer_id: string;
    query: string;
    session_id?: string;
    limit: number;
  }): Promise<HonchoDialecticResult>;
  deleteMessage?(input: {
    workspace_id: string;
    peer_id: string;
    message_id: string;
  }): Promise<boolean>;
}

export interface HonchoProviderOptions {
  client: HonchoClient;
  flush_batch_size?: number;
  allow_external_mirror?: boolean;
  allowExternalMirror?: boolean;
  peer_id?: string;
  session_id?: string;
}

interface PendingTurn {
  record: SISMemoryRecord;
  workspaceId: string;
  peerId: string;
  sessionId: string;
  message: HonchoMessage;
}

export class HonchoProvider implements MemoryProvider {
  readonly name = "honcho";
  readonly capabilities: ProviderCapabilities = DEFAULT_PROVIDER_CAPABILITIES.honcho;
  private readonly client: HonchoClient;
  private readonly flushBatchSize: number;
  private readonly allowExternalMirror: boolean;
  private readonly defaultPeerId?: string;
  private readonly defaultSessionId?: string;
  private readonly pending: PendingTurn[] = [];

  constructor(options: HonchoProviderOptions) {
    this.client = options.client;
    this.flushBatchSize = Math.max(1, options.flush_batch_size ?? 25);
    this.allowExternalMirror =
      options.allowExternalMirror ?? options.allow_external_mirror ?? false;
    this.defaultPeerId = options.peer_id;
    this.defaultSessionId = options.session_id;
  }

  async remember(record: SISMemoryRecord): Promise<SISMemoryRecord> {
    if (this.isBlocked(record)) {
      return withHonchoRef(record, {
        provider_record_id: "blocked_by_policy",
        last_synced_at: new Date().toISOString(),
        sync_state: "failed",
      });
    }

    const content = record.normalized_fact ?? record.summary ?? "";
    if (!content.trim()) {
      return withHonchoRef(record, {
        provider_record_id: "missing_redacted_text",
        last_synced_at: new Date().toISOString(),
        sync_state: "failed",
      });
    }

    const peerId = this.defaultPeerId ?? record.user_id ?? record.agent_id ?? "sis_peer";
    const sessionId =
      this.defaultSessionId ??
      record.source.session_id ??
      record.workspace_id ??
      `sis_${record.tenant_id}`;

    this.pending.push({
      record,
      workspaceId: record.tenant_id,
      peerId,
      sessionId,
      message: {
        id: record.memory_id,
        content,
        is_user: record.source.system !== "honcho",
        metadata: metadataFor(record),
      },
    });

    return withHonchoRef(record, {
      provider_record_id: "pending",
      container: sessionId,
      last_synced_at: new Date().toISOString(),
      sync_state: "pending",
    });
  }

  async recall(request: RecallRequest): Promise<RecallResult[]> {
    const limit = Math.max(1, request.limit ?? 10);
    const response = await this.client.peerChat({
      workspace_id: request.tenant_id,
      peer_id: this.defaultPeerId ?? "sis_peer",
      query: request.query,
      session_id: this.defaultSessionId,
      limit,
    });
    const memories =
      response.memories?.length
        ? response.memories
        : [{
            id: `honcho_dialectic_${stableId(request.query)}`,
            content: response.content,
            score: 1,
          }];
    const minScore = request.min_score ?? 0;

    return memories
      .slice(0, limit)
      .map((memory) => toRecallResult(request.tenant_id, memory))
      .filter((result) => result.score >= minScore);
  }

  async forget(request: ForgetRequest): Promise<boolean> {
    if (!this.client.deleteMessage) return false;
    return this.client.deleteMessage({
      workspace_id: request.tenant_id,
      peer_id: this.defaultPeerId ?? "sis_peer",
      message_id: request.memory_id,
    });
  }

  async flush(): Promise<{ attempted: number; written: number; failed: number }> {
    const batch = this.pending.splice(0, this.flushBatchSize);
    const groups = new Map<string, PendingTurn[]>();
    for (const item of batch) {
      const key = JSON.stringify([item.workspaceId, item.peerId, item.sessionId]);
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }

    let written = 0;
    let failed = 0;
    for (const group of groups.values()) {
      const first = group[0];
      if (!first) continue;
      try {
        await this.client.addMessages({
          workspace_id: first.workspaceId,
          peer_id: first.peerId,
          session_id: first.sessionId,
          messages: group.map((item) => item.message),
        });
        written += group.length;
      } catch {
        failed += group.length;
      }
    }
    return { attempted: batch.length, written, failed };
  }

  pendingCount(): number {
    return this.pending.length;
  }

  private isBlocked(record: SISMemoryRecord): boolean {
    return (
      (record.privacy_class === "secret" || record.privacy_class === "regulated") &&
      !this.allowExternalMirror
    );
  }
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
  };
}

function toRecallResult(
  tenantId: string,
  memory: HonchoDialecticMemory,
): RecallResult {
  const score = memory.score ?? 0;
  const sisId =
    typeof memory.metadata?.sis_memory_id === "string"
      ? memory.metadata.sis_memory_id
      : `honcho_shadow_${memory.id}`;
  const now = new Date().toISOString();
  const record: SISMemoryRecord = {
    memory_id: sisId,
    tenant_id: tenantId,
    source: { system: "honcho", event_id: memory.id },
    modality: "text",
    memory_type: "profile",
    normalized_fact: memory.content,
    entities: [],
    relations: [],
    importance: score,
    confidence: score || 0.5,
    trust: 0.5,
    privacy_class: "private-shareable",
    retention_policy: "permanent",
    provenance: [{ event_id: memory.id, transform: "provider_imported", at: now }],
    provider_shadow_refs: {
      honcho: {
        provider_record_id: memory.id,
        last_synced_at: now,
        sync_state: "synced",
      },
    },
  };
  return { record, score, matched_terms: [] };
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function withHonchoRef(
  record: SISMemoryRecord,
  ref: SISMemoryRecord["provider_shadow_refs"][string],
): SISMemoryRecord {
  return {
    ...record,
    provider_shadow_refs: {
      ...record.provider_shadow_refs,
      honcho: ref,
    },
  };
}
