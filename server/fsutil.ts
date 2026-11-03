import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";

export type ShouldSkip = (relativePath: string, name: string, isDirectory: boolean) => boolean;

const ALWAYS_SKIP_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const ALWAYS_SKIP_DIRS = new Set([".git", ".showcase", ".paseo", ".sync-tmp"]);

export function makeSkip(includeNodeModules: boolean): ShouldSkip {
  return (relativePath, name, isDirectory) => {
    if (isDirectory && ALWAYS_SKIP_DIRS.has(name)) return true;
    if (isDirectory && name === "node_modules" && !includeNodeModules) return true;
    if (isDirectory && name === ".sync-backup") return true;
    if (!isDirectory) {
      if (ALWAYS_SKIP_FILES.has(name)) return true;
      if (name.endsWith(".log")) return true;
    }
    return false;
  };
}

async function walk(
  root: string,
  skip: ShouldSkip,
  visit: (absolute: string, relativePath: string) => Promise<void>,
): Promise<void> {
  const stack: Array<{ dir: string; rel: string }> = [{ dir: root, rel: "" }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const entries = await fs.readdir(current.dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(current.dir, entry.name);
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skip(rel, entry.name, true)) continue;
        stack.push({ dir: absolute, rel });
      } else if (entry.isFile()) {
        if (skip(rel, entry.name, false)) continue;
        await visit(absolute, rel);
      }
    }
  }
}

export async function hashDirectory(root: string, skip: ShouldSkip): Promise<string> {
  const hash = createHash("sha256");
  const files: Array<{ absolute: string; relativePath: string }> = [];
  await walk(root, skip, async (absolute, relativePath) => {
    files.push({ absolute, relativePath });
  });
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  for (const file of files) {
    hash.update(file.relativePath.replaceAll(sep, "/"));
    hash.update("\0");
    hash.update(await fs.readFile(file.absolute));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function copyDirectory(
  source: string,
  destination: string,
  skip: ShouldSkip,
): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const jobs: Array<{ from: string; to: string }> = [];
  await walk(source, skip, async (absolute, relativePath) => {
    jobs.push({ from: absolute, to: join(destination, relativePath) });
  });
  for (const job of jobs) {
    await fs.mkdir(join(job.to, ".."), { recursive: true });
    await fs.copyFile(job.from, job.to);
  }
}

export async function replaceDirectory(
  source: string,
  destination: string,
  skip: ShouldSkip,
): Promise<void> {
  const temporary = `${destination}.sync-new`;
  await fs.rm(temporary, { recursive: true, force: true });
  await copyDirectory(source, temporary, skip);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(temporary, destination);
}

export async function removeEmptyDirs(_root: string): Promise<void> {
  // Reserved for future pruning; kept for API stability.
}

export function relativeTo(root: string, absolute: string): string {
  return relative(root, absolute).replaceAll(sep, "/");
}
