import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname as osHostname, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { cliJson, runCli } from "./cli.js";
import { ensureClone, commitAndPush, remoteUrl } from "./git.js";
import { copyDirectory, hashDirectory, makeSkip, replaceDirectory } from "./fsutil.js";
import type { SyncSettingsValues } from "../shared/contracts.js";

type Kind = "directory" | "npm" | "git" | "unknown";

export interface SourceSpec {
  spec: string;
  version: string;
  ref: string;
}

export interface RepoPlugin {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  kind: Kind;
  source: SourceSpec;
  path: string;
  contentHash: string;
  published: boolean;
  installDeps: boolean;
  platform: string;
  targets: string[];
  updatedAt: string;
}

interface RepoHostFile {
  version: number;
  host: {
    name: string;
    serverId: string;
    platform: string;
    paseoVersion: string;
    lastSeen: string;
  };
  plugins: Record<string, RepoPlugin>;
}

interface RemoteState {
  hosts: Array<{
    name: string;
    serverId: string;
    platform: string;
    paseoVersion: string;
    lastSeen: string;
    pluginCount: number;
    isMe: boolean;
  }>;
  folders: Map<string, RepoHostFile>;
}

export interface InventoryItem {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  path: string;
  kind: Kind;
  version: string;
  ref: string;
  hasRuntimeDeps: boolean;
}

export interface SyncResult {
  id: string;
  from: string;
  hash: string;
  state: "applied" | "failed" | "skipped" | "conflict" | "pending";
  detail: string;
}

interface LogLine {
  at: string;
  level: string;
  text: string;
}

interface EngineOptions {
  home: string;
  getConfig: () => SyncSettingsValues;
  saveConfig: (patch: Partial<SyncSettingsValues>) => Promise<string | null>;
}

const HOST_FILE = "host.json";
const PLUGINS_FILE = "plugins.json";
const LAST_SEEN_TTL_MS = 4 * 60 * 1000;

export class SyncEngine {
  readonly home: string;
  readonly syncRoot: string;
  readonly repoDir: string;
  readonly stagingRoot: string;
  readonly backupRoot: string;
  readonly tokenPath: string;
  readonly serverId: string;
  readonly hostname: string;
  readonly platform = osPlatform();
  private readonly options: EngineOptions;
  private paseoVersion = "";
  private ownFolder = "";
  private tokenCache: string | null | undefined = undefined;
  private tokenUser = "";
  private tokenError = "";
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunAt = "";
  private lastError = "";
  private incoming: SyncResult[] = [];
  private hosts: RemoteState["hosts"] = [];
  private published: RepoPlugin[] = [];
  private logs: LogLine[] = [];
  private pendingRun: ReturnType<typeof setTimeout> | null = null;

  constructor(options: EngineOptions) {
    this.options = options;
    this.home = options.home;
    this.syncRoot = join(options.home, "plugin-sync");
    this.repoDir = join(this.syncRoot, "repo");
    this.stagingRoot = join(this.syncRoot, "staging");
    this.backupRoot = join(this.syncRoot, "backups");
    this.tokenPath = join(this.syncRoot, "token.txt");
    this.serverId = this.readServerId();
    this.hostname = this.sanitize(osHostname());
  }

  private readServerId(): string {
    try {
      const value = readFileSync(join(this.home, "server-id"), "utf8").trim();
      return value || "srv_unknown";
    } catch {
      return "srv_unknown";
    }
  }

  private sanitize(value: string): string {
    const cleaned = value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
    return cleaned || `host-${this.serverId.slice(-6)}`;
  }

  private config(): SyncSettingsValues {
    return this.options.getConfig();
  }

  private get skip() {
    return makeSkip(this.config().includeNodeModules);
  }

