import { DEFAULT_PROVIDER_CAPABILITIES } from "./resources.js";
import type {
  ForgetRequest,
  MemoryProvider,
  ProviderCapabilities,
  RecallRequest,
  RecallResult,
  SISMemoryRecord,
} from "./types.js";

export interface HindsightClient {
  retain(input: { text: string; metadata?: Record<string, unknown> }): Promise<{ id: string }>;
  recall(input: { query: string; limit?: number; metadata?: Record<string, unknown> }): Promise<Array<{ id: string; text: string; score?: number; metadata?: Record<string, unknown> }>>;
  reflect(input: { query?: string; metadata?: Record<string, unknown> }): Promise<Array<{ id: string; summary: string; confidence?: number }>>;
  // Optional: delete or update
}

export interface HindsightProviderOptions {
  client: HindsightClient;
  allowExternalMirror?: boolean;
}

export class HindsightProvider implements MemoryProvider {
  readonly name = "hindsight";
  readonly capabilities: ProviderCapabilities = DEFAULT_PROVIDER_CAPABILITIES.hindsight || {
    provider: "hindsight",
    process_model: "remote_api" as const,
    authority: "graph_synthesis" as const,
    ram_profile: "remote" as const,
    supports_batching: true,
    per_agent_instance_allowed: false,
  };
  private readonly client: HindsightClient;
  private readonly allowExternalMirror: boolean;

  constructor(options: HindsightProviderOptions) {
    this.client = options.client;
    this.allowExternalMirror = options.allowExternalMirror ?? false;
  }

  async remember(record: SISMemoryRecord): Promise<SISMemoryRecord> {
    if (!this.allowExternalMirror && (record.privacy_class === "secret" || record.privacy_class === "regulated")) {
      return withHindsightRef(record, { provider_record_id: "blocked_by_policy", last_synced_at: new Date().toISOString(), sync_state: "failed" });
    }

    const text = record.normalized_fact ?? record.summary ?? record.raw_content ?? "";
    if (!text.trim()) {
      return withHindsightRef(record, { provider_record_id: "missing_text", last_synced_at: new Date().toISOString(), sync_state: "failed" });
    }

    const res = await this.client.retain({ text, metadata: { sis_memory_id: record.memory_id, tenant_id: record.tenant_id, ...metadataFor(record) } });
    return withHindsightRef(record, { provider_record_id: res.id, last_synced_at: new Date().toISOString(), sync_state: "synced" });
  }

  async recall(request: RecallRequest): Promise<RecallResult[]> {
    const rows = await this.client.recall({ query: request.query, limit: request.limit ?? 10, metadata: { tenant_id: request.tenant_id } });
    const minScore = request.min_score ?? 0;
    const now = new Date().toISOString();
    return rows
      .map((row) => {
        const score = row.score ?? 0.5;
        const sisId =
          typeof row.metadata?.sis_memory_id === "string"
            ? row.metadata.sis_memory_id
            : `hindsight_${row.id}`;
        const record: SISMemoryRecord = {
          memory_id: sisId,
          tenant_id: request.tenant_id,
          source: { system: "hindsight", event_id: row.id },
          modality: "text",
          memory_type: "profile",
          normalized_fact: row.text,
          entities: [],
          relations: [],
          importance: score,
          confidence: score || 0.5,
          trust: 0.5,
          privacy_class: "private-shareable",
          retention_policy: "permanent",
          provenance: [{ event_id: row.id, transform: "provider_imported", at: now }],
          provider_shadow_refs: {
            hindsight: { provider_record_id: row.id, last_synced_at: now, sync_state: "synced" },
          },
        };
        return { record, score, matched_terms: [] };
      })
      .filter((result) => result.score >= minScore);
  }

  async forget(_request: ForgetRequest): Promise<boolean> {
    // Hindsight may not expose direct delete; implement via metadata filter or no-op for now
    console.warn("Hindsight forget not fully implemented; relying on SIS local_core for authority.");
    return true;
  }
}

function withHindsightRef(record: SISMemoryRecord, ref: any): SISMemoryRecord {
  return {
    ...record,
    provider_shadow_refs: {
      ...(record.provider_shadow_refs || {}),
      hindsight: ref,
    },
  };
}

function metadataFor(record: SISMemoryRecord) {
  return {
    memory_type: record.memory_type,
    vault: record.vault,
    entities: record.entities,
    relations: record.relations,
  };
}
