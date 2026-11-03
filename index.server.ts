import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { SyncEngine } from "./server/engine.js";
import {
  clearTokenRpc,
  importTokenRpc,
  runRpc,
  saveConfigRpc,
  saveTargetsRpc,
  statusRpc,
  type SyncSettingsValues,
} from "./shared/contracts.js";

const DEFAULTS: SyncSettingsValues = {
  repo: "repairer7/paseo-plugin-store",
  branch: "main",
  proxyBase: "https://gh.imtsui.com",
  pollSeconds: 60,
  autoApply: true,
  installDeps: true,
  includeNodeModules: false,
  hostLabel: "",
};

export default function contribute(server: PluginServerContext) {
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  const configPath = join(home, "plugin-sync", "config.json");
  let config: SyncSettingsValues = { ...DEFAULTS };

  const persist = async (next: SyncSettingsValues): Promise<string | null> => {
    try {
      await fs.mkdir(join(home, "plugin-sync"), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}
`, "utf8");
      config = next;
      engine.onConfigChanged();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const engine = new SyncEngine({
    home,
    getConfig: () => config,
    saveConfig: async (patch) => persist({ ...config, ...patch }),
  });

  server.handle(statusRpc, () => engine.status());

  server.handle(saveConfigRpc, async (input) => {
    const { token, ...rest } = input;
    if (token !== undefined) {
      try {
        if (token.trim()) {
          await engine.setToken(token.trim());
        } else {
          await engine.setToken(null);
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const error = await engine.saveConfig(rest as Partial<SyncSettingsValues>);
    return { ok: !error, error: error ?? "" };
  });

  server.handle(importTokenRpc, async (input) => {
    const result = await engine.importToken(input.path);
    return { ok: result.ok, user: result.user, error: result.error };
  });

  server.handle(clearTokenRpc, async () => {
    try {
      await engine.setToken(null);
      return { ok: true, error: "" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  server.handle(saveTargetsRpc, async (input) => {
    const error = await engine.setTargets(input.pluginId, input.targets);
    return { ok: !error, error: error ?? "" };
  });

  server.handle(runRpc, (input) => {
    engine.trigger(input.apply ?? config.autoApply);
    return { ok: true, error: "" };
  });

  void (async () => {
    try {
      const stored = JSON.parse(await fs.readFile(configPath, "utf8")) as Partial<SyncSettingsValues>;
      config = { ...DEFAULTS, ...stored };
    } catch {
      // first run: defaults
    }
    try {
      await engine.init();
      const token = await engine.getTokenStatus();
      if (token.configured) {
        const verified = await engine.verifyToken();
        if (verified.ok) engine.log(`GitHub 身份：${verified.user}`);
        else engine.log(`token 校验失败：${verified.error}`, "error");
      }
    } catch (error) {
      engine.log(`初始化失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  })();

  return () => {
    engine.dispose();
  };
}
