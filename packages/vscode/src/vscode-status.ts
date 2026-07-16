import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

import { vsCodeMcpServerName, type VsCodeMcpEntry, type VsCodeMcpPreviewOptions, buildVsCodeMcpEntry, isValidPetId } from "./vscode-mcp.js";

export type VsCodeMcpStatus = "missing" | "installed" | "needs-update" | "conflict" | "invalid" | "error";

export interface VsCodeMcpStatusResult {
  readonly status: VsCodeMcpStatus;
  readonly message: string;
  readonly configPath: string;
  readonly canInstall: boolean;
  readonly canReplace: boolean;
  readonly canRemove: boolean;
  readonly previewEntry?: VsCodeMcpEntry;
  readonly redactedDetails?: string;
}

export interface VsCodeConfigReadResult {
  readonly ok: true;
  readonly config: Record<string, unknown>;
  readonly exists: boolean;
}

export interface VsCodeConfigError {
  readonly ok: false;
  readonly message: string;
  readonly reason: "parse" | "size" | "symlink" | "not-regular" | "unsafe-path" | "invalid-schema" | "io";
}

export interface VsCodePlannedWrite {
  readonly targetPath: string;
  readonly backupPath?: string;
  readonly tempPath: string;
  readonly content: string;
}

export const maxVsCodeConfigBytes = 256 * 1024; // 256 KiB

export function classifyVsCodeMcpStatus(
  configResult: VsCodeConfigReadResult | VsCodeConfigError,
  configPath: string,
  expected: VsCodeMcpPreviewOptions
): VsCodeMcpStatusResult {
  if (!configResult.ok) {
    const messages: Record<VsCodeConfigError["reason"], string> = {
      parse: "VS Code MCP config is invalid JSON.",
      size: "VS Code MCP config is too large.",
      symlink: "VS Code MCP config path is a symlink.",
      "not-regular": "VS Code MCP config is not a regular file.",
      "unsafe-path": "VS Code MCP config path is unsafe.",
      "invalid-schema": "VS Code MCP config has invalid schema.",
      io: "Failed to read VS Code MCP config.",
    };
    return {
      status: configResult.reason === "io" ? "error" : "invalid",
      message: messages[configResult.reason],
      configPath,
      canInstall: false,
      canReplace: false,
      canRemove: false,
      redactedDetails: configResult.message,
    };
  }

  const { config, exists } = configResult;

  if (!exists) {
    return {
      status: "missing",
      message: "VS Code MCP config does not exist.",
      configPath,
      canInstall: true,
      canReplace: false,
      canRemove: false,
      previewEntry: buildVsCodeMcpEntry(expected),
    };
  }

  const servers = isRecord(config.servers) ? config.servers : undefined;

  if (servers === undefined || servers[vsCodeMcpServerName] === undefined) {
    return {
      status: "missing",
      message: "OpenPets MCP entry is not configured.",
      configPath,
      canInstall: true,
      canReplace: false,
      canRemove: false,
      previewEntry: buildVsCodeMcpEntry(expected),
    };
  }

  const openpetsEntry = servers[vsCodeMcpServerName];

  if (!isRecord(openpetsEntry)) {
    return {
      status: "conflict",
      message: "VS Code MCP config has malformed openpets entry.",
      configPath,
      canInstall: false,
      canReplace: true,
      canRemove: false,
      redactedDetails: "servers.openpets is not an object",
    };
  }

  const expectedEntry = buildVsCodeMcpEntry(expected);

  if (isSameMcpEntry(openpetsEntry, expectedEntry)) {
    return {
      status: "installed",
      message: "OpenPets MCP is installed and up to date.",
      configPath,
      canInstall: false,
      canReplace: false,
      canRemove: true,
      previewEntry: expectedEntry,
    };
  }

  if (isManagedOpenPetsMcpEntry(openpetsEntry)) {
    return {
      status: "needs-update",
      message: "OpenPets MCP needs update (version or pet differs).",
      configPath,
      canInstall: true,
      canReplace: true,
      canRemove: true,
      previewEntry: expectedEntry,
    };
  }

  return {
    status: "conflict",
    message: "VS Code MCP config has a non-OpenPets openpets entry.",
    configPath,
    canInstall: false,
    canReplace: true,
    canRemove: false,
    redactedDetails: "Existing openpets entry is not managed by OpenPets",
  };
}

export function isManagedOpenPetsMcpEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type !== "stdio") return false;
  if (typeof value.command !== "string") return false;
  if (!Array.isArray(value.args)) return false;
  if (!value.args.every((arg) => typeof arg === "string")) return false;

  const args = value.args as readonly string[];

  if (value.command === "npx") {
    return isPublishedOpenPetsMcpArgs(args);
  }

  if (value.command === "node") {
    return isNodeOpenPetsMcpArgs(args);
  }

  return false;
}

