import type {
  ForgetRequest,
  MemoryProvider,
  ProviderCapabilities,
  RecallRequest,
  RecallResult,
  SISMemoryRecord,
} from "./types.js";

/**
 * gbrain holds a SEARCHABLE PROJECTION of a SIS record, never the canonical one.
 * Its `facts` table cannot carry the full SISMemoryRecord: `visibility` is a
 * two-value CHECK (private|world) against our five PrivacyClass values, `source`
 * is a single string against our provenance array, and there is no tenant column.
 * So local_core stays canonical and we round-trip through provider_shadow_refs,
 * which is what that field was designed for.
 */

/**
 * PGLite allows exactly one writer. A stdio `gbrain serve` per harness makes the
 * harnesses fight over the lock, so every client must share one HTTP server.
 */
const DEFAULT_ENDPOINT = "http://127.0.0.1:7318/mcp";

export interface GBrainProviderOptions {
  endpoint?: string;
  token?: string;
  /** Deadline per request. A hung brain must not hang every agent using it. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to MCP JSON-RPC over HTTP. */
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** gbrain's fact-kind CHECK constraint. Anything else is rejected by the DB. */
const GBRAIN_KINDS = new Set(["event", "preference", "commitment", "belief", "fact", "idea"]);

const MEMORY_TYPE_TO_KIND: Record<string, string> = {
  episodic: "event",
  profile: "preference",
  policy: "commitment",
  aspirational: "idea",
  semantic: "fact",
  procedural: "fact",
  working: "fact",
};

const RETENTION_TO_TTL: Record<string, string | undefined> = {
  ephemeral: "24h",
  rolling_90d: "90d",
  permanent: undefined,
  append_only: undefined,
  delete_by: undefined,
};

export class GBrainProvider implements MemoryProvider {
  readonly name = "gbrain";
  readonly capabilities: ProviderCapabilities = {
    provider: "gbrain",
    process_model: "shared_daemon",
    authority: "accelerator",
    ram_profile: "medium",
    supports_batching: false,
    per_agent_instance_allowed: false,
    notes:
      "Hybrid retrieval (HNSW + BM25 + RRF + cross-encoder) over a shared gbrain serve --http. " +
      "Single-writer PGLite: never run one instance per agent.",
  };

  private readonly endpoint: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  private sessionId?: string;
  private initialized?: Promise<void>;
  private rpcId = 0;

  constructor(options: GBrainProviderOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.GBRAIN_MCP_URL ?? DEFAULT_ENDPOINT;
    this.token = options.token ?? process.env.GBRAIN_TOKEN;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.callTool = options.callTool ?? ((name, args) => this.mcpCall(name, args));
  }

  async remember(record: SISMemoryRecord): Promise<SISMemoryRecord> {
    if (isBlockedForGBrain(record)) return record;

    const fact = record.normalized_fact ?? record.summary ?? record.raw_content;
    if (!fact?.trim()) return record;

    const args: Record<string, unknown> = {
      fact: fact.trim(),
      provenance: formatProvenance(record),
      visibility: record.privacy_class === "public" ? "world" : "private",
      kind: toGBrainKind(record.memory_type),
    };

    const entity = record.entities[0]?.id ?? record.entities[0]?.name;
    if (entity) args.entity = entity;

    const ttl = resolveTtl(record);
    if (ttl) args.ttl = ttl;

    const response = (await this.callTool("remember", args)) as
      | { id?: number | string; status?: string }
      | undefined;

    if (response?.id === undefined) return record;

    // gbrain reports inserted | duplicate | superseded. All three mean the fact
    // is present in the brain, so all three are "synced"; the distinction is
    // kept in the ref for callers that care which happened.
    record.provider_shadow_refs.gbrain = {
      provider_record_id: String(response.id),
      container: response.status ? `facts:${response.status}` : "facts",
      last_synced_at: new Date().toISOString(),
      sync_state: "synced",
    };

    return record;
  }

  async recall(request: RecallRequest): Promise<RecallResult[]> {
    const limit = Math.max(1, request.limit ?? 10);
    const minScore = request.min_score ?? 0;

    const response = (await this.callTool("recall", {
      query: request.query,
      limit,
    })) as { facts?: GBrainFact[] } | GBrainFact[] | undefined;

    const facts = Array.isArray(response) ? response : (response?.facts ?? []);

    return facts
      .map((fact, i) => ({
        record: toSISRecord(fact, request.tenant_id),
        // gbrain does not always return a score. Confidence is a different
        // quantity and handing it over as a score corrupts cross-provider
        // ranking, so fall back to reciprocal rank, which at least preserves
        // the order the server chose and still discriminates against min_score.
        score: fact.score ?? 1 / (1 + i),
        matched_terms: fact.matched_terms ?? [],
      }))
      .filter((result) => result.score > minScore)
      .slice(0, limit);
  }

