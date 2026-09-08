import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { loadVerifiedProjectionRecords, verifyProjectionAtoms } from "../src/mcp/cloud-gateway.mjs";
import { exportCloudProjection } from "../src/mcp/cloud-projection.mjs";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const signingKey = privateKey.export({ type: "pkcs8", format: "pem" });
const verificationKey = publicKey.export({ type: "spki", format: "pem" });

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(url, child, stderr = () => "") {
  const failureDetail = () => stderr().trim() ? `\nstderr: ${stderr().trim()}` : "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway exited before readiness: ${child.exitCode}${failureDetail()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`gateway did not become healthy${failureDetail()}`);
}

describe("cloud MCP gateway", () => {
  it("requires bearer auth and serves only summaries through a stateful remote MCP session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "starlight-cloud-gateway-"));
    const port = await freePort();
    const token = "test-token-longer-than-twenty-four-characters";
    const canonical = path.join(root, "canonical");
    const vault = path.join(root, "cloud-projection");
    const bin = path.resolve("bin/starlight-memory.mjs");
    let child;
    try {
      await mkdir(canonical, { recursive: true });
      await writeFile(path.join(canonical, "approved.md"), [
        "---", "memory_id: approved", "tenant_id: frank", "summary: Approved cloud-safe summary.",
        "normalized_fact: Canonical-only detail.", "privacy_class: public", "---", "", "raw canonical body must not leave the server", "",
      ].join("\n"), "utf8");
      await writeFile(path.join(canonical, "secret.md"), [
        "---", "memory_id: secret", "tenant_id: frank", "summary: Secret summary.",
        "privacy_class: secret", "---", "", "secret canonical body", "",
      ].join("\n"), "utf8");
      await exportCloudProjection({ sourceVault: canonical, outputVault: vault, tenant: "frank", signingKey });
      // A canonical-style sibling atom is intentionally outside the signed atoms/
      // set. The gateway must ignore it rather than recursively loading the vault.
      await writeFile(path.join(vault, "forged-sibling.md"), [
        "---", "memory_id: forged", "tenant_id: frank", "privacy_class: public", "summary: forged sibling must never be indexed", "---", "", "FORGED_CANONICAL_BODY", "",
      ].join("\n"), "utf8");
      let stderr = "";
      child = spawn(process.execPath, [bin, "mcp", "gateway", "--vault", vault, "--host", "127.0.0.1", "--port", String(port), "--embeddings", "off"], {
        env: { ...process.env, STARLIGHT_MEMORY_MCP_TOKEN: token, STARLIGHT_MEMORY_PROJECTION_PUBLIC_KEY: verificationKey },
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const endpoint = `http://127.0.0.1:${port}/mcp`;
      await waitFor(`http://127.0.0.1:${port}/healthz`, child, () => stderr);

      const unauthorized = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      assert.equal(unauthorized.status, 401);

      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      };
      const initialized = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
      });
      assert.equal(initialized.status, 200);
      const session = initialized.headers.get("mcp-session-id");
      assert.ok(session);
      assert.match(await initialized.text(), /starlight-memory-cloud/);

      const sessionHeaders = { ...headers, "Mcp-Session-Id": session, "Mcp-Protocol-Version": "2025-03-26" };
      const tools = await fetch(endpoint, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
      const toolsBody = await tools.text();
      assert.equal(tools.status, 200);
      assert.match(toolsBody, /memory_recall/);
      assert.doesNotMatch(toolsBody, /memory_remember|vault_read|vault_list/);

      const recall = await fetch(endpoint, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_recall", arguments: { query: "cloud-safe", limit: 3 } } }) });
      const recallBody = await recall.text();
      assert.equal(recall.status, 200);
      assert.match(recallBody, /Approved cloud-safe summary\./);
      assert.doesNotMatch(recallBody, /raw canonical body|Canonical-only detail|Secret summary|secret canonical body|forged sibling|FORGED_CANONICAL_BODY/);

      const forged = await fetch(endpoint, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_search", arguments: { query: "forged sibling", limit: 3 } } }) });
      const forgedBody = await forged.text();
      assert.equal(forged.status, 200);
      assert.doesNotMatch(forgedBody, /forged sibling|FORGED_CANONICAL_BODY/);
    } finally {
      if (child && child.exitCode === null) {
        child.kill();
        await once(child, "exit");
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses an unmarked canonical vault before opening an HTTP listener", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "starlight-cloud-unmarked-"));
    const vault = path.join(root, "canonical");
    const token = "test-token-longer-than-twenty-four-characters";
    const bin = path.resolve("bin/starlight-memory.mjs");
    try {
      await mkdir(vault, { recursive: true });
      const child = spawn(process.execPath, [bin, "mcp", "gateway", "--vault", vault, "--embeddings", "off"], {
        env: { ...process.env, STARLIGHT_MEMORY_MCP_TOKEN: token, STARLIGHT_MEMORY_PROJECTION_PUBLIC_KEY: verificationKey },
        stdio: "ignore",
      });
      const [code] = await once(child, "exit");
      assert.notEqual(code, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses a signed marker when a projection atom is changed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "starlight-cloud-tampered-"));
    const canonical = path.join(root, "canonical");
    const vault = path.join(root, "cloud-projection");
    const token = "test-token-longer-than-twenty-four-characters";
    const bin = path.resolve("bin/starlight-memory.mjs");
    try {
      await mkdir(canonical, { recursive: true });
      await writeFile(path.join(canonical, "approved.md"), [
        "---", "memory_id: approved", "tenant_id: frank", "summary: Approved cloud-safe summary.",
        "privacy_class: public", "---", "", "canonical body", "",
      ].join("\n"), "utf8");
      await exportCloudProjection({ sourceVault: canonical, outputVault: vault, tenant: "frank", signingKey });
      const [atom] = await readdir(path.join(vault, "atoms"));
      await writeFile(path.join(vault, "atoms", atom), "tampered atom", "utf8");
      const child = spawn(process.execPath, [bin, "mcp", "gateway", "--vault", vault, "--embeddings", "off"], {
        env: { ...process.env, STARLIGHT_MEMORY_MCP_TOKEN: token, STARLIGHT_MEMORY_PROJECTION_PUBLIC_KEY: verificationKey },
        stdio: "ignore",
      });
      const [code] = await once(child, "exit");
      assert.notEqual(code, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("indexes the verified byte snapshot even if an atom changes afterward", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "starlight-cloud-snapshot-"));
    const canonical = path.join(root, "canonical");
    const vault = path.join(root, "cloud-projection");
    try {
      await mkdir(canonical, { recursive: true });
      await writeFile(path.join(canonical, "approved.md"), [
        "---", "memory_id: approved", "tenant_id: frank", "summary: Signed summary.", "privacy_class: public", "---", "", "canonical body", "",
      ].join("\n"), "utf8");
      await exportCloudProjection({ sourceVault: canonical, outputVault: vault, tenant: "frank", signingKey });
      const marker = JSON.parse(await readFile(path.join(vault, ".starlight-cloud-projection.json"), "utf8"));
      const config = { vaultRoot: vault, tenant: "frank", verificationKey };
      const verifiedAtoms = await verifyProjectionAtoms(config, marker);
      const [atom] = await readdir(path.join(vault, "atoms"));
      await writeFile(path.join(vault, "atoms", atom), [
        "---", "memory_id: forged", "tenant_id: frank", "summary: forged after verification", "privacy_class: public", "---", "", "FORGED_AFTER_VERIFICATION", "",
      ].join("\n"), "utf8");
      const records = await loadVerifiedProjectionRecords(config, verifiedAtoms);
      assert.equal(records.length, 1);
      assert.equal(records[0].summary, "Signed summary.");
      assert.doesNotMatch(records[0].raw_content, /FORGED_AFTER_VERIFICATION/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
