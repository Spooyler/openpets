import { isAbsolute, join } from "node:path";

export const vsCodeMcpServerName = "openpets";
export const openPetsMcpPackageName = "@open-pets/mcp";
export type VsCodeCommandMode = "published" | "local" | "bundled";

export interface VsCodeMcpEntry {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
}

export interface VsCodeMcpConfig {
  readonly servers?: {
    readonly openpets?: VsCodeMcpEntry | unknown;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface VsCodeMcpPreviewOptions {
  readonly mcpVersion: string;
  readonly petId?: string;
  readonly commandMode?: VsCodeCommandMode;
  readonly mcpEntryPath?: string;
}

export function validateOpenPetsPetId(value: string): string {
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length < 1) throw new Error("Invalid OpenPets pet id.");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed)) throw new Error("Invalid OpenPets pet id.");
  return trimmed;
}

export function isValidPetId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

export function buildVsCodeMcpEntry(options: VsCodeMcpPreviewOptions): VsCodeMcpEntry {
  const petArgs = options.petId === undefined ? [] : ["--pet", validateOpenPetsPetId(options.petId)];
  const mode = options.commandMode ?? "published";
  if (mode === "local" || mode === "bundled") {
    if (!options.mcpEntryPath || !isAbsolute(options.mcpEntryPath)) {
      throw new Error("VS Code local MCP preview requires an absolute MCP entry path.");
    }
    return { type: "stdio", command: "node", args: [options.mcpEntryPath, ...petArgs] };
  }
  validateOpenPetsPackageVersion(options.mcpVersion);
  return { type: "stdio", command: "npx", args: ["-y", `${openPetsMcpPackageName}@${options.mcpVersion}`, ...petArgs] };
}

export function validateOpenPetsPackageVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(value)) {
    throw new Error("Invalid OpenPets package version.");
  }
  return value;
}

export function formatVsCodeMcpConfig(options: VsCodeMcpPreviewOptions): VsCodeMcpConfig {
  return { servers: { [vsCodeMcpServerName]: buildVsCodeMcpEntry(options) } };
}

export function getVsCodeGlobalMcpPath(platform: NodeJS.Platform, homeDir: string, appDataDir?: string): string {
  if (platform === "win32") {
    const appData = appDataDir ?? join(homeDir, "AppData", "Roaming");
    return join(appData, "Code", "User", "mcp.json");
  }
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  return join(homeDir, ".config", "Code", "User", "mcp.json");
}

export function getVsCodeWorkspaceMcpPath(workspaceDir: string): string {
  return join(workspaceDir, ".vscode", "mcp.json");
}