  async forget(request: ForgetRequest): Promise<boolean> {
    const response = (await this.callTool("forget", {
      id: request.memory_id,
    })) as { ok?: boolean; forgotten?: boolean } | undefined;

    return Boolean(response?.ok ?? response?.forgotten);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      // A server may answer either way, and both must be readable.
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  /**
   * A stateful server rejects tools/call with "Server not initialized" until it
   * has seen initialize, so the handshake is not optional. Done once, lazily,
   * and shared by every later call on this instance.
   */
  private async handshake(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      const res = await this.post({
        jsonrpc: "2.0",
        id: this.nextId(),
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "starlight-memory", version: "0.2.0" },
        },
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      await parseRpc(await res.text(), "initialize");
      // Notification: no id, no response body to read.
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
    })();
    return this.initialized;
  }

  private nextId(): number {
    return ++this.rpcId;
  }

  private async post(body: unknown): Promise<Response> {
    // Without a deadline a hung brain hangs every agent talking to it.
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`gbrain request failed: ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`);
    }
    return res;
  }

  private async mcpCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.handshake();
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/call",
      params: { name, arguments: args },
    });
    const payload = await parseRpc(await res.text(), name);

    const result = payload.result;
    if (result?.structuredContent !== undefined) return result.structuredContent;

    const text = result?.content?.[0]?.text;
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return { status_text: text };
    }
  }
}

const PROTOCOL_VERSION = "2025-06-18";

interface RpcPayload {
  error?: { message?: string };
  result?: { structuredContent?: unknown; content?: Array<{ text?: string }> };
}

/**
 * A streamable-HTTP server may answer a POST with either a JSON body or an SSE
 * stream, depending on how it was configured. Reading only JSON throws a raw
 * SyntaxError on the SSE path, which is indistinguishable from a broken server.
 */
async function parseRpc(body: string, label: string): Promise<RpcPayload> {
  const trimmed = body.trim();
  let json = trimmed;

  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const data = trimmed
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    if (!data) throw new Error(`gbrain ${label} failed: SSE response carried no data frame`);
    json = data;
  }

  let payload: RpcPayload;
  try {
    payload = JSON.parse(json) as RpcPayload;
  } catch {
    throw new Error(`gbrain ${label} failed: unparseable response — ${trimmed.slice(0, 200)}`);
  }
  if (payload.error) throw new Error(`gbrain ${label} failed: ${payload.error.message}`);
  return payload;
}

interface GBrainFact {
  id?: number | string;
  fact?: string;
  entity_slug?: string;
  kind?: string;
  visibility?: string;
  confidence?: number;
  source?: string;
  score?: number;
  matched_terms?: string[];
  created_at?: string;
  valid_from?: string;
  valid_until?: string;
}

/**
 * Deliberately stricter than the router's policy-aware check: gbrain is a
 * third-party engine, so `regulated` is blocked here even where tenant policy
 * would permit an external mirror. Named distinctly so the two are not
 * mistaken for one predicate.
 */
function isBlockedForGBrain(record: SISMemoryRecord): boolean {
  return record.privacy_class === "secret" || record.privacy_class === "regulated";
}

function toGBrainKind(memoryType: string): string {
  const kind = MEMORY_TYPE_TO_KIND[memoryType] ?? "fact";
  return GBRAIN_KINDS.has(kind) ? kind : "fact";
}

/** Flatten the provenance chain into gbrain's single 500-char source string. */
function formatProvenance(record: SISMemoryRecord): string {
  const head = record.source.system || "sis";
  const chain = record.provenance.map((step) => step.transform).join(">");
  const ref = record.source.session_id ?? record.source.event_id ?? record.memory_id;
  return `sis:${head}${chain ? `:${chain}` : ""} (${ref})`.slice(0, 500);
}

function resolveTtl(record: SISMemoryRecord): string | undefined {
  if (record.retention_policy === "delete_by" && record.retention_until) {
    return record.retention_until;
  }
  return RETENTION_TO_TTL[record.retention_policy];
}

/**
 * Rebuilds a partial SIS record from a gbrain row. Fields gbrain cannot store
 * come back at defaults, so callers must rejoin against local_core by
 * provider_shadow_refs when they need the full record.
 */
function toSISRecord(fact: GBrainFact, tenantId: string): SISMemoryRecord {
  const id = String(fact.id ?? "");
  return {
    memory_id: `gbrain:${id}`,
    tenant_id: tenantId,
    source: { system: "gbrain", uri: fact.source },
    modality: "text",
    memory_type: "semantic",
    normalized_fact: fact.fact,
    entities: fact.entity_slug ? [{ id: fact.entity_slug, name: fact.entity_slug }] : [],
    relations: [],
    time_range: { start: fact.valid_from, end: fact.valid_until, observed_at: fact.created_at },
    importance: 0.5,
    confidence: fact.confidence ?? 1,
    trust: 0.5,
    privacy_class: fact.visibility === "world" ? "public" : "private",
    retention_policy: fact.valid_until ? "delete_by" : "permanent",
    retention_until: fact.valid_until,
    provenance: [{ event_id: id, transform: "provider_imported", at: new Date().toISOString() }],
    provider_shadow_refs: {
      gbrain: {
        provider_record_id: id,
        container: "facts",
        last_synced_at: new Date().toISOString(),
        sync_state: "synced",
      },
    },
  };
}
