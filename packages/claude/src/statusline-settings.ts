import { existsSync } from "node:fs";

import type { OpenPetsCommandMode } from "./claude-code.js";
import { backupSettings, createOpenPetsHookCommand, getClaudeUserSettingsPath, openPetsHookMarker, readClaudeSettings, writeClaudeSettings } from "./hook-settings.js";

export type ClaudeStatuslineInstallStatus = "not_installed" | "installed" | "needs_update" | "conflict" | "error";

export interface ClaudeStatuslineDoctorResult {
  readonly status: ClaudeStatuslineInstallStatus;
  readonly settingsPath: string;
  readonly exists: boolean;
  readonly valid: boolean;
  readonly message: string;
  readonly backupPath?: string;
  readonly preview: Record<string, unknown>;
}

export interface ClaudeStatuslineWriteResult extends ClaudeStatuslineDoctorResult {
  readonly changed: boolean;
}

export function createOpenPetsStatuslineCommand(commandMode: OpenPetsCommandMode = "published", selectedPetId?: string, nodeCommand = "node", explicitCliPath?: string): string {
  return createOpenPetsHookCommand(commandMode, selectedPetId, nodeCommand, explicitCliPath, "statusline");
}

export function createOpenPetsStatuslineEntry(commandMode: OpenPetsCommandMode = "published", selectedPetId?: string, nodeCommand = "node", explicitCliPath?: string): Record<string, unknown> {
  // Event-driven only: refreshInterval is intentionally absent so the ping
  // can never fire while the session idles at the prompt.
  return { type: "command", command: createOpenPetsStatuslineCommand(commandMode, selectedPetId, nodeCommand, explicitCliPath), padding: 0 };
}

export function doctorClaudeStatusline(settingsPath = getClaudeUserSettingsPath(), commandMode: OpenPetsCommandMode = "published", selectedPetId?: string, nodeCommand = "node", explicitCliPath?: string): ClaudeStatuslineDoctorResult {
  const preview = { statusLine: createOpenPetsStatuslineEntry(commandMode, selectedPetId, nodeCommand, explicitCliPath) };
  try {
    const settings = readClaudeSettings(settingsPath);
    const status = getStatuslineInstallStatus(settings, commandMode, selectedPetId, nodeCommand, explicitCliPath);
    return {
      status,
      settingsPath,
      exists: existsSync(settingsPath),
      valid: true,
      message: statusMessage(status, selectedPetId),
      preview,
    };
  } catch (error) {
    return { status: "error", settingsPath, exists: existsSync(settingsPath), valid: false, message: error instanceof Error ? error.message : "Claude statusline settings are invalid.", preview };
  }
}

export function installClaudeStatusline(settingsPath = getClaudeUserSettingsPath(), commandMode: OpenPetsCommandMode = "published", selectedPetId?: string, nodeCommand = "node", explicitCliPath?: string): ClaudeStatuslineWriteResult {
  const doctor = doctorClaudeStatusline(settingsPath, commandMode, selectedPetId, nodeCommand, explicitCliPath);
  if (doctor.status === "installed" || doctor.status === "conflict" || doctor.status === "error") return { ...doctor, changed: false };
  const settings = readClaudeSettings(settingsPath);
  const backupPath = backupSettings(settingsPath);
  const next = { ...settings, statusLine: createOpenPetsStatuslineEntry(commandMode, selectedPetId, nodeCommand, explicitCliPath) };
  writeClaudeSettings(settingsPath, next);
  return { ...doctorClaudeStatusline(settingsPath, commandMode, selectedPetId, nodeCommand, explicitCliPath), backupPath, changed: true };
}

export function uninstallClaudeStatusline(settingsPath = getClaudeUserSettingsPath()): ClaudeStatuslineWriteResult {
  const doctor = doctorClaudeStatusline(settingsPath);
  try {
    const settings = readClaudeSettings(settingsPath);
    if (!isManagedStatusline(settings.statusLine)) return { ...doctor, changed: false };
    const backupPath = backupSettings(settingsPath);
    const next = { ...settings };
    delete next.statusLine;
    writeClaudeSettings(settingsPath, next);
    return { ...doctorClaudeStatusline(settingsPath), backupPath, changed: true };
  } catch {
    return { ...doctor, changed: false };
  }
}

function getStatuslineInstallStatus(settings: Record<string, unknown>, commandMode: OpenPetsCommandMode, selectedPetId?: string, nodeCommand = "node", explicitCliPath?: string): ClaudeStatuslineInstallStatus {
  const entry = settings.statusLine;
  if (entry === undefined) return "not_installed";
  if (!isRecord(entry)) throw new Error("Claude settings statusLine field is not an object.");
  if (!isManagedStatusline(entry)) return "conflict";
  const expectedCommand = createOpenPetsStatuslineCommand(commandMode, selectedPetId, nodeCommand, explicitCliPath);
  return entry.type === "command" && entry.command === expectedCommand && entry.padding === 0 ? "installed" : "needs_update";
}

function isManagedStatusline(entry: unknown): boolean {
  return isRecord(entry) && typeof entry.command === "string" && entry.command.includes(openPetsHookMarker);
}

function statusMessage(status: ClaudeStatuslineInstallStatus, selectedPetId?: string): string {
  const target = selectedPetId ? `Statusline pings target ${selectedPetId}.` : "Statusline pings target the default pet.";
  if (status === "installed") return `OpenPets Claude statusline is installed. ${target}`;
  if (status === "needs_update") return `OpenPets Claude statusline needs update. ${target}`;
  if (status === "conflict") return "A custom statusLine already exists in Claude settings. OpenPets will not replace it.";
  return `OpenPets Claude statusline is not installed. ${target}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