function isPublishedOpenPetsMcpArgs(args: readonly string[]): boolean {
  if (args.length < 2) return false;
  if (args[0] !== "-y") return false;
  const packageArg = args[1];
  if (typeof packageArg !== "string") return false;
  const match = packageArg.match(/^@open-pets\/mcp@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?)$/);
  if (!match) return false;
  const version = match[1];
  if (!version) return false;
  return hasValidPetArgs(args.slice(2));
}

function isNodeOpenPetsMcpArgs(args: readonly string[]): boolean {
  if (args.length < 1) return false;
  const scriptPath = args[0];
  if (typeof scriptPath !== "string") return false;
  const isOpenPetsPath = /(?:^|[\\/])node_modules[\\/]@open-pets[\\/]mcp[\\/]dist[\\/]index\.js$/u.test(scriptPath) ||
    /(?:^|[\\/])packages[\\/]mcp[\\/]dist[\\/]index\.js$/u.test(scriptPath);
  if (!isOpenPetsPath) return false;
  return hasValidPetArgs(args.slice(1));
}

function hasValidPetArgs(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  if (args.length !== 2) return false;
  if (args[0] !== "--pet") return false;
  return isValidPetId(args[1] ?? "");
}

function isSameMcpEntry(value: unknown, expected: VsCodeMcpEntry): boolean {
  if (!isRecord(value)) return false;
  if (value.type !== expected.type) return false;
  if (value.command !== expected.command) return false;
  if (!Array.isArray(value.args)) return false;
  if (value.args.length !== expected.args.length) return false;
  return value.args.every((arg: unknown, index: number) => arg === expected.args[index]);
}

export function readVsCodeMcpConfig(configPath: string): VsCodeConfigReadResult | VsCodeConfigError {
  try {
    const parentSafety = assertSafeParentDirectory(dirname(configPath));
    if (!parentSafety.ok) return parentSafety;

    const safety = assertSafeExistingConfigFile(configPath, true);
    if (!safety.ok) return safety;

    if (!existsSync(configPath)) {
      return { ok: true, config: {}, exists: false };
    }

    const content = readFileSync(configPath, "utf8");
    const size = Buffer.byteLength(content, "utf8");
    if (size > maxVsCodeConfigBytes) {
      return { ok: false, message: "Config file exceeds 256 KiB limit.", reason: "size" };
    }

    if (content.trim() === "") {
      return { ok: true, config: {}, exists: true };
    }

    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, message: "Config must be a JSON object.", reason: "invalid-schema" };
    }

    if (parsed.servers !== undefined && !isRecord(parsed.servers)) {
      return { ok: false, message: "servers must be an object.", reason: "invalid-schema" };
    }

    return { ok: true, config: parsed, exists: true };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, message: `JSON parse error: ${error.message}`, reason: "parse" };
    }
    return { ok: false, message: `IO error: ${error instanceof Error ? error.message : String(error)}`, reason: "io" };
  }
}

export function planVsCodeMcpInstall(
  configPath: string,
  options: VsCodeMcpPreviewOptions,
  allowReplace = false
): VsCodePlannedWrite | VsCodeConfigError {
  const existing = readVsCodeMcpConfig(configPath);
  if (!existing.ok) return existing;

  const status = classifyVsCodeMcpStatus(existing, configPath, options);

  if (status.status === "invalid" || status.status === "error") {
    return { ok: false, message: status.message, reason: "invalid-schema" };
  }

  if (status.status === "conflict" && !allowReplace) {
    return { ok: false, message: "Cannot install: config has conflicting openpets entry. Use replace instead.", reason: "invalid-schema" };
  }

  if (status.status === "installed") {
    return { ok: false, message: "Already installed.", reason: "invalid-schema" };
  }

  const newEntry = buildVsCodeMcpEntry(options);
  const newConfig: Record<string, unknown> = { ...existing.config };

  if (newConfig.servers === undefined || !isRecord(newConfig.servers)) {
    newConfig.servers = { [vsCodeMcpServerName]: newEntry };
  } else {
    newConfig.servers = { ...newConfig.servers, [vsCodeMcpServerName]: newEntry };
  }

  const content = JSON.stringify(newConfig, null, 2) + "\n";
  return buildWritePlan(configPath, content);
}

export function planVsCodeMcpReplace(
  configPath: string,
  options: VsCodeMcpPreviewOptions
): VsCodePlannedWrite | VsCodeConfigError {
  const existing = readVsCodeMcpConfig(configPath);
  if (!existing.ok) return existing;

  const status = classifyVsCodeMcpStatus(existing, configPath, options);

  if (status.status === "invalid" || status.status === "error") {
    return { ok: false, message: status.message, reason: "invalid-schema" };
  }

  if (status.status === "missing") {
    return { ok: false, message: "Cannot replace: no existing openpets entry. Use install instead.", reason: "invalid-schema" };
  }
  if (status.status === "installed") {
    return { ok: false, message: "Cannot replace: OpenPets MCP entry is already installed.", reason: "invalid-schema" };
  }

  const newEntry = buildVsCodeMcpEntry(options);
  const newConfig: Record<string, unknown> = { ...existing.config };

  if (!isRecord(newConfig.servers)) {
    newConfig.servers = { [vsCodeMcpServerName]: newEntry };
  } else {
    newConfig.servers = { ...newConfig.servers, [vsCodeMcpServerName]: newEntry };
  }

  const content = JSON.stringify(newConfig, null, 2) + "\n";
  return buildWritePlan(configPath, content);
}

