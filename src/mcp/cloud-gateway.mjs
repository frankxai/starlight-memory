// Starlight Memory cloud gateway — authenticated, read-only Streamable HTTP MCP.
//
// This service deliberately exposes a sanitized projection only. It never serves
// vault_read/list or write/delete tools, so a cloud client cannot exfiltrate raw
// local vault content or mutate canonical memory. Deploy it behind Railway/HTTPS
// with STARLIGHT_MEMORY_MCP_TOKEN supplied by the secrets manager.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileToRecord } from "./vault-store.mjs";
import { HybridIndex } from "./hybrid-index.mjs";

const CLOUD_TOOLS = [
  {
    name: "memory_recall",
    description: "Recall sanitized summaries of durable Starlight memory. Raw vault content is never available through this cloud gateway.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "memory_search",
    description: "Search sanitized memory summaries using lexical matching. Raw vault content is never available through this cloud gateway.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "memory_sync_status",
    description: "Return the cloud projection watermark and staleness metadata only; no vault path, tenant identifier, or memory content is disclosed.",
    inputSchema: { type: "object", properties: {} },
  },
];

const MAX_QUERY_CHARS = 512;
const MAX_RESULTS = 8;
const MAX_SUMMARY_CHARS = 600;
const MAX_REQUEST_BYTES = 64 * 1024;

function log(...args) { console.error("[starlight-memory-cloud]", ...args); }
function text(value) { return { content: [{ type: "text", text: value }] }; }

async function resolveConfig(opts) {
  if (!opts.vault) throw new Error("cloud gateway requires an explicit --vault pointing to a Starlight cloud projection");
  const verificationKey = process.env.STARLIGHT_MEMORY_PROJECTION_PUBLIC_KEY;
  if (!verificationKey) throw new Error("STARLIGHT_MEMORY_PROJECTION_PUBLIC_KEY must contain the Ed25519 PEM public key for signed cloud projections");
  return {
    vaultRoot: path.resolve(opts.vault),
    tenant: opts.tenant || "frank",
    embeddings: opts.embeddings || "auto",
    verificationKey,
  };
}

async function readProjectionMarker(config) {
  const markerPath = path.join(config.vaultRoot, ".starlight-cloud-projection.json");
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw new Error("refusing cloud gateway vault without a valid .starlight-cloud-projection.json marker");
  }
  if (marker?.format !== 1 || marker?.source !== "starlight-memory" || marker?.tenant !== config.tenant) {
    throw new Error("cloud projection marker is invalid or belongs to a different tenant");
  }
  if (typeof marker.projection_id !== "string" || !/^[a-f0-9]{64}$/.test(marker.projection_id) ||
      typeof marker.atoms_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.atoms_sha256) ||
      !Number.isInteger(marker.record_count) || marker.record_count < 0) {
    throw new Error("cloud projection marker is missing valid integrity metadata");
  }
  const manifest = {
    format: marker.format,
    projection_id: marker.projection_id,
    atoms_sha256: marker.atoms_sha256,
    tenant: marker.tenant,
    generated_at: marker.generated_at,
    record_count: marker.record_count,
    source: marker.source,
    policy: marker.policy,
  };
  const signature = typeof marker.signature === "string" ? Buffer.from(marker.signature, "base64") : Buffer.alloc(0);
  if (marker.signature_alg !== "ed25519" || !crypto.verify(null, Buffer.from(JSON.stringify(manifest)), config.verificationKey, signature)) {
    throw new Error("cloud projection marker signature is invalid");
  }
  return marker;
}

export async function verifyProjectionAtoms(config, marker) {
  const atomDir = path.join(config.vaultRoot, "atoms");
  let entries;
  try {
    entries = await fs.readdir(atomDir, { withFileTypes: true });
  } catch {
    throw new Error("cloud projection atoms directory is missing");
  }
  if (entries.some((entry) => !entry.isFile() || !entry.name.endsWith(".md"))) {
    throw new Error("cloud projection atoms must be flat regular .md files only");
  }
  const hash = crypto.createHash("sha256");
  const atoms = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const bytes = await fs.readFile(path.join(atomDir, entry.name));
    hash.update(`atoms/${entry.name}`, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(bytes);
    hash.update("\u0000", "utf8");
    atoms.push({ name: entry.name, bytes });
  }
  const actual = hash.digest("hex");
  if (entries.length !== marker.record_count || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(marker.atoms_sha256))) {
    throw new Error("cloud projection atom integrity check failed");
  }
  return atoms;
}

