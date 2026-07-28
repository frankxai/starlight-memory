# Cloud Projection Boundary

> **Status: locally verified design path, not a hosted service.** This document describes how a permitted remote MCP client can recall a **derived, signed, read-only** memory projection. It is not evidence of a production deployment, public endpoint, OAuth edge, or remote-client rollout.

The cloud gateway gives remote MCP clients **read-only access to a curated Starlight Memory projection**. It is deliberately separate from the local canonical vault.

## Security boundary

```text
SIS/local_core canonical vault
  └─ starlight-memory mcp export-cloud
       └─ cloud projection: public summaries only by default
            └─ private Railway volume/repository
                 └─ authenticated HTTPS Streamable HTTP MCP gateway
                      └─ cloud Claude / permitted remote agents
```

The gateway starts only when the projection marker is tenant-matched, **Ed25519-signed**, and its signed atom-set hash matches the exact flat `atoms/` projection set it indexes. The exporter signs with `STARLIGHT_MEMORY_PROJECTION_SIGNING_KEY`; the gateway receives only `STARLIGHT_MEMORY_PROJECTION_PUBLIC_KEY`. It indexes only reclassified `public` projection atoms. It never exposes `vault_read`, `vault_list`, `memory_remember`, or `memory_forget`. It returns summary text only; it never carries canonical raw content, normalized facts, provider references, relations, paths, or source metadata. `private`, `secret`, and `regulated` records are excluded; `private-shareable` is also denied unless the exporter receives an explicit policy-approved opt-in.

## Local verification

Node **20+** is required. The gateway only starts with an explicit `--vault` that is a generated Starlight cloud projection.

```bash
# The exporter has the Ed25519 private key; keep it out of Railway and clients.
export STARLIGHT_MEMORY_PROJECTION_SIGNING_KEY="$(cat /secure/projection-ed25519-private.pem)"

# By default the export contains PUBLIC summaries only. private-shareable data
# requires an explicit, tenant-policy-approved flag and must never be enabled
# merely because a cloud service exists.
starlight-memory mcp export-cloud \
  --vault /path/to/canonical-vault \
  --out /path/to/cloud-projection \
  --tenant frank

# The static bearer mode below is for local integration and break-glass testing.
# A public deployment requires an OIDC/OAuth edge that validates short-lived,
# audience-bound tokens before this gateway receives a request.
# Railway gateway gets only the matching public verification key.
export STARLIGHT_MEMORY_PROJECTION_PUBLIC_KEY="$(cat /secure/projection-ed25519-public.pem)"
export STARLIGHT_MEMORY_MCP_TOKEN='a-long-random-secret-at-least-24-characters'
export STARLIGHT_MEMORY_MCP_ALLOWED_HOSTS='memory.example.com'

starlight-memory mcp gateway \
  --vault /path/to/cloud-projection \
  --host 0.0.0.0 \
  --port "${PORT:-8787}" \
  --embeddings off
```

Health endpoint:

```text
GET /healthz
```

Remote MCP endpoint:

```text
POST/GET/DELETE https://memory.example.com/mcp
Authorization: Bearer <STARLIGHT_MEMORY_MCP_TOKEN>
```

The MCP client must retain the `Mcp-Session-Id` returned on initialization and send it with subsequent requests, plus the negotiated `Mcp-Protocol-Version` header.

## Railway deployment gate

Before production deployment, all of these must be true:

- [ ] The production gateway image is built with `npm ci --omit=optional` and `--embeddings off`; `npm audit --omit=dev --omit=optional` has no unresolved high/critical vulnerabilities. Embedding-capable images require their own reviewed dependency exception or remediation.
- [ ] The service receives a **projection vault**, not the canonical SIS vault.
- [ ] The projection has a controlled one-way **signed, idempotent** sync mechanism and is re-exported after revocation/deletion.
- [ ] Sync publishes a complete projection to a fresh snapshot, verifies its signed manifest and atom hash, then atomically switches the gateway to a **read-only** snapshot; never mutate mounted atoms in place.
- [ ] An OIDC/OAuth authorization-code-with-PKCE edge validates issuer, audience, signature, expiry, and `memory:recall` scope; static bearer mode is disabled for public traffic.
- [ ] `STARLIGHT_MEMORY_MCP_TOKEN` is only a local-test/break-glass secret in Infisical/Railway variables, never an embedded client credential.
- [ ] `STARLIGHT_MEMORY_MCP_ALLOWED_HOSTS` is set to the exact public Railway custom domain (including port only when nonstandard).
- [ ] Railway healthcheck is `/healthz`; the service runs only one gateway process per deployment.
- [ ] The custom domain terminates TLS and is protected by Railway/Cloudflare edge controls.
- [ ] At least one real remote MCP client passes initialize → tools/list → memory_recall without seeing raw vault content.

A minimal Railway start command is:

```bash
node bin/starlight-memory.mjs mcp gateway \
  --vault "${STARLIGHT_MEMORY_CLOUD_VAULT:-/data/cloud-projection}" \
  --host 0.0.0.0 \
  --port "${PORT:-8787}" \
  --embeddings off
```

Do **not** make a cloud write endpoint part of the first release. Canonical writes stay local-first through SIS; cloud writes require a separately audited signed event-ingest path, provenance enforcement, and explicit tenant authorization.

## Graphiti relationship

Graphiti is optional and stays behind `GraphitiProjectionProvider` in the Starlight router:

- `local_core` remains authoritative.
- Graphiti is a shared daemon/remote graph accelerator, never an agent-local runtime.
- Graphiti receives only normalized facts or summaries and blocks `secret`/`regulated` data by default.
- Tenant policy must explicitly select `graph_provider: "graphiti"`; provider defaults remain an evaluation decision, not a documentation claim.
