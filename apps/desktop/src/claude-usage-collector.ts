import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { debug, warn } from "./logger.js";
import {
  buildAgentUsagePayload,
  computeWeightedShares,
  consumeJsonlLines,
  createTranscriptAccumulator,
  parseUsageApiResponse,
  type AgentUsagePayload,
  type ClaudeUsageBucket,
  type ClaudeUsageModel,
  type TranscriptAccumulator,
} from "./claude-usage.js";
import { emitPluginEvent } from "./plugin-events-source.js";

/**
 * Host-side `agent:usage` producer: polls the Claude OAuth usage endpoint for
 * limit buckets and scans Claude Code transcript JSONLs for per-model session
 * usage, then emits the combined payload on the plugin senses bus. Lazy — the
 * loop starts on the first `agent:usage` subscription.
 *
 * Credentials are read-only: the collector never refreshes or rewrites the
 * OAuth token (Claude Code owns that file); on auth failure it just re-reads
 * on the next poll and marks the payload stale meanwhile.
 */

const pollMs = 60_000;
const usageEndpoint = "https://api.anthropic.com/api/oauth/usage";
const fallbackWindowMs = 5 * 60 * 60 * 1000;
const maxTranscriptChunkBytes = 8 * 1024 * 1024;

const claudeDir = join(homedir(), ".claude");
const credentialsPath = join(claudeDir, ".credentials.json");
const projectsDir = join(claudeDir, "projects");

let timer: NodeJS.Timeout | null = null;
let polling = false;
let lastPayload: AgentUsagePayload | null = null;
let lastBuckets: ClaudeUsageBucket[] = [];
let lastModels: ClaudeUsageModel[] = [];

let windowStartMs = 0;
let accumulator: TranscriptAccumulator | null = null;
const fileOffsets = new Map<string, number>();

/** Start the poll loop. Idempotent; called on first `agent:usage` subscribe. */
export function startClaudeUsageCollector(): void {
  if (timer) return;
  debug("plugin", "claude usage collector starting");
  timer = setInterval(() => void poll(), pollMs);
  timer.unref?.();
  void poll();
}

export function stopClaudeUsageCollector(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Last emitted payload, so late subscribers don't wait a full poll cycle. */
export function getLastAgentUsagePayload(): AgentUsagePayload | null {
  return lastPayload;
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  let stale = false;
  try {
    try {
      const snapshot = parseUsageApiResponse(await fetchUsageApi());
      if (snapshot.buckets.length === 0) throw new Error("usage response had no limit buckets");
      lastBuckets = snapshot.buckets;
      resetWindowIfChanged(snapshot.sessionWindowStartMs ?? Date.now() - fallbackWindowMs);
    } catch (error) {
      stale = true;
      warn("plugin", "claude usage api poll failed", { reason: error instanceof Error ? error.message : "unknown" });
    }

    if (accumulator) {
      try {
        await scanTranscripts(accumulator);
        lastModels = computeWeightedShares(accumulator.totals());
      } catch (error) {
        stale = true;
        warn("plugin", "claude usage transcript scan failed", { reason: error instanceof Error ? error.message : "unknown" });
      }
    }

    lastPayload = buildAgentUsagePayload({ buckets: lastBuckets, models: lastModels, now: Date.now(), stale });
    emitPluginEvent("agent:usage", lastPayload as unknown as Record<string, unknown>);
  } finally {
    polling = false;
  }
}

async function fetchUsageApi(): Promise<unknown> {
  const raw = await fs.readFile(credentialsPath, "utf8");
  const credentials = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
  const token = credentials.claudeAiOauth?.accessToken;
  if (!token) throw new Error("no Claude OAuth access token");
  const response = await fetch(usageEndpoint, {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`usage endpoint returned ${response.status}`);
  return response.json();
}

function resetWindowIfChanged(nextWindowStartMs: number): void {
  // The fallback start drifts with Date.now(); only a real window change
  // (new 5h session) should throw away accumulated totals and offsets.
  if (accumulator && Math.abs(nextWindowStartMs - windowStartMs) < 60_000) return;
  windowStartMs = nextWindowStartMs;
  accumulator = createTranscriptAccumulator(windowStartMs);
  fileOffsets.clear();
  lastModels = [];
  debug("plugin", "claude usage window reset", { windowStartMs });
}

async function scanTranscripts(acc: TranscriptAccumulator): Promise<void> {
  const projectDirs = await fs.readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const dirPath = join(projectsDir, projectDir.name);
    const files = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      await scanTranscriptFile(acc, join(dirPath, file.name));
    }
  }
}

async function scanTranscriptFile(acc: TranscriptAccumulator, path: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    fileOffsets.delete(path);
    return;
  }
  // A file untouched since the window opened has no in-window lines.
  if (stat.mtimeMs < windowStartMs) return;
  let offset = fileOffsets.get(path) ?? 0;
  if (stat.size < offset) offset = 0;
  if (stat.size === offset) return;

  const handle = await fs.open(path, "r");
  try {
    while (offset < stat.size) {
      const length = Math.min(stat.size - offset, maxTranscriptChunkBytes);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead <= 0) break;
      const { lines, consumedBytes } = consumeJsonlLines(buffer.subarray(0, bytesRead));
      if (consumedBytes === 0) break;
      for (const line of lines) acc.addLine(line);
      offset += consumedBytes;
    }
  } finally {
    await handle.close();
  }
  fileOffsets.set(path, offset);
}
