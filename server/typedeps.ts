import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";

const HOST_PACKAGES = ["@getpaseo/client", "@getpaseo/plugin"];

export interface TypeDepResult {
  installed: string[];
  missing: string[];
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function resolvableFrom(start: string, name: string): boolean {
  let current = start;
  for (;;) {
    if (existsSync(join(current, "node_modules", ...name.split("/"), "package.json"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function sourceImports(directory: string): Promise<Set<string>> {
  const found = new Set<string>();
  const roots = ["client", "server", "shared"];
  const queue: string[] = [];
  for (const root of roots) queue.push(join(directory, root));
  try {
    for (const file of await fs.readdir(directory)) {
      if (/^index\.(client|server)\.tsx?$/.test(file)) queue.push(join(directory, file));
    }
  } catch {
    return found;
  }
  while (queue.length > 0 && found.size < HOST_PACKAGES.length) {
    const current = queue.pop();
    if (!current) break;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!/\.(?:[cm]?ts|tsx|js|jsx)$/.test(entry.name)) continue;
      try {
        const text = await fs.readFile(absolute, "utf8");
        for (const name of HOST_PACKAGES) {
          if (text.includes(name)) found.add(name);
        }
      } catch {
        // ignore unreadable files
      }
    }
  }
  return found;
}

async function pickVersion(
  pluginDirectory: string,
  home: string,
  name: string,
): Promise<string> {
  const plugin = await readJson(join(pluginDirectory, "package.json"));
  const host = await readJson(join(home, "plugins", "package.json"));
  const pluginDev = stringRecord(plugin?.devDependencies);
  const pluginDeps = stringRecord(plugin?.dependencies);
  const hostDeps = stringRecord(host?.dependencies);
  const sibling = name === "@getpaseo/client" ? "@getpaseo/plugin" : "@getpaseo/client";
  return (
    pluginDev[name] ??
    pluginDeps[name] ??
    hostDeps[name] ??
    pluginDev[sibling] ??
    pluginDeps[sibling] ??
    hostDeps[sibling] ??
    "latest"
  );
}

function npmInstall(directory: string, specs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      [
        "install",
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...specs,
      ],
      { cwd: directory, shell: process.platform === "win32", windowsHide: true },
    );
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("npm install 类型依赖超时"));
    }, 300_000);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm install 类型依赖失败 (${code}): ${stderr.slice(0, 500)}`));
    });
  });
}

/**
 * Make sure the plugin compiler's mandatory type-only imports can resolve.
 *
 * The compiler resolves them with TypeScript from the plugin directory, so a
 * missing local node_modules (an in-place overwrite used to delete it) or an
 * incomplete host dependency root breaks `reload` with
 * `Could not resolve type dependency "@getpaseo/client"`.
 */
export async function ensureTypeDeps(
  pluginDirectory: string,
  options: { home: string; allowInstall: boolean },
): Promise<TypeDepResult> {
  if (!existsSync(join(pluginDirectory, "package.json"))) {
    return { installed: [], missing: [] };
  }
  const manifest = await readJson(join(pluginDirectory, "package.json"));
  const declared = new Set([
    ...Object.keys(stringRecord(manifest?.devDependencies)),
    ...Object.keys(stringRecord(manifest?.dependencies)),
  ]);
  const wanted = HOST_PACKAGES.filter(
    (name) => declared.has(name) || false,
  );
  if (wanted.length === 0) {
    const imported = await sourceImports(pluginDirectory);
    wanted.push(...HOST_PACKAGES.filter((name) => imported.has(name)));
  }

  const unresolved = wanted.filter((name) => !resolvableFrom(pluginDirectory, name));
  if (unresolved.length === 0) return { installed: [], missing: [] };
  if (!options.allowInstall) return { installed: [], missing: unresolved };

  const specs: string[] = [];
  for (const name of unresolved) {
    specs.push(`${name}@${await pickVersion(pluginDirectory, options.home, name)}`);
  }
  await npmInstall(pluginDirectory, specs);

  const installed = unresolved.filter((name) => resolvableFrom(pluginDirectory, name));
  const missing = unresolved.filter((name) => !resolvableFrom(pluginDirectory, name));
  return { installed, missing };
}
