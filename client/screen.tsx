import {
  useRpc,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  clearTokenRpc,
  importTokenRpc,
  runRpc,
  saveConfigRpc,
  saveTargetsRpc,
  statusRpc,
  statusOutput,
} from "../shared/contracts";
import type { z } from "zod";

type Status = z.output<typeof statusOutput>;

function useStatus() {
  const fetchStatus = useRpc(statusRpc);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = await fetchStatus({});
      if (alive.current) {
        setStatus(next);
        setError("");
      }
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [fetchStatus]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 8000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  return { status, error, refresh };
}

function Row({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 3 }}>
      <Text style={{ color, opacity: 0.7, fontSize: 13 }}>{label}</Text>
      <Text style={{ color, fontSize: 13, flexShrink: 1, textAlign: "right" }}>{value}</Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  theme,
  primary,
  disabled,
}: {
  label: string;
  onPress: () => void;
  theme: PluginScreenProps["theme"];
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 9,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: primary ? theme.colors.accentForeground : theme.colors.foreground,
          fontSize: 13,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Toggle({
  label,
  value,
  onChange,
  theme,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  theme: PluginScreenProps["theme"];
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 }}
    >
      <Text style={{ color: value ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 15 }}>
        {value ? "☑" : "☐"}
      </Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function Field({
  label,
  value,
  onChange,
  theme,
  placeholder,
  secure,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  theme: PluginScreenProps["theme"];
  placeholder?: string;
  secure?: boolean;
}) {
  return (
    <View style={{ gap: 4, paddingVertical: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 7,
          fontSize: 13,
        }}
      />
    </View>
  );
}

function Section({ title, children, theme }: { title: string; children: ReactNode; theme: PluginScreenProps["theme"] }) {
  return (
    <View style={{ gap: 6, marginTop: 18 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>
        {title}
      </Text>
      <View
        style={{
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          gap: 4,
        }}
      >
        {children}
      </View>
    </View>
  );
}

export function PluginSyncScreen(props: PluginScreenProps) {
  const { theme, layout } = props;
  const { status, error, refresh } = useStatus();
  const saveConfig = useRpc(saveConfigRpc);
  const importToken = useRpc(importTokenRpc);
  const clearToken = useRpc(clearTokenRpc);
  const saveTargets = useRpc(saveTargetsRpc);
  const triggerRun = useRpc(runRpc);

  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [proxyBase, setProxyBase] = useState("");
  const [pollSeconds, setPollSeconds] = useState("60");
  const [token, setToken] = useState("");
  const [autoApply, setAutoApply] = useState(true);
  const [installDeps, setInstallDeps] = useState(true);
  const [includeNodeModules, setIncludeNodeModules] = useState(false);
  const [targets, setTargets] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState("");

  const configKey = status
    ? `${status.config.repo}|${status.config.branch}|${status.config.proxyBase}|${status.config.pollSeconds}|${status.config.autoApply}|${status.config.installDeps}|${status.config.includeNodeModules}`
    : "";
  useEffect(() => {
    if (!status) return;
    setRepo(status.config.repo);
    setBranch(status.config.branch);
    setProxyBase(status.config.proxyBase);
    setPollSeconds(String(status.config.pollSeconds));
    setAutoApply(status.config.autoApply);
    setInstallDeps(status.config.installDeps);
    setIncludeNodeModules(status.config.includeNodeModules);
    setTargets((previous) => {
      const next: Record<string, string[]> = {};
      for (const plugin of status.myPlugins) {
        next[plugin.id] = previous[plugin.id] ?? plugin.targets;
      }
      return next;
    });
  }, [configKey, status?.myPlugins.length]);

  const others = useMemo(
    () => (status?.hosts ?? []).filter((host) => !host.isMe),
    [status?.hosts],
  );

  const dirtyTargets = useMemo(() => {
    if (!status) return [] as Array<{ id: string; targets: string[] }>;
    return status.myPlugins
      .filter((plugin) => {
        const draft = targets[plugin.id] ?? plugin.targets;
        return draft.length !== plugin.targets.length || draft.some((name) => !plugin.targets.includes(name));
      })
      .map((plugin) => ({ id: plugin.id, targets: targets[plugin.id] ?? plugin.targets }));
  }, [status, targets]);

  function saveSettings(): void {
    setNotice("保存中…");
    void (async () => {
      const result = await saveConfig({
        repo: repo.trim(),
        branch: branch.trim(),
        proxyBase: proxyBase.trim(),
        pollSeconds: Number(pollSeconds) || 0,
        autoApply,
        installDeps,
        includeNodeModules,
        token: token.trim() ? token.trim() : undefined,
      });
      setToken("");
      setNotice(result.ok ? "设置已保存" : `保存失败：${result.error}`);
      await refresh();
    })();
  }

  function doImport(): void {
    setNotice("导入中…");
    void (async () => {
      const result = await importToken({});
      setNotice(result.ok ? `已导入 token（${result.user}）` : `导入失败：${result.error}`);
      await refresh();
    })();
  }

  function run(apply: boolean): void {
    setNotice(apply ? "已开始同步（应用）" : "已开始检查");
    void (async () => {
      const result = await triggerRun({ apply });
      if (!result.ok) setNotice(`启动失败：${result.error}`);
      await refresh();
    })();
  }

  function saveAllTargets(): void {
    if (dirtyTargets.length === 0) {
      setNotice("目标没有变化");
      return;
    }
    void (async () => {
      for (const entry of dirtyTargets) {
        const result = await saveTargets({ pluginId: entry.id, targets: entry.targets });
        if (!result.ok) {
          setNotice(`保存 ${entry.id} 失败：${result.error}`);
          await refresh();
          return;
        }
      }
      setNotice("目标已保存，其他主机会在下一轮同步时应用");
      await refresh();
      run(true);
    })();
  }

  function toggleTarget(pluginId: string, hostName: string): void {
    setTargets((previous) => {
      const current = previous[pluginId] ?? status?.myPlugins.find((item) => item.id === pluginId)?.targets ?? [];
      const next = current.includes(hostName)
        ? current.filter((name) => name !== hostName)
        : [...current, hostName];
      return { ...previous, [pluginId]: next };
    });
  }

  const padding = layout.compact ? 16 : 24;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding, gap: 10, paddingBottom: 60 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 22 : 26, fontWeight: "700" }}>
        插件同步
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {status
          ? `本机 ${status.host.name} · ${status.host.platform} · Paseo ${status.host.paseoVersion || "?"} · ${status.host.serverId}`
          : "读取中…"}
      </Text>

      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
        <Button label="立即检查" onPress={() => run(false)} theme={theme} />
        <Button label="立即同步并应用" onPress={() => run(true)} theme={theme} primary />
        <Button label="刷新状态" onPress={() => void refresh()} theme={theme} />
      </View>
      {notice ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{notice}</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}

      {status ? (
        <>
          <Section title="状态" theme={theme}>
            <Row label="GitHub 身份" value={status.token.configured ? status.token.user || "已配置（未验证）" : "未配置"} color={theme.colors.foreground} />
            <Row label="仓库" value={`${status.config.repo}@${status.config.branch}`} color={theme.colors.foreground} />
            <Row label="反代" value={status.config.proxyBase || "直连"} color={theme.colors.foreground} />
            <Row label="轮询" value={status.config.pollSeconds ? `${status.config.pollSeconds}s` : "关闭"} color={theme.colors.foreground} />
            <Row label="上次同步" value={status.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : "从未"} color={theme.colors.foreground} />
            <Row label="运行中" value={status.running ? "是" : "否"} color={theme.colors.foreground} />
            {status.lastError ? <Row label="错误" value={status.lastError} color={theme.colors.foreground} /> : null}
            {status.token.error ? <Row label="token 错误" value={status.token.error} color={theme.colors.foreground} /> : null}
          </Section>

          <Section title="设置" theme={theme}>
            <Field label="仓库（owner/repo）" value={repo} onChange={setRepo} theme={theme} />
            <Field label="分支" value={branch} onChange={setBranch} theme={theme} />
            <Field label="GitHub 反代（留空=直连）" value={proxyBase} onChange={setProxyBase} theme={theme} placeholder="https://gh.imtsui.com" />
            <Field label="轮询秒数（0=关闭）" value={pollSeconds} onChange={setPollSeconds} theme={theme} />
            <Field label="GitHub token（只保存到本机，不回传界面）" value={token} onChange={setToken} theme={theme} secure placeholder="ghp_…" />
            <Toggle label="自动应用检查结果" value={autoApply} onChange={setAutoApply} theme={theme} />
            <Toggle label="安装运行时依赖（npm ci）" value={installDeps} onChange={setInstallDeps} theme={theme} />
            <Toggle label="发布时包含 node_modules（体积大）" value={includeNodeModules} onChange={setIncludeNodeModules} theme={theme} />
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <Button label="保存设置" onPress={saveSettings} theme={theme} primary />
              <Button label="从桌面 token.txt 导入" onPress={doImport} theme={theme} />
              <Button
                label="清除 token"
                onPress={() => {
                  void (async () => {
                    await clearToken({});
                    setNotice("已清除 token");
                    await refresh();
                  })();
                }}
                theme={theme}
              />
            </View>
          </Section>

          <Section title="已连接主机" theme={theme}>
            {status.hosts.length === 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>还没有其他主机发布过清单</Text>
            ) : (
              status.hosts.map((host) => (
                <Row
                  key={host.name}
                  label={`${host.name}${host.isMe ? "（本机）" : ""}`}
                  value={`${host.platform} · ${host.pluginCount} 插件 · ${host.lastSeen ? new Date(host.lastSeen).toLocaleString() : "未上线"}`}
                  color={theme.colors.foreground}
                />
              ))
            )}
          </Section>

          <Section title="本机插件 → 同步目标" theme={theme}>
            {status.myPlugins.length === 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                还没有发布记录。配置 token 后点击“立即同步并应用”即可发布本机插件。
              </Text>
            ) : (
              status.myPlugins.map((plugin) => (
                <View key={plugin.id} style={{ paddingVertical: 7, gap: 5, borderBottomColor: theme.colors.border, borderBottomWidth: 1 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                    {plugin.name} <Text style={{ color: theme.colors.foregroundMuted, fontWeight: "400" }}>({plugin.id})</Text>
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                    {plugin.kind} · {plugin.status} · {plugin.enabled ? "启用" : "停用"} · {plugin.platform}
                    {plugin.contentHash ? ` · ${plugin.contentHash.slice(0, 15)}` : ""}
                  </Text>
                  {others.length === 0 ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>等待其他主机上线</Text>
                  ) : (
                    <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
                      {others.map((host) => {
                        const selected = (targets[plugin.id] ?? plugin.targets).includes(host.name);
                        return (
                          <Pressable
                            key={host.name}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: selected }}
                            onPress={() => toggleTarget(plugin.id, host.name)}
                            style={{ flexDirection: "row", gap: 6, alignItems: "center" }}
                          >
                            <Text style={{ color: selected ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 14 }}>
                              {selected ? "☑" : "☐"}
                            </Text>
                            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{host.name}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>
              ))
            )}
            <View style={{ marginTop: 8 }}>
              <Button label="保存目标并同步" onPress={saveAllTargets} theme={theme} primary disabled={dirtyTargets.length === 0} />
            </View>
          </Section>

          <Section title="本机接收结果" theme={theme}>
            {status.incoming.length === 0 ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>暂无待应用条目</Text>
            ) : (
              status.incoming.map((item) => (
                <Row
                  key={item.id}
                  label={`${item.id} ← ${item.from}`}
                  value={`${item.state} · ${item.detail}`}
                  color={theme.colors.foreground}
                />
              ))
            )}
          </Section>

          <Section title="日志" theme={theme}>
            {status.log.slice(-18).map((line, index) => (
              <Text
                key={`${line.at}-${index}`}
                style={{ color: line.level === "error" ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 11 }}
              >
                {line.at.slice(11, 19)} {line.text}
              </Text>
            ))}
          </Section>
        </>
      ) : null}
    </ScrollView>
  );
}

export function PluginSyncItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="RefreshCw"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}