export async function loadVerifiedProjectionRecords(config, atoms) {
  const atomDir = path.join(config.vaultRoot, "atoms");
  const records = [];
  for (const { name, bytes } of atoms) {
    const atomPath = path.join(atomDir, name);
    // Parse exactly the bytes that were included in the signature-bound digest;
    // never re-read a mutable projection path after verification.
    const atom = bytes.toString("utf8");
    if (!/^---\r?\n/.test(atom)) throw new Error("cloud projection atom is missing frontmatter");
    const record = fileToRecord(atomPath, atom, config.tenant);
    if (record.tenant_id !== config.tenant || record.privacy_class !== "public" || typeof record.summary !== "string" || !record.summary.trim()) {
      throw new Error("cloud projection atom violates the summary-only public schema");
    }
    records.push(record);
  }
  return records;
}

class ReadOnlyVault {
  constructor(config) { this.config = config; }
  async load(marker) {
    const resolvedMarker = marker || await readProjectionMarker(this.config);
    const verifiedAtoms = await verifyProjectionAtoms(this.config, resolvedMarker);
    // Index only the exact flat atom set whose names and bytes were signed. The
    // general vault loader is intentionally not used here: it permits canonical
    // vault layouts and would admit unsigned sibling Markdown files.
    const records = await loadVerifiedProjectionRecords(this.config, verifiedAtoms);
    this.records = records;
    this.index = new HybridIndex(this.records, { embeddings: this.config.embeddings });
    await this.index.build();
    this.marker = resolvedMarker;
    log(`indexed ${this.records.length} projection records`);
  }
  async refresh() {
    const marker = await readProjectionMarker(this.config);
    if (!this.marker || marker.projection_id !== this.marker.projection_id) await this.load(marker);
  }
  async syncStatus() {
    return {
      projection_id: this.marker.projection_id,
      generated_at: typeof this.marker.generated_at === "string" ? this.marker.generated_at : null,
      record_count: typeof this.marker.record_count === "number" ? this.marker.record_count : this.records.length,
      policy: typeof this.marker.policy === "string" ? this.marker.policy : "unknown",
    };
  }
}

function boundedQuery(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("query must be a non-empty string");
  if (value.length > MAX_QUERY_CHARS) throw new Error(`query exceeds ${MAX_QUERY_CHARS} characters`);
  return value;
}

function boundedLimit(value) {
  const requested = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : MAX_RESULTS;
  return Math.max(1, Math.min(requested, MAX_RESULTS));
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
function formatResults(results) {
  if (!results.length) return "No matching memories.";
  return results.map((result, index) => {
    const record = result.record;
    // Summary is the explicit cloud projection boundary; never return raw_content.
    const summary = truncate(record.summary || "[summary unavailable]", MAX_SUMMARY_CHARS);
    return `${index + 1}. score=${result.score.toFixed(4)}\n   ${summary}`;
  }).join("\n");
}

function secureTokenMatches(value, expected) {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice("Bearer ".length));
  const target = Buffer.from(expected);
  return supplied.length === target.length && crypto.timingSafeEqual(supplied, target);
}

function applySecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

