import { basename } from "node:path";

import { createOpenPetsClient, readDiscoveryFile, sendRequest } from "@open-pets/client";

import { getDefaultThrottlePath, readLimitedStdin, shouldSendThrottleKey } from "./hooks.js";

const maxStatuslineInputBytes = 64 * 1024;
const statuslinePingCooldownMs = 5_000;
const fallbackText = "🐾 OpenPets";

interface StatuslineLeaseClient {
  acquireLease(options?: { readonly requestedPetId?: string }): Promise<{ readonly leaseId: string }>;
}

export interface ClaudeStatuslineOptions {
  readonly configuredPetId?: string;
  readonly throttlePath?: string;
  readonly now?: () => number;
  readonly write?: (line: string) => void;
  readonly sendActivity?: (leaseId?: string) => Promise<unknown>;
  readonly client?: StatuslineLeaseClient;
  readonly debug?: boolean;
}

export async function runClaudeStatuslineFromStdin(stdin: NodeJS.ReadStream = process.stdin, options: ClaudeStatuslineOptions = {}): Promise<number> {
  try {
    const raw = await readLimitedStdin(stdin, maxStatuslineInputBytes);
    await handleClaudeStatuslinePayload(raw, options);
  } catch (error) {
    // The statusline must always render something; an oversized or unreadable
    // payload still gets the fallback text.
    (options.write ?? defaultWrite)(fallbackText);
    if (options.debug || process.env.OPENPETS_DEBUG === "1") {
      process.stderr.write(`OpenPets statusline ignored error: ${sanitizeDebugError(error)}\n`);
    }
  }
  return 0;
}

export async function handleClaudeStatuslinePayload(raw: string, options: ClaudeStatuslineOptions = {}): Promise<{ readonly text: string; readonly pinged: boolean }> {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (isRecord(parsed)) payload = parsed;
  } catch {
    // Malformed statusline payloads still render the fallback text.
  }
  const text = formatStatuslineText(payload);
  (options.write ?? defaultWrite)(text);

  const now = options.now?.() ?? Date.now();
  const throttlePath = options.throttlePath ?? getDefaultThrottlePath();
  if (!shouldSendThrottleKey("statusline", statuslinePingCooldownMs, now, throttlePath)) {
    return { text, pinged: false };
  }

  try {
    const leaseId = options.configuredPetId ? (await acquireLease(options)).leaseId : undefined;
    await (options.sendActivity ?? defaultSendActivity)(leaseId);
    return { text, pinged: true };
  } catch (error) {
    if (options.debug || process.env.OPENPETS_DEBUG === "1") {
      process.stderr.write(`OpenPets statusline ping failed: ${sanitizeDebugError(error)}\n`);
    }
    return { text, pinged: false };
  }
}

export function formatStatuslineText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const model = isRecord(payload.model) && typeof payload.model.display_name === "string" ? sanitizeSegment(payload.model.display_name) : "";
  if (model) parts.push(model);
  const workspace = isRecord(payload.workspace) && typeof payload.workspace.current_dir === "string" ? sanitizeSegment(basename(payload.workspace.current_dir.replaceAll("\\", "/"))) : "";
  if (workspace) parts.push(workspace);
  const usedPercentage = isRecord(payload.context_window) ? payload.context_window.used_percentage : undefined;
  if (typeof usedPercentage === "number" && Number.isFinite(usedPercentage)) parts.push(`ctx ${Math.round(usedPercentage)}%`);
  if (parts.length === 0) return fallbackText;
  if (!model) parts.unshift("OpenPets");
  return `🐾 ${parts.join(" · ")}`;
}

async function acquireLease(options: ClaudeStatuslineOptions): Promise<{ readonly leaseId: string }> {
  const client: StatuslineLeaseClient = options.client ?? createOpenPetsClient({ connectTimeoutMs: 500, responseTimeoutMs: 500 });
  return client.acquireLease({ requestedPetId: options.configuredPetId });
}

async function defaultSendActivity(leaseId?: string): Promise<unknown> {
  const discovery = readDiscoveryFile();
  return sendRequest(discovery, "agent.activity", { leaseId }, { connectTimeoutMs: 500, responseTimeoutMs: 500 });
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}

function sanitizeSegment(value: string): string {
  // Reject (rather than strip) control characters so mangled input falls back
  // cleanly; inner spaces are fine — real model names contain them.
  if (/[\r\n\t]/.test(value)) return "";
  const cleaned = value.trim();
  return cleaned.length > 0 && cleaned.length <= 60 ? cleaned : "";
}

function sanitizeDebugError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, "<path>").slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
