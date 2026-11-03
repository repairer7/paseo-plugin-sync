import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * Host-local state for the sync plugin (clone, token, backups, config).
 *
 * It lives below `<home>/plugins` so Paseo's plugin compiler can resolve the
 * host dependency root, and so `~/.paseo` does not grow extra top-level dirs.
 * Everything here is state, not installed plugin code.
 */
export function stateDir(home: string): string {
  return join(home, "plugins", ".plugin-sync");
}

/**
 * Move state written by 0.1.x (`<home>/plugin-sync`) into the new location.
 * Old `staging/` is intentionally skipped: it held plugin installs and is
 * migrated separately by moving each plugin to `<home>/plugins/<id>`.
 */
export async function migrateStateDir(home: string): Promise<void> {
  const next = stateDir(home);
  const legacy = join(home, "plugin-sync");
  await fs.mkdir(next, { recursive: true });
  if (!existsSync(legacy) || legacy === next) return;

  let entries: string[] = [];
  try {
    entries = await fs.readdir(legacy);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "staging") continue;
    const from = join(legacy, entry);
    const to = join(next, entry);
    if (existsSync(to)) continue;
    try {
      await fs.rename(from, to);
    } catch {
      try {
        await fs.cp(from, to, { recursive: true });
        await fs.rm(from, { recursive: true, force: true });
      } catch {
        // Leaving the legacy copy in place is harmless; the new path wins.
      }
    }
  }
  try {
    const left = await fs.readdir(legacy);
    if (left.length === 0) await fs.rm(legacy, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
