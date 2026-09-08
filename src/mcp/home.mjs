// home — where starlight-memory keeps its own state (audit log, embedding
// cache, and the pointer to the canonical vault). One place, so a test can
// point it at a temp dir and stop writing into the user's real audit log.
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MEMORY_HOME = process.env.STARLIGHT_MEMORY_HOME || path.join(os.homedir(), '.starlight', 'memory');
export const VAULT_POINTER = path.join(MEMORY_HOME, 'vault.json');
const CONFIG_NAMES = ['starlight-memory.config.json', '.starlight-memory.json'];

/**
 * The vault every entry point agrees on. Two vaults with the same remote once
 * diverged for five weeks because the server defaulted to ~/starlight-memory-vault
 * while the junctions pointed elsewhere — the server indexed a frozen copy and
 * wrote atoms nowhere any harness read.
 *
 * Precedence: explicit flag → config in cwd → pointer written by `wire`/`register`
 * → env → legacy home default. Returns {vault, source} so doctor can say which.
 */
export function resolveVault(explicit) {
  if (explicit) return { vault: path.resolve(explicit), source: 'flag' };
  for (const c of CONFIG_NAMES) {
    const p = path.resolve(c);
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      return { vault: path.resolve(path.dirname(p), (cfg.mcp && cfg.mcp.vaultRoot) || cfg.vault || '.'), source: `config ${p}`, config: cfg };
    } catch { /* an unreadable config is reported by doctor's vault check */ }
    break;
  }
  if (existsSync(VAULT_POINTER)) {
    try {
      const ptr = JSON.parse(readFileSync(VAULT_POINTER, 'utf8'));
      if (ptr.vault) return { vault: path.resolve(ptr.vault), source: `pointer ${VAULT_POINTER}` };
    } catch { /* fall through */ }
  }
  if (process.env.STARLIGHT_MEMORY_VAULT) return { vault: path.resolve(process.env.STARLIGHT_MEMORY_VAULT), source: 'env STARLIGHT_MEMORY_VAULT' };
  return { vault: path.join(os.homedir(), 'starlight-memory-vault'), source: 'legacy default' };
}

export async function writeVaultPointer(vault) {
  await fs.mkdir(MEMORY_HOME, { recursive: true });
  const body = JSON.stringify({ vault: path.resolve(vault), written_at: new Date().toISOString(), by: `${os.hostname()}:${process.pid}` }, null, 2) + '\n';
  await fs.writeFile(VAULT_POINTER, body, 'utf8');
  return VAULT_POINTER;
}
