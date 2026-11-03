import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export type SyncSettingsValues = {
  repo: string;
  branch: string;
  proxyBase: string;
  pollSeconds: number;
  autoApply: boolean;
  installDeps: boolean;
  includeNodeModules: boolean;
  hostLabel: string;
};

const hostRow = z.object({
  name: z.string(),
  serverId: z.string(),
  platform: z.string(),
  paseoVersion: z.string(),
  lastSeen: z.string(),
  pluginCount: z.number(),
  isMe: z.boolean(),
});

const myPlugin = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  status: z.string(),
  kind: z.string(),
  path: z.string(),
  contentHash: z.string(),
  targets: z.array(z.string()),
  platform: z.string(),
});

const incoming = z.object({
  id: z.string(),
  from: z.string(),
  hash: z.string(),
  state: z.enum(["applied", "failed", "skipped", "conflict", "pending"]),
  detail: z.string(),
});

export const statusOutput = z.object({
  host: z.object({
    name: z.string(),
    serverId: z.string(),
    platform: z.string(),
    paseoVersion: z.string(),
    dir: z.string(),
  }),
  config: z.object({
    repo: z.string(),
    branch: z.string(),
    proxyBase: z.string(),
    pollSeconds: z.number(),
    autoApply: z.boolean(),
    installDeps: z.boolean(),
    includeNodeModules: z.boolean(),
    hostLabel: z.string(),
  }),
  token: z.object({
    configured: z.boolean(),
    user: z.string(),
    error: z.string(),
  }),
  hosts: z.array(hostRow),
  myPlugins: z.array(myPlugin),
  incoming: z.array(incoming),
  running: z.boolean(),
  lastRunAt: z.string(),
  lastError: z.string(),
  log: z.array(z.object({ at: z.string(), level: z.string(), text: z.string() })),
});

export const statusRpc = defineRpc({
  name: "sync.status",
  input: z.object({}),
  output: statusOutput,
});

export const saveConfigRpc = defineRpc({
  name: "sync.config.save",
  input: z.object({
    repo: z.string().optional(),
    branch: z.string().optional(),
    proxyBase: z.string().optional(),
    pollSeconds: z.number().int().min(0).max(3600).optional(),
    autoApply: z.boolean().optional(),
    installDeps: z.boolean().optional(),
    includeNodeModules: z.boolean().optional(),
    hostLabel: z.string().optional(),
    token: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});

export const importTokenRpc = defineRpc({
  name: "sync.token.import",
  input: z.object({ path: z.string().optional() }),
  output: z.object({ ok: z.boolean(), user: z.string(), error: z.string() }),
});

export const saveTargetsRpc = defineRpc({
  name: "sync.targets.save",
  input: z.object({ pluginId: z.string(), targets: z.array(z.string()) }),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});

export const runRpc = defineRpc({
  name: "sync.run",
  input: z.object({ apply: z.boolean().optional() }),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});

export const clearTokenRpc = defineRpc({
  name: "sync.token.clear",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});