export function planVsCodeMcpRemove(configPath: string): VsCodePlannedWrite | VsCodeConfigError {
  const existing = readVsCodeMcpConfig(configPath);
  if (!existing.ok) return existing;

  const servers = isRecord(existing.config.servers) ? existing.config.servers : undefined;
  if (servers === undefined || servers[vsCodeMcpServerName] === undefined) {
    return { ok: false, message: "OpenPets MCP entry is not installed.", reason: "invalid-schema" };
  }
  if (!isManagedOpenPetsMcpEntry(servers[vsCodeMcpServerName])) {
    return { ok: false, message: "Cannot remove: existing openpets entry is not managed by OpenPets.", reason: "invalid-schema" };
  }

  const newConfig: Record<string, unknown> = { ...existing.config };

  if (isRecord(newConfig.servers)) {
    const { [vsCodeMcpServerName]: _, ...remainingServers } = newConfig.servers;
    newConfig.servers = remainingServers;
  }

  const content = JSON.stringify(newConfig, null, 2) + "\n";
  return buildWritePlan(configPath, content);
}

function buildWritePlan(configPath: string, content: string): VsCodePlannedWrite | VsCodeConfigError {
  const parent = dirname(configPath);
  const parentSafety = assertSafeParentDirectory(parent);
  if (!parentSafety.ok) return parentSafety;

  const existing = assertSafeExistingConfigFile(configPath, true);
  if (!existing.ok) return existing;

  const stamp = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const backupPath = existsSync(configPath) ? uniquePath(`${configPath}.openpets-backup-${stamp}.json`) : undefined;
  const tempPath = uniquePath(join(parent, `.openpets-${stamp}.tmp`));

  return { targetPath: configPath, backupPath, tempPath, content };
}

export function executeVsCodeMcpWrite(plan: VsCodePlannedWrite): void {
  const parent = dirname(plan.targetPath);
  const parentSafety = assertSafeParentDirectory(parent);
  if (!parentSafety.ok) throw new Error(parentSafety.message);

  const targetSafety = assertSafeExistingConfigFile(plan.targetPath, true);
  if (!targetSafety.ok) throw new Error(targetSafety.message);

  try {
    JSON.parse(plan.content);
  } catch (error) {
    throw new Error(`Invalid JSON content: ${error instanceof Error ? error.message : String(error)}`);
  }

  mkdirSync(parent, { recursive: true, mode: 0o700 });

  if (plan.backupPath && existsSync(plan.targetPath)) {
    const backupFd = openSync(plan.backupPath, "wx", 0o600);
    try {
      writeFileSync(backupFd, readFileSync(plan.targetPath));
    } finally {
      closeSync(backupFd);
    }
  }

  const fd = openSync(plan.tempPath, "wx", 0o600);
  try {
    writeFileSync(fd, plan.content, "utf8");
  } finally {
    closeSync(fd);
  }

  renameSync(plan.tempPath, plan.targetPath);
  try { chmodSync(plan.targetPath, 0o600); } catch { /* best effort */ }
}

function assertSafeExistingConfigFile(path: string, allowMissing = false): VsCodeConfigError | { readonly ok: true } {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return allowMissing ? { ok: true } : { ok: false, message: "Config file does not exist.", reason: "io" };
  if (stat.isSymbolicLink()) return { ok: false, message: "Config file is a symlink.", reason: "symlink" };
  if (!stat.isFile()) return { ok: false, message: "Config file is not a regular file.", reason: "not-regular" };
  if (stat.size > maxVsCodeConfigBytes) return { ok: false, message: "Config file exceeds 256 KiB limit.", reason: "size" };

  return { ok: true };
}

function assertSafeParentDirectory(path: string): VsCodeConfigError | { readonly ok: true } {
  if (path.split(/[\\/]+/u).includes("..")) {
    return { ok: false, message: "Config parent path must not contain parent traversal segments.", reason: "unsafe-path" };
  }

  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const parts = absolutePath.slice(root.length).split(/[\\/]+/u).filter(Boolean);
  let current = root;

  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) return { ok: false, message: "Config parent must not contain symlink segments.", reason: "symlink" };
    if (!stat.isDirectory()) return { ok: false, message: "Config parent path segment must be a directory.", reason: "unsafe-path" };
  }

  return { ok: true };
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${path}.${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Unable to allocate unique temp path.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
