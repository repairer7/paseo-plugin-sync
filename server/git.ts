import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function remoteUrl(repo: string, proxyBase: string): string {
  const base = proxyBase.trim().replace(/\/+$/, "");
  const plain = `https://github.com/${repo}.git`;
  return base ? `${base}/${plain}` : plain;
}

function authConfig(token: string): string[] {
  if (!token) return [];
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return ["-c", `http.extraHeader=${header}`];
}

export function runGit(
  args: string[],
  options: { cwd?: string; token?: string; timeoutMs?: number } = {},
): Promise<GitResult> {
  const common = [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.fileMode=false",
    "-c",
    "core.quotepath=false",
    "-c",
    "credential.helper=",
    "-c",
    "http.postBuffer=524288000",
    "-c",
    "user.name=Paseo Plugin Sync",
    "-c",
    "user.email=plugin-sync@localhost",
    ...authConfig(options.token ?? ""),
  ];
  const timeoutMs = options.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...common, ...args], {
      cwd: options.cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`git ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs}ms`));
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

export async function ensureClone(
  directory: string,
  repo: string,
  proxyBase: string,
  branch: string,
  token: string,
): Promise<{ cloned: boolean }> {
  const url = remoteUrl(repo, proxyBase);
  if (!existsSync(join(directory, ".git"))) {
    const result = await runGit(["clone", "--branch", branch, url, directory], {
      token,
      timeoutMs: 300_000,
    });
    if (result.code !== 0) {
      throw new Error(`git clone failed: ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
    }
    return { cloned: true };
  }
  const fetch = await runGit(["fetch", "origin", branch], { cwd: directory, token });
  if (fetch.code !== 0) {
    throw new Error(`git fetch failed: ${(fetch.stderr || fetch.stdout).trim().slice(0, 600)}`);
  }
  const reset = await runGit(["reset", "--hard", `origin/${branch}`], { cwd: directory, token });
  if (reset.code !== 0) {
    throw new Error(`git reset failed: ${(reset.stderr || reset.stdout).trim().slice(0, 600)}`);
  }
  return { cloned: false };
}

export async function commitAndPush(
  directory: string,
  paths: string[],
  message: string,
  branch: string,
  token: string,
): Promise<boolean> {
  const add = await runGit(["add", "-A", "--", ...paths], { cwd: directory, token });
  if (add.code !== 0) {
    throw new Error(`git add failed: ${(add.stderr || add.stdout).trim().slice(0, 600)}`);
  }
  const staged = await runGit(["diff", "--cached", "--quiet", "--", ...paths], {
    cwd: directory,
    token,
  });
  if (staged.code === 0) return false;
  const commit = await runGit(["commit", "-m", message], { cwd: directory, token });
  if (commit.code !== 0) {
    throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim().slice(0, 600)}`);
  }
  const push = await runGit(["push", "origin", `HEAD:${branch}`], { cwd: directory, token });
  if (push.code !== 0) {
    throw new Error(`git push failed: ${(push.stderr || push.stdout).trim().slice(0, 600)}`);
  }
  return true;
}
