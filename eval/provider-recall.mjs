#!/usr/bin/env node
/**
 * Provider recall comparison.
 *
 * Offline is the default: deterministic, injected mock clients exercise the
 * complete write/recall/scoring path without API keys. Pass --live to create
 * HTTP clients from provider-specific environment variables.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = process.argv.includes("--live");
const TENANT = `provider-eval-${Date.now()}`;
const SCORECARD_JSON = path.resolve(
  process.env.PROVIDER_EVAL_JSON ?? path.join(HERE, "provider-recall-scorecard.json"),
);
const SCORECARD_MD = path.resolve(
  process.env.PROVIDER_EVAL_MARKDOWN ?? path.join(HERE, "provider-recall-scorecard.md"),
);

async function loadEvalSet() {
  const raw = await fs.readFile(path.join(HERE, "eval-set.jsonl"), "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildCorpus(evalSet) {
  const byId = new Map();
  for (const item of evalSet) {
    for (const id of item.relevant) {
      const previous = byId.get(id);
      if (previous) previous.content += ` ${item.query}`;
      else byId.set(id, { id, content: item.query });
    }
  }
  return [...byId.values()];
}

class MockProviderClient {
  constructor(name) {
    this.name = name;
    this.records = new Map();
  }

  async add(records) {
    for (const record of records) this.records.set(record.id, record);
  }

  async search(query, limit) {
    const queryTerms = terms(query);
    return [...this.records.values()]
      .map((record) => {
        const documentTerms = terms(record.content);
        const overlap = queryTerms.filter((term) => documentTerms.includes(term));
        return {
          id: record.id,
          content: record.content,
          score: overlap.length / Math.max(1, queryTerms.length),
        };
      })
      .filter((record) => record.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
}

class HttpProviderClient {
  constructor({ name, baseUrl, apiKey, addPath, searchPath, headers = {} }) {
    if (!baseUrl) throw new Error(`${name}: base URL is required in --live mode`);
    if (!apiKey) throw new Error(`${name}: API key is required in --live mode`);
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.addPath = addPath;
    this.searchPath = searchPath;
    this.headers = headers;
  }

  async request(route, body) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${this.name} HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  async add(records) {
    await this.request(this.addPath, {
      tenant_id: TENANT,
      user_id: TENANT,
      session_id: TENANT,
      messages: records.map((record) => ({
        id: record.id,
        role: "user",
        content: record.content,
        metadata: { sis_memory_id: record.id, tenant_id: TENANT },
      })),
      records,
    });
  }

  async search(query, limit) {
    const payload = await this.request(this.searchPath, {
      tenant_id: TENANT,
      user_id: TENANT,
      session_id: TENANT,
      peer_id: TENANT,
      query,
      limit,
    });
    const rows =
      payload.results ??
      payload.memories ??
      payload.items ??
      payload.data?.results ??
      payload.data?.memories ??
      [];
    return rows.map((row, index) => ({
      id:
        row.metadata?.sis_memory_id ??
        row.sis_memory_id ??
        row.memory_id ??
        row.id ??
        `${this.name}_${index}`,
      content: row.content ?? row.text ?? row.memory ?? "",
      score: Number(row.score ?? row.relevance ?? row.similarity ?? 0),
    }));
  }
}

function createMockClients() {
  return Object.fromEntries(
    ["local-core", "mem0", "hindsight", "honcho"].map((name) => [
      name,
      new MockProviderClient(name),
    ]),
  );
}

function createLiveClients() {
  return {
    // local-core stays embedded and dependency-free in a live comparison.
    "local-core": new MockProviderClient("local-core"),
    mem0: new HttpProviderClient({
      name: "mem0",
      baseUrl: process.env.MEM0_BASE_URL ?? "https://api.mem0.ai/v1",
      apiKey: process.env.MEM0_API_KEY,
      addPath: process.env.MEM0_ADD_PATH ?? "/memories/",
      searchPath: process.env.MEM0_SEARCH_PATH ?? "/memories/search/",
    }),
    hindsight: new HttpProviderClient({
      name: "hindsight",
      baseUrl: process.env.HINDSIGHT_BASE_URL,
      apiKey: process.env.HINDSIGHT_API_KEY,
      addPath: process.env.HINDSIGHT_ADD_PATH ?? "/v1/memories",
      searchPath: process.env.HINDSIGHT_SEARCH_PATH ?? "/v1/recall",
    }),
    honcho: new HttpProviderClient({
      name: "honcho",
      baseUrl: process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev",
      apiKey: process.env.HONCHO_API_KEY,
      addPath: process.env.HONCHO_ADD_PATH ?? "/v3/messages",
      searchPath: process.env.HONCHO_SEARCH_PATH ?? "/v3/peer/chat",
    }),
  };
}

function metricsFor(returnedIds, relevantIds) {
  const relevant = new Set(relevantIds);
  const top5 = returnedIds.slice(0, 5);
  const top10 = returnedIds.slice(0, 10);
  const hits = (rows) => rows.filter((id) => relevant.has(id)).length;
  const firstRelevant = top10.findIndex((id) => relevant.has(id));
  return {
    recall5: hits(top5) / Math.max(1, relevant.size),
    recall10: hits(top10) / Math.max(1, relevant.size),
    precision10: hits(top10) / 10,
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
  };
}

async function scoreProvider(name, client, corpus, evalSet) {
  const writeStarted = performance.now();
  await client.add(corpus);
  const writeMs = performance.now() - writeStarted;
  const perQuery = [];
  const recallLatencies = [];

  for (const item of evalSet) {
    const started = performance.now();
    const results = await client.search(item.query, 10);
    recallLatencies.push(performance.now() - started);
    perQuery.push(metricsFor(results.map((result) => result.id), item.relevant));
  }

  return {
    provider: name,
    "recall@5": round(mean(perQuery.map((row) => row.recall5))),
    "recall@10": round(mean(perQuery.map((row) => row.recall10))),
    "precision@10": round(mean(perQuery.map((row) => row.precision10))),
    MRR: round(mean(perQuery.map((row) => row.reciprocalRank))),
    latency_ms: {
      write_total: round(writeMs, 2),
      recall_p50: round(percentile(recallLatencies, 50), 2),
      recall_p95: round(percentile(recallLatencies, 95), 2),
      write_plus_recall_p50: round(writeMs + percentile(recallLatencies, 50), 2),
    },
  };
}

function markdownFor(scorecard) {
  const header =
    "| Provider | Recall@5 | Recall@10 | Precision@10 | MRR | Write ms | Recall p50 ms | Recall p95 ms |";
  const divider = "|---|---:|---:|---:|---:|---:|---:|---:|";
  const rows = scorecard.results.map((result) =>
    `| ${result.provider} | ${result["recall@5"]} | ${result["recall@10"]} | ${result["precision@10"]} | ${result.MRR} | ${result.latency_ms.write_total} | ${result.latency_ms.recall_p50} | ${result.latency_ms.recall_p95} |`
  );
  return [
    "# Provider recall scorecard",
    "",
    `Mode: **${scorecard.mode}** · Queries: ${scorecard.queries} · Corpus records: ${scorecard.corpus_records}`,
    "",
    header,
    divider,
    ...rows,
    "",
    "Latency measures one corpus write followed by per-query recall. Mock mode is",
    "an offline contract/regression baseline, not a vendor-quality benchmark.",
    "",
  ].join("\n");
}

async function main() {
  const evalSet = await loadEvalSet();
  const corpus = buildCorpus(evalSet);
  const clients = LIVE ? createLiveClients() : createMockClients();
  const results = [];

  for (const name of ["local-core", "mem0", "hindsight", "honcho"]) {
    results.push(await scoreProvider(name, clients[name], corpus, evalSet));
  }

  const scorecard = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode: LIVE ? "live" : "offline-mock",
    tenant_id: TENANT,
    queries: evalSet.length,
    corpus_records: corpus.length,
    metrics: ["recall@5", "recall@10", "precision@10", "MRR", "write+recall latency"],
    results,
  };
  const markdown = markdownFor(scorecard);
  await fs.writeFile(SCORECARD_JSON, `${JSON.stringify(scorecard, null, 2)}\n`);
  await fs.writeFile(SCORECARD_MD, markdown);
  console.log(markdown);
  console.log(`JSON: ${SCORECARD_JSON}`);
  console.log(`Markdown: ${SCORECARD_MD}`);
}

function terms(value) {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((percentileValue / 100) * sorted.length),
  );
  return sorted[index] ?? 0;
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
