# Starlight Memory as a System

Starlight Memory is the estate's **memory operating system**: a sovereign canonical store, a continuously-benchmarked **observatory** of coding-agent memory architectures, and the orchestration engine used to install and maintain the memory stack. Any agent or workspace in the Starlight ecosystem inherits a secure, validated, cross-agent, and cross-device memory experience by default.

---

## 1. The Three Layers

1. **Authority (`local_core`)**:
   - **Role**: System of record. Sovereign, filesystem-native markdown atoms with a hybrid BM25 + embedding index.
   - **Properties**: Owns `memory_id`, provenance, privacy class, retention, and trust. Never leaves the local machine in raw form.
2. **Observatory (The Adapter Registry)**:
   - **Role**: Curated, evidence-tagged catalog of memory providers (Hindsight, Honcho, Mem0, Zep, Letta, cognee) with details on performance, licensing, cost, privacy, and benchmarks.
   - **Properties**: Accessible in `tools/memory-observatory.mjs` and the `MemoryProvider` adapters in `src/`.
3. **Orchestrator (The Sync & Deployment Engine)**:
   - **Role**: Ranks the registry based on resource profiles (RAM/CPU via `pp` audit) and requirements, wires the MCP into all active harnesses, and syncs data.

---

## 2. Cross-Agent MCP Integration (July 2026 Ground Truth)

The memory system is wired as a single, canonical MCP server (`src/mcp/server.mjs`) serving all active coding harnesses on your local machine.

- **Unified Vault**: All harnesses point to a single local Git vault. Its location is recorded in `~/.starlight/memory/vault.json` by `starlight-memory wire` / `register`, and every entry point (server, doctor, eval) resolves it from there; on this machine that is `starlight/repos/starlight-memory-vault`. A second checkout of the same remote is a defect `doctor` reports.
- **Client Configurations**:
  - **Claude**: `claude mcp add` (connected)
  - **Codex**: `~/.codex/config.toml`
  - **Grok**: `~/.grok/config.toml`
  - **Antigravity/Gemini**: `~/.gemini/config/mcp_config.json`
- **Exposed Tools**: `memory_recall` (hybrid semantic search), `memory_search` (BM25 keyword search), and `memory_remember` (write path).

---

## 3. Sync & Backup Architecture (Git-Vault Doctrine)

To prevent data loss and support multiple machines without cloud dependency:

- **NTFS Junction Links**: Memory directories across your workspace environments are junction-linked (symlinked) directly to subfolders in the private `starlight-memory-vault` repository. Claude and other agents write to project-local paths, but the bytes live in the central vault.
- **Git-Vault vs. Syncthing**:
  - Syncthing was **rejected** due to its silent "last-write-wins" conflict resolution and lack of history/auditing.
  - Plain Git is used for sync, ensuring explicit merges, version control, and clear audit logs.
- **CLI Commands (`@starlight-intelligence/memory`)**:
  - `wire` / `unwire` — Sets up junctions on Windows/POSIX.
  - `sync` — Syncs the vault with your git remotes.
- **Auto-Sync Hook Blocker**:
  - Automated pull/push Git hooks are **blocked** by LLM self-modification guards (preventing unapproved commits of private memory).
  - **Solution**: Schedule the sync command via Task Scheduler (Windows) or Cron (macOS) running outside the agent runtime:
    ```powershell
    npx @starlight-intelligence/memory sync
    ```

---

## 4. The 4-Tier Memory Adapter Matrix

| Adapter | Role | Best For | Storage Backend | Data Privacy | License |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`local_core`** *(Canonical)* | **System of Record** | Default everyday use, Git-vaulting, manual reviews | Plaintext Markdown + Git | 🔒 **100% Local** (No cloud egress) | MIT (Permissive) |
| **`hindsight`** *(Vectorize.io)* | **Recall Accelerator** | High-dimensional semantic search, complex research scans | Local Vector DB + Cloud Index | ⚠️ **Hybrid** (Redacted metadata to cloud) | Proprietary (SaaS) |
| **`honcho`** *(Plastic Labs)* | **Theory-of-Mind (ToM)** | Personalization, style alignment, learning cognitive preferences | Local SQLite Graph DB | 🔒 **100% Local** | AGPL-3.0 (Copyleft) |
| **`mem0`** | **Cheap Mirror** | Third-party compatibility, quick integrations | SQLite / ChromaDB | 🔒 **100% Local** | Apache-2.0 |

### Licensing Warnings:
- **Honcho** is licensed under **AGPL-3.0** (copyleft). Keep it strictly as an opt-in, non-default provider to avoid legal pollution in open-source repositories.

---

## 5. Local Database Optimization & On-Device RAG

To compress database size and run semantic RAG locally with zero cloud costs:

1. **AgentDB (HNSW + Quantization)**:
   - Implements **4x–32x quantization** (shrinking memory database size up to 32x) and **HNSW Indexing** (150x faster vector search).
   - Allows agents to scan thousands of memory records locally without CPU/RAM bottlenecks.
2. **Google ScaNN (SIMD registers)**:
   - An open-source vector similarity search library.
   - Ideal for in-memory, register-level search optimizations on CPU SIMD units, keeping nearest neighbor lookups fast without loading indexes into heavy RAM pools.