function json(res, status, body) {
  applySecurityHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function createRateLimiter(maxPerMinute = 120) {
  const windows = new Map();
  return (key) => {
    const now = Date.now();
    if (windows.size > 4_096) {
      for (const [candidate, timestamps] of windows) {
        if (!timestamps.some((timestamp) => now - timestamp < 60_000)) windows.delete(candidate);
      }
    }
    const current = windows.get(key);
    const entries = (current || []).filter((timestamp) => now - timestamp < 60_000);
    if (entries.length >= maxPerMinute) return false;
    entries.push(now);
    windows.set(key, entries);
    return true;
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--vault") options.vault = argv[++index];
    else if (arg === "--tenant") options.tenant = argv[++index];
    else if (arg === "--embeddings") options.embeddings = argv[++index];
    else if (arg === "--host") options.host = argv[++index];
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--token-env") options.tokenEnv = argv[++index];
    else if (arg === "--rate-limit") options.rateLimit = Number(argv[++index]);
  }
  return options;
}

function buildMcpServer(vault, config) {
  const mcp = new Server(
    { name: "starlight-memory-cloud", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: CLOUD_TOOLS }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments || {};
    await vault.refresh();
    switch (request.params.name) {
      case "memory_recall": {
        const query = boundedQuery(args.query);
        return text(formatResults(await vault.index.recall(query, boundedLimit(args.limit), config.tenant)));
      }
      case "memory_search": {
        const query = boundedQuery(args.query);
        return text(formatResults(vault.index.searchLexical(query, boundedLimit(args.limit), config.tenant)));
      }
      case "memory_sync_status":
        return text(JSON.stringify(await vault.syncStatus(), null, 2));
      default:
        return { content: [{ type: "text", text: `Unknown or disallowed cloud tool: ${request.params.name}` }], isError: true };
    }
  });
  return mcp;
}

async function readJsonBody(req) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    const error = new Error("request body too large");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isInitialize(body) {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => message && message.method === "initialize");
}

export async function main(argv = process.argv.slice(3)) {
  const options = parseArgs(argv);
  const tokenEnv = options.tokenEnv || "STARLIGHT_MEMORY_MCP_TOKEN";
  const token = process.env[tokenEnv];
  if (!token || token.length < 24) {
    throw new Error(`${tokenEnv} must contain a 24+ character bearer token; configure it through the secrets manager, never source control.`);
  }

  const config = await resolveConfig(options);
  const vault = new ReadOnlyVault(config);
  await vault.load();
  const host = options.host || "127.0.0.1";
  const port = Number.isFinite(options.port) ? options.port : 8787;
  const allowedHosts = (process.env.STARLIGHT_MEMORY_MCP_ALLOWED_HOSTS || `${host}:${port},localhost:${port}`)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  // One stateful MCP transport per authenticated client session. The SDK requires
  // fresh transports for independent clients; session routing preserves that rule
  // while allowing the Railway process to serve concurrent cloud agents safely.
  const transports = new Map();
  const allowed = createRateLimiter(Number.isFinite(options.rateLimit) ? options.rateLimit : 120);

  async function createTransport() {
    let transport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => transports.set(sessionId, transport),
      onsessionclosed: (sessionId) => transports.delete(sessionId),
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    transport.onerror = (error) => log("transport error", error instanceof Error ? error.message : String(error));
    await buildMcpServer(vault, config).connect(transport);
    return transport;
  }

  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    if (req.method === "GET" && req.url === "/healthz") {
      return json(res, 200, { status: "ok", service: "starlight-memory-cloud", mode: "read-only" });
    }
    if (req.url !== "/mcp") return json(res, 404, { error: "not_found" });
    if (!secureTokenMatches(req.headers.authorization, token)) return json(res, 401, { error: "unauthorized" });
    if (!allowed(req.socket.remoteAddress || "unknown")) return json(res, 429, { error: "rate_limited" });

    try {
      let body;
      if (req.method === "POST") body = await readJsonBody(req);
      const initialize = isInitialize(body);
      const sessionId = req.headers["mcp-session-id"];
      const transport = initialize
        ? await createTransport()
        : (typeof sessionId === "string" ? transports.get(sessionId) : undefined);
      if (!transport) return json(res, 400, { error: "missing_or_unknown_mcp_session" });
      await transport.handleRequest(req, res, body);
    } catch (error) {
      log("mcp request failed", error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        const status = typeof error?.statusCode === "number" ? error.statusCode : 500;
        json(res, status, { error: status === 413 ? "request_too_large" : "internal_error" });
      }
    }
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    log(`ready http://${host}:${actualPort}/mcp mode=read-only auth_env=${tokenEnv}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error("[starlight-memory-cloud] fatal", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
