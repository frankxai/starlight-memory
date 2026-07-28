import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface GraphitiEpisodeInput {
  group_id: string;
  name: string;
  episode_body: string;
  source: "message" | "text" | "json";
  reference_time?: string;
  metadata: Record<string, unknown>;
}

export interface GraphitiQueuedProjection {
  tenant_id: string;
  memory_id: string;
  input: GraphitiEpisodeInput;
}

export interface GraphitiQueuedDelete {
  tenant_id: string;
  memory_id: string;
}

export interface GraphitiProjectionOutboxState {
  version: 1;
  projections: GraphitiQueuedProjection[];
  deletes: GraphitiQueuedDelete[];
  tombstones: string[];
}

export interface GraphitiProjectionOutbox {
  load(): Promise<GraphitiProjectionOutboxState>;
  save(state: GraphitiProjectionOutboxState): Promise<void>;
}

export function emptyGraphitiProjectionOutboxState(): GraphitiProjectionOutboxState {
  return { version: 1, projections: [], deletes: [], tombstones: [] };
}

/**
 * Local, sanitized, restart-safe outbox for the one shared Graphiti gateway.
 * It persists only the already-approved episode projection and canonical IDs;
 * a SISMemoryRecord (and therefore raw_content) is never serialized.
 */
export class JsonFileGraphitiProjectionOutbox implements GraphitiProjectionOutbox {
  constructor(private readonly filePath: string) {
    if (!filePath?.trim()) throw new Error("Graphiti outbox file path is required");
  }

  async load(): Promise<GraphitiProjectionOutboxState> {
    let body: string;
    try {
      body = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyGraphitiProjectionOutboxState();
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(body);
    assertGraphitiProjectionOutboxState(parsed);
    return structuredClone(parsed);
  }

  async save(state: GraphitiProjectionOutboxState): Promise<void> {
    assertGraphitiProjectionOutboxState(state);
    const directory = path.dirname(path.resolve(this.filePath));
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function assertGraphitiProjectionOutboxState(value: unknown): asserts value is GraphitiProjectionOutboxState {
  if (!isObject(value) || value.version !== 1) throw new Error("Unsupported Graphiti outbox state");
  if (!Array.isArray(value.projections) || !value.projections.every(isProjection)) {
    throw new Error("Invalid Graphiti outbox projections");
  }
  if (!Array.isArray(value.deletes) || !value.deletes.every(isDelete)) {
    throw new Error("Invalid Graphiti outbox deletes");
  }
  if (!Array.isArray(value.tombstones) || !value.tombstones.every((item) => typeof item === "string")) {
    throw new Error("Invalid Graphiti outbox tombstones");
  }
}

function isProjection(value: unknown): value is GraphitiQueuedProjection {
  return isObject(value) &&
    typeof value.tenant_id === "string" &&
    typeof value.memory_id === "string" &&
    isObject(value.input) &&
    typeof value.input.group_id === "string" &&
    typeof value.input.name === "string" &&
    typeof value.input.episode_body === "string" &&
    ["message", "text", "json"].includes(String(value.input.source)) &&
    isObject(value.input.metadata);
}

function isDelete(value: unknown): value is GraphitiQueuedDelete {
  return isObject(value) && typeof value.tenant_id === "string" && typeof value.memory_id === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
