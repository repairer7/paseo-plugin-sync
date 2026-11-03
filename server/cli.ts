import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function candidates(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    return [
      join(home, "bin", "paseo.exe"),
      join(home, ".local", "bin", "paseo.exe"),
      "C:\\Program Files\\Paseo\\resources\\bin\\paseo.cmd",
      join(home, "AppData", "Local", "Programs", "Paseo", "resources", "bin", "paseo.cmd"),
    ];
  }
  return ["/usr/local/bin/paseo", "/opt/homebrew/bin/paseo", join(home, ".local", "bin", "paseo")];
}

let cachedCli: string | null = null;

export function resolveCli(): string {
  if (cachedCli) return cachedCli;
  for (const candidate of candidates()) {
    if (existsSync(candidate)) {
      cachedCli = candidate;
      return candidate;
    }
  }
  cachedCli = "paseo";
  return cachedCli;
}

function quoteForCmd(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function runCli(
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<CliResult> {
  const cli = resolveCli();
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const useShell = cli === "paseo" || /\.(cmd|bat)$/i.test(cli);
    const command = useShell && process.platform === "win32" ? quoteForCmd(cli) : cli;
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: useShell,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`paseo ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function cliJson(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const result = await runCli(args, options);
  if (result.code !== 0) {
    throw new Error(
      `paseo ${args.slice(0, 3).join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 800)}`,
    );
  }
  const text = result.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`paseo ${args.join(" ")} returned non-JSON output: ${text.slice(0, 300)}`);
  }
}
