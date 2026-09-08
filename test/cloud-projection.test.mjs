import assert from "node:assert/strict";
import { describe, it } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import { exportCloudProjection } from "../src/mcp/cloud-projection.mjs";

const { privateKey: signingKey } = crypto.generateKeyPairSync("ed25519");

describe("cloud projection exporter", () => {
  it("exports only approved summaries and never canonical raw bodies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "starlight-cloud-projection-"));
    const source = path.join(root, "canonical");
    const output = path.join(root, "cloud");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "shareable.md"), [
        "---", "memory_id: shareable", "tenant_id: frank", "summary: Approved cloud summary.",
        "normalized_fact: Canonical-only internal detail.", "vault: private-ops", "tags: [sensitive-tag]",
        "privacy_class: public", "---", "", "canonical raw content must not be copied", "",
      ].join("\n"), "utf8");
      await writeFile(path.join(source, "shareable-private.md"), [
        "---", "memory_id: shareable_private", "tenant_id: frank", "summary: Requires explicit approval.",
        "privacy_class: private-shareable", "---", "", "shareable raw content", "",
      ].join("\n"), "utf8");
      await writeFile(path.join(source, "secret.md"), [
        "---", "memory_id: secret", "tenant_id: frank", "summary: Secret summary.",
        "privacy_class: secret", "---", "", "secret raw content", "",
      ].join("\n"), "utf8");

      const result = await exportCloudProjection({ sourceVault: source, outputVault: output, tenant: "frank", signingKey });
      assert.equal(result.projected_records, 1);
      assert.equal(result.excluded_records, 2);
      assert.match(result.projection_id, /^[a-f0-9]{64}$/);
      const marker = JSON.parse(await readFile(path.join(output, ".starlight-cloud-projection.json"), "utf8"));
      assert.match(marker.atoms_sha256, /^[a-f0-9]{64}$/);
      assert.equal(marker.signature_alg, "ed25519");
      const atomFiles = await readdir(path.join(output, "atoms"));
      assert.equal(atomFiles.length, 1);
      const projected = await readFile(path.join(output, "atoms", atomFiles[0]), "utf8");
      assert.match(projected, /Approved cloud summary\./);
      assert.doesNotMatch(projected, /canonical raw content|Canonical-only internal detail|private-ops|sensitive-tag/);
      await assert.rejects(readFile(path.join(output, "atoms", "secret.md"), "utf8"));
      await assert.rejects(readFile(path.join(output, "atoms", "shareable_private.md"), "utf8"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("uses collision-resistant projection filenames for distinct canonical memory IDs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "starlight-cloud-projection-collision-"));
    const source = path.join(root, "source");
    const output = path.join(root, "cloud");
    try {
      await mkdir(source, { recursive: true });
      for (const [index, id] of ["a+b", "a=b"].entries()) {
        await writeFile(path.join(source, `memory-${index}.md`), [
          "---", `memory_id: ${id}`, "tenant_id: frank", `summary: Summary ${id}.`,
          "privacy_class: public", "---", "", "canonical raw body", "",
        ].join("\n"), "utf8");
      }
      const result = await exportCloudProjection({ sourceVault: source, outputVault: output, tenant: "frank", signingKey });
      assert.equal(result.projected_records, 2);
      const atomFiles = await readdir(path.join(output, "atoms"));
      assert.equal(new Set(atomFiles).size, 2);
      assert.equal(atomFiles.length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