  log(text: string, level = "info"): void {
    const line = { at: new Date().toISOString(), level, text };
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    if (level === "error") console.error(`[plugin-sync] ${text}`);
    else console.log(`[plugin-sync] ${text}`);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.syncRoot, { recursive: true });
    try {
      const result = await runCli(["--version"], { timeoutMs: 20_000 });
      this.paseoVersion = result.stdout.trim().split(/\r?\n/).pop() ?? "";
    } catch {
      this.paseoVersion = "";
    }
    this.schedule();
    this.pendingRun = setTimeout(() => void this.runOnce(this.config().autoApply), 4_000);
  }

  onConfigChanged(): void {
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const seconds = this.config().pollSeconds;
    if (!seconds) return;
    this.timer = setInterval(() => void this.runOnce(this.config().autoApply), seconds * 1000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pendingRun) clearTimeout(this.pendingRun);
    this.timer = null;
    this.pendingRun = null;
  }

  // ---------------------------------------------------------------- token

  private async loadToken(): Promise<string> {
    if (this.tokenCache !== undefined) return this.tokenCache ?? "";
    try {
      const value = (await fs.readFile(this.tokenPath, "utf8")).trim();
      this.tokenCache = value || "";
    } catch {
      this.tokenCache = "";
    }
    return this.tokenCache ?? "";
  }

  async getTokenStatus(): Promise<{ configured: boolean; user: string; error: string }> {
    const token = await this.loadToken();
    return { configured: Boolean(token), user: this.tokenUser, error: this.tokenError };
  }

  async setToken(token: string | null): Promise<void> {
    await fs.mkdir(this.syncRoot, { recursive: true });
    if (!token) {
      await fs.rm(this.tokenPath, { force: true });
      this.tokenCache = "";
      this.tokenUser = "";
      this.tokenError = "";
      return;
    }
    await fs.writeFile(this.tokenPath, token.trim(), { mode: 0o600 });
    try {
      await fs.chmod(this.tokenPath, 0o600);
    } catch {
      // Windows ignores POSIX modes.
    }
    this.tokenCache = token.trim();
    await this.verifyToken();
  }

  private apiBase(): string {
    const proxy = this.config().proxyBase.trim().replace(/\/+$/, "");
    return proxy ? `${proxy}/https://api.github.com` : "https://api.github.com";
  }

  async verifyToken(): Promise<{ ok: boolean; user: string; error: string }> {
    const token = await this.loadToken();
    if (!token) {
      this.tokenUser = "";
      this.tokenError = "";
      return { ok: false, user: "", error: "未配置 token" };
    }
    try {
      const response = await fetch(`${this.apiBase()}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "paseo-plugin-sync",
        },
      });
      if (!response.ok) {
        const body = await response.text();
        this.tokenUser = "";
        this.tokenError = `GitHub ${response.status}: ${body.slice(0, 200)}`;
        return { ok: false, user: "", error: this.tokenError };
      }
      const user = (await response.json()) as { login?: string };
      this.tokenUser = user.login ?? "";
      this.tokenError = "";
      return { ok: true, user: this.tokenUser, error: "" };
    } catch (error) {
      this.tokenUser = "";
      this.tokenError = error instanceof Error ? error.message : String(error);
      return { ok: false, user: "", error: this.tokenError };
    }
  }

  async importToken(path?: string): Promise<{ ok: boolean; user: string; error: string }> {
    const candidates = path
      ? [path]
      : [
          join(homedir(), "Desktop", "token.txt"),
          join(homedir(), "Desktop", "github-token.txt"),
          join(homedir(), "OneDrive", "Desktop", "token.txt"),
          join(homedir(), "token.txt"),
        ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const token = (await fs.readFile(candidate, "utf8")).trim().split(/\r?\n/)[0]?.trim() ?? "";
      if (!token) continue;
      await this.setToken(token);
      const verified = await this.verifyToken();
      this.log(`已从 ${candidate} 导入 token（${verified.user || "未验证"}）`);
      return verified;
    }
    return { ok: false, user: "", error: "没有找到 token 文件（默认查找桌面 token.txt）" };
  }

  // ------------------------------------------------------------- inventory

  private async listInventory(): Promise<InventoryItem[]> {
    const raw = (await cliJson(["plugin", "ls", "--json"], { timeoutMs: 60_000 })) as Array<
      Record<string, unknown>
    >;
    if (!Array.isArray(raw)) return [];
    const items: InventoryItem[] = [];
    for (const entry of raw) {
      const id = String(entry.id ?? "");
      if (!id) continue;
      const path = String(entry.path ?? "");
      const installation = (entry.installation ?? {}) as {
        identity?: { kind?: string; remote?: string; packageName?: string };
        currentRevision?: string;
      };
      const identity = installation.identity;
      const kind = (identity?.kind ?? "directory") as Kind;
      let ref = "";
      if (kind === "git") ref = installation.currentRevision ?? "";
      let version = "";
      if (kind === "npm") version = installation.currentRevision ?? "";
      items.push({
        id,
        name: String(entry.name ?? id),
        enabled: entry.enabled !== false,
        status: String(entry.status ?? "unknown"),
        path,
        kind,
        version,
        ref,
        hasRuntimeDeps: await hasRuntimeDependencies(path),
      });
    }
    return items;
  }

  // -------------------------------------------------------------- remote IO

  private async readRemote(): Promise<RemoteState> {
    const hosts: RemoteState["hosts"] = [];
    const folders = new Map<string, RepoHostFile>();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.repoDir);
    } catch {
      return { hosts, folders };
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const hostPath = join(this.repoDir, entry, HOST_FILE);
      const pluginsPath = join(this.repoDir, entry, PLUGINS_FILE);
      try {
        const host = JSON.parse(await fs.readFile(hostPath, "utf8")) as RepoHostFile["host"];
        if (!host?.serverId) continue;
        let plugins: Record<string, RepoPlugin> = {};
        try {
          const parsed = JSON.parse(await fs.readFile(pluginsPath, "utf8")) as {
            plugins?: Record<string, RepoPlugin>;
          };
          plugins = parsed.plugins ?? {};
        } catch {
          plugins = {};
        }
        folders.set(entry, { version: 1, host, plugins });
        if (host.serverId === this.serverId) {
          this.ownFolder = entry;
        }
        hosts.push({
          name: entry,
          serverId: host.serverId,
          platform: host.platform ?? "",
          paseoVersion: host.paseoVersion ?? "",
          lastSeen: host.lastSeen ?? "",
          pluginCount: Object.keys(plugins).length,
          isMe: host.serverId === this.serverId,
        });
      } catch {
        continue;
      }
    }
    hosts.sort((a, b) => a.name.localeCompare(b.name));
    if (!this.ownFolder) {
      const base = this.config().hostLabel.trim() ? this.sanitize(this.config().hostLabel) : this.hostname;
      const taken = folders.get(base);
      this.ownFolder = !taken || taken.host.serverId === this.serverId ? base : `${base}-${this.serverId.slice(-4)}`;
      hosts.push({
        name: this.ownFolder,
        serverId: this.serverId,
        platform: this.platform,
        paseoVersion: this.paseoVersion,
        lastSeen: "",
        pluginCount: 0,
        isMe: true,
      });
      hosts.sort((a, b) => a.name.localeCompare(b.name));
    }
    return { hosts, folders };
  }

  // ------------------------------------------------------------- publishing

  private async publish(inventory: InventoryItem[]): Promise<void> {
    const remote = await this.readRemote();
    const ownName = this.ownFolder;
    const ownDir = join(this.repoDir, ownName);
    await fs.mkdir(ownDir, { recursive: true });
    const previous = remote.folders.get(ownName)?.plugins ?? {};
    const now = new Date().toISOString();
    const plugins: Record<string, RepoPlugin> = {};
    const pluginRoot = join(ownDir, "plugins");
    await fs.mkdir(pluginRoot, { recursive: true });
    const keep = new Set<string>();

    for (const item of inventory) {
      if (item.id === "plugin-sync") continue;
      const contentHash =
        item.kind === "directory" && item.path && existsSync(item.path)
          ? await hashDirectory(item.path, this.skip)
          : "";
      const previousEntry = previous[item.id];
      const published = item.kind === "directory" && Boolean(contentHash);
      const entry: RepoPlugin = {
        id: item.id,
        name: item.name,
        enabled: item.enabled,
        status: item.status,
        kind: item.kind,
        source: {
          spec: item.kind === "npm" ? `npm:${item.id}` : item.kind === "git" ? "" : "",
          version: item.version,
          ref: item.ref,
        },
        path: item.path,
        contentHash,
        published,
        installDeps: item.hasRuntimeDeps,
        platform: this.platform,
        targets: previousEntry?.targets ?? [],
        updatedAt: now,
      };
      const unchanged =
        previousEntry &&
        previousEntry.contentHash === entry.contentHash &&
        previousEntry.enabled === entry.enabled &&
        previousEntry.status === entry.status &&
        previousEntry.kind === entry.kind &&
        previousEntry.name === entry.name &&
        previousEntry.installDeps === entry.installDeps &&
        previousEntry.platform === entry.platform &&
        previousEntry.source.version === entry.source.version &&
        previousEntry.source.ref === entry.source.ref &&
        previousEntry.published === entry.published;
      if (unchanged) entry.updatedAt = previousEntry.updatedAt;
      plugins[item.id] = entry;

      if (published) {
        const destination = join(pluginRoot, item.id);
        keep.add(item.id);
        const currentHash = existsSync(destination)
          ? await hashDirectory(destination, this.skip)
          : "";
        if (currentHash !== contentHash) {
          await fs.rm(destination, { recursive: true, force: true });
          await copyDirectory(item.path, destination, this.skip);
          this.log(`已发布 ${item.id} 内容（${contentHash.slice(0, 19)}）`);
        }
      }
    }

    try {
      const existing = await fs.readdir(pluginRoot);
      for (const name of existing) {
        if (keep.has(name)) continue;
        await fs.rm(join(pluginRoot, name), { recursive: true, force: true });
      }
    } catch {
      // plugins directory may not exist yet
    }

    const previousHost = remote.folders.get(ownName)?.host;
    const lastSeenFresh =
      previousHost?.lastSeen && Date.now() - Date.parse(previousHost.lastSeen) < LAST_SEEN_TTL_MS;
    const hostFile: RepoHostFile = {
      version: 1,
      host: {
        name: ownName,
        serverId: this.serverId,
        platform: this.platform,
        paseoVersion: this.paseoVersion,
        lastSeen: lastSeenFresh ? previousHost.lastSeen : now,
      },
      plugins,
    };
    await fs.writeFile(join(ownDir, HOST_FILE), `${JSON.stringify(hostFile.host, null, 2)}\n`, "utf8");
    await fs.writeFile(
      join(ownDir, PLUGINS_FILE),
      `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`,
      "utf8",
    );
    this.published = Object.values(plugins);
  }

  private async publishWithRetry(inventory: InventoryItem[], token: string): Promise<void> {
    const config = this.config();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.publish(inventory);
        const pushed = await commitAndPush(
          this.repoDir,
          [this.ownFolder],
          `sync: ${this.ownFolder} inventory`,
          config.branch,
          token,
        );
        if (pushed) this.log(`已推送到 GitHub（${config.repo}@${config.branch}）`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 1) throw error;
        this.log(`推送失败，重新拉取后重试：${message}`, "error");
        await ensureClone(
          this.repoDir,
          config.repo,
          config.proxyBase,
          config.branch,
          token,
        );
      }
    }
  }

  // ------------------------------------------------------------- reconcile

  private async reconcile(remote: RemoteState, inventory: InventoryItem[]): Promise<void> {
    const me = this.ownFolder;
    const byId = new Map<string, { from: string; plugin: RepoPlugin }>();
    for (const [folder, file] of remote.folders) {
      if (folder === me) continue;
      for (const plugin of Object.values(file.plugins)) {
        if (!plugin.targets?.includes(me) && !plugin.targets?.includes("*")) continue;
        const current = byId.get(plugin.id);
        if (!current || Date.parse(plugin.updatedAt) > Date.parse(current.plugin.updatedAt)) {
          byId.set(plugin.id, { from: folder, plugin });
        }
      }
    }
    if (byId.size === 0) {
      this.incoming = [];
      return;
    }
    const results: SyncResult[] = [];
    const invMap = new Map(inventory.map((item) => [item.id, item]));
    for (const [id, desired] of byId) {
      const result = await this.applyOne(id, desired.plugin, desired.from, invMap);
      results.push(result);
      this.log(`${result.state === "applied" ? "已同步" : result.state} ${id}：${result.detail}`, result.state === "failed" ? "error" : "info");
    }
    this.incoming = results;
  }

  private async applyOne(
    id: string,
    desired: RepoPlugin,
    from: string,
    inventory: Map<string, InventoryItem>,
  ): Promise<SyncResult> {
    const base = { id, from, hash: desired.contentHash };
    const existing = inventory.get(id);
    try {
      if (!existing) {
        if (desired.published) {
          const sourceDir = join(this.repoDir, from, "plugins", id);
          if (!existsSync(sourceDir)) {
            return { ...base, state: "failed", detail: "源主机没有上传该插件内容" };
          }
          await this.installFromContent(id, sourceDir, desired);
          return { ...base, state: "applied", detail: "已安装（文件夹源）" };
        }
        return { ...base, state: "skipped", detail: "该条目没有内容快照，且不是 npm/git 源" };
      }

      if (desired.published && desired.kind === "directory") {
        if (existing.kind !== "directory") {
          return {
            ...base,
            state: "conflict",
            detail: `本机是 ${existing.kind} 源，源主机是文件夹源，需手动接管（会重置设置）`,
          };
        }
        const localHash = existing.path ? await hashDirectory(existing.path, this.skip) : "";
        if (localHash === desired.contentHash) {
          const changed = await this.syncEnabled(id, existing.enabled, desired.enabled);
          return { ...base, state: "applied", detail: changed ? "内容一致，已更新启停" : "内容已是最新" };
        }
        const sourceDir = join(this.repoDir, from, "plugins", id);
        if (!existsSync(sourceDir)) {
          return { ...base, state: "failed", detail: "源主机没有上传该插件内容" };
        }
        await this.backup(existing.path, id);
        await replaceDirectory(sourceDir, existing.path, this.skip);
        if (this.config().installDeps && desired.installDeps) {
          await npmInstall(existing.path);
        }
        await this.reload(id);
        await this.syncEnabled(id, existing.enabled, desired.enabled);
        return { ...base, state: "applied", detail: "已覆盖内容并重载（设置保留，旧版本已备份）" };
      }

      if (desired.kind === "npm" || desired.kind === "git") {
        if (existing.kind !== desired.kind) {
          return {
            ...base,
            state: "conflict",
            detail: `本机是 ${existing.kind} 源，源主机是 ${desired.kind} 源，需手动接管`,
          };
        }
        const currentRevision = desired.kind === "npm" ? existing.version : existing.ref;
        const wantedRevision = desired.kind === "npm" ? desired.source.version : desired.source.ref;
        if (wantedRevision && currentRevision && wantedRevision === currentRevision) {
          const changed = await this.syncEnabled(id, existing.enabled, desired.enabled);
          return { ...base, state: "applied", detail: changed ? "版本一致，已更新启停" : "版本已是最新" };
        }
        const args = ["plugin", "update", id, "--yes", "--json"];
        if (desired.kind === "npm" && desired.source.version) {
          args.push("--version", desired.source.version);
        }
        if (desired.kind === "git" && desired.source.ref) {
          args.push("--ref", desired.source.ref);
        }
        await cliJson(args, { timeoutMs: 300_000 });
        await this.syncEnabled(id, existing.enabled, desired.enabled);
        return { ...base, state: "applied", detail: "已更新到目标版本" };
      }

      return { ...base, state: "skipped", detail: "无法识别的来源类型" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, state: "failed", detail: message.slice(0, 500) };
    }
  }

  private async installFromContent(
    id: string,
    sourceDir: string,
    desired: RepoPlugin,
  ): Promise<void> {
    const staging = join(this.stagingRoot, id);
    await fs.rm(staging, { recursive: true, force: true });
    await copyDirectory(sourceDir, staging, this.skip);
    if (this.config().installDeps && desired.installDeps) {
      await npmInstall(staging);
    }
    await cliJson(["plugin", "install", staging, "--id", id, "--json"], { timeoutMs: 300_000 });
  }

  private async backup(path: string, id: string): Promise<void> {
    if (!path || !existsSync(path)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = join(this.backupRoot, `${id}-${stamp}`);
    await fs.mkdir(this.backupRoot, { recursive: true });
    await copyDirectory(path, destination, makeSkip(true));
    const entries = (await fs.readdir(this.backupRoot)).filter((name) => name.startsWith(`${id}-`)).sort();
    while (entries.length > 3) {
      const oldest = entries.shift();
      if (oldest) await fs.rm(join(this.backupRoot, oldest), { recursive: true, force: true });
    }
  }

  private async reload(id: string): Promise<void> {
    await cliJson(["plugin", "reload", id, "--json"], { timeoutMs: 120_000 });
  }

  private async syncEnabled(id: string, current: boolean, desired: boolean): Promise<boolean> {
    if (current === desired) return false;
    await cliJson(["plugin", desired ? "enable" : "disable", id, "--json"], { timeoutMs: 60_000 });
    return true;
  }

  // ------------------------------------------------------------------ run

  async runOnce(apply: boolean): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastError = "";
    try {
      const token = await this.loadToken();
      if (!token) {
        this.lastError = "尚未配置 GitHub token";
        return;
      }
      const config = this.config();
      if (!config.repo.includes("/")) {
        this.lastError = "仓库格式应为 owner/repo";
        return;
      }
      this.log(`开始同步（${apply ? "应用" : "只读"}）→ ${config.repo}@${config.branch}`);
      await ensureClone(this.repoDir, config.repo, config.proxyBase, config.branch, token);
      await this.readRemote();
      const before = await this.listInventory();
      const remote = await this.readRemote();
      if (apply) await this.reconcile(remote, before);
      const after = await this.listInventory();
      await this.publishWithRetry(after, token);
      this.hosts = (await this.readRemote()).hosts;
      this.lastRunAt = new Date().toISOString();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log(`同步失败：${this.lastError}`, "error");
    } finally {
      this.running = false;
    }
  }

  trigger(apply: boolean): void {
    void this.runOnce(apply);
  }

  async setTargets(pluginId: string, targets: string[]): Promise<string | null> {
    try {
      const token = await this.loadToken();
      if (!token) return "尚未配置 GitHub token";
      const config = this.config();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await ensureClone(this.repoDir, config.repo, config.proxyBase, config.branch, token);
        const remote = await this.readRemote();
        const ownDir = join(this.repoDir, this.ownFolder);
        const file = remote.folders.get(this.ownFolder);
        if (!file) return "本机还没有发布记录，请先执行一次同步";
        const entry = file.plugins[pluginId];
        if (!entry) return `本机没有 ${pluginId} 的发布记录`;
        entry.targets = targets;
        entry.updatedAt = new Date().toISOString();
        file.plugins[pluginId] = entry;
        await fs.writeFile(
          join(ownDir, PLUGINS_FILE),
          `${JSON.stringify({ version: 1, plugins: file.plugins }, null, 2)}\n`,
          "utf8",
        );
        try {
          await commitAndPush(
            this.repoDir,
            [this.ownFolder],
            `sync: ${this.ownFolder} targets for ${pluginId}`,
            config.branch,
            token,
          );
          this.published = Object.values(file.plugins);
          return null;
        } catch (error) {
          if (attempt === 1) throw error;
        }
      }
      return "保存失败";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async status() {
    const config = this.config();
    const token = await this.getTokenStatus();
    if (this.published.length === 0 && existsSync(join(this.repoDir, this.ownFolder, PLUGINS_FILE))) {
      try {
        const parsed = JSON.parse(
          await fs.readFile(join(this.repoDir, this.ownFolder, PLUGINS_FILE), "utf8"),
        ) as { plugins?: Record<string, RepoPlugin> };
        this.published = Object.values(parsed.plugins ?? {});
      } catch {
        // ignore
      }
    }
    return {
      host: {
        name: this.ownFolder || this.hostname,
        serverId: this.serverId,
        platform: this.platform,
        paseoVersion: this.paseoVersion,
        dir: this.syncRoot,
      },
      config: { ...config },
      token,
      hosts: this.hosts,
      myPlugins: this.published.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        enabled: plugin.enabled,
        status: plugin.status,
        kind: plugin.kind,
        path: plugin.path,
        contentHash: plugin.contentHash,
        targets: plugin.targets ?? [],
        platform: plugin.platform,
      })),
      incoming: this.incoming,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      log: this.logs.slice(-60),
    };
  }

  remote(): string {
    return remoteUrl(this.config().repo, this.config().proxyBase);
  }

  async saveConfig(patch: Partial<SyncSettingsValues>): Promise<string | null> {
    return this.options.saveConfig(patch);
  }
}

async function hasRuntimeDependencies(directory: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(join(directory, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(parsed.dependencies ?? {}).length > 0;
  } catch {
    return false;
  }
}

function npmInstall(directory: string): Promise<void> {
  const hasLock = existsSync(join(directory, "package-lock.json"));
  const args = hasLock
    ? ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]
    : ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, {
      cwd: directory,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("npm install 超时"));
    }, 600_000);
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
      else reject(new Error(`npm install 失败 (${code}): ${stderr.slice(0, 500)}`));
    });
  });
}
