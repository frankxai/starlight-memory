// Builds a deliberately sanitized, cloud-safe memory projection.
// The output is an independent vault: it contains only explicitly approved
// summary text, never canonical raw_content or normalized facts.
import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { loadVault, recordToFile } from "./vault-store.mjs";

const MARKER = ".starlight-cloud-projection.json";
const PUBLIC_ONLY = new Set(["public"]);

export async function exportCloudProjection({
  sourceVault,
  outputVault,
  tenant = "frank",
  allowPrivateShareable = false,
  signingKey,
}) {
  if (!sourceVault || !outputVault || !signingKey) throw new Error("sourceVault, outputVault, and an Ed25519 signingKey are required");
  const source = path.resolve(sourceVault);
  const output = path.resolve(outputVault);
  if (source === output) throw new Error("cloud projection output must be a separate vault, never the canonical vault");

  const markerPath = path.join(output, MARKER);
  if (existsSync(output) && !existsSync(markerPath)) {
    throw new Error(`refusing to overwrite ${output}: it is not a Starlight-managed cloud projection`);
  }

  const records = await loadVault(source, tenant);
  const allowedPrivacy = allowPrivateShareable
    ? new Set(["public", "private-shareable"])
    : PUBLIC_ONLY;
  const projected = records
    .filter((record) => record.tenant_id === tenant)
    .filter((record) => allowedPrivacy.has(record.privacy_class))
    .map((record) => ({ record, content: record.summary || "" }))
    .filter(({ content }) => content.trim());

  // The output is solely tool-generated, guarded by MARKER above. Clearing it
  // makes redactions/deletions propagate on the next deployment sync.
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(path.join(output, "atoms"), { recursive: true });
  const generatedAt = new Date().toISOString();
  const projectionId = crypto
    .createHash("sha256")
    .update(projected
      .map(({ record, content }) => `${record.memory_id}\u0000${content}`)
      .sort()
      .join("\n"))
    .digest("hex");
  const atomEntries = projected.map(({ record, content }) => {
    const cloudRecord = {
      // Strict allowlist: this derived vault must not inherit canonical metadata,
      // provenance, relations, provider refs, paths, or normalized facts.
      memory_id: record.memory_id,
      tenant_id: tenant,
      raw_content: content,
      summary: content,
      memory_type: "semantic",
      importance: 0.5,
      confidence: 0.8,
      trust: 0.7,
      privacy_class: "public",
      retention_policy: "cloud-projection",
      tags: [],
      time_range: { observed_at: generatedAt },
    };
    return {
      relativePath: `atoms/${safeFileName(record.memory_id)}.md`,
      content: recordToFile(cloudRecord),
    };
  });
  const atomsSha256 = digestAtoms(atomEntries);
  const manifest = {
    format: 1,
    projection_id: projectionId,
    atoms_sha256: atomsSha256,
    tenant,
    generated_at: generatedAt,
    record_count: atomEntries.length,
    source: "starlight-memory",
    policy: allowPrivateShareable
      ? "public-and-explicitly-enabled-private-shareable-summaries-only"
      : "public-summaries-only",
  };
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(manifest)), signingKey).toString("base64");
  for (const atom of atomEntries) await fs.writeFile(path.join(output, atom.relativePath), atom.content, "utf8");
  // The marker is written last: a reader can trust it only after every atom is present.
  await fs.writeFile(markerPath, JSON.stringify({
    ...manifest,
    signature_alg: "ed25519",
    signature,
  }, null, 2) + "\n", "utf8");

  return {
    source_records: records.length,
    projected_records: projected.length,
    excluded_records: records.length - projected.length,
    projection_id: projectionId,
    generated_at: generatedAt,
    output_vault: output,
  };
}

function digestAtoms(entries) {
  const hash = crypto.createHash("sha256");
  for (const { relativePath, content } of [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(relativePath, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(content, "utf8");
    hash.update("\u0000", "utf8");
  }
  return hash.digest("hex");
}

function safeFileName(id) {
  const normalized = String(id).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "memory";
  const suffix = crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 12);
  return `${normalized}-${suffix}`;
}
