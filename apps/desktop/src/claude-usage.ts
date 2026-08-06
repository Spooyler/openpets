/**
 * Pure, electron-free core for the `agent:usage` plugin event: parses the
 * Claude OAuth usage API response, accumulates per-model token usage from
 * Claude Code transcript JSONL lines, and computes cost-weighted shares.
 * Extracted from claude-usage-collector.ts so it can be unit-tested under
 * plain Node without Electron or the filesystem.
 */

export interface ClaudeUsageBucket {
  id: string;
  label: string;
  utilization: number;
  resetsAt?: string;
}

export interface ClaudeUsageModelTotals {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ClaudeUsageModel extends ClaudeUsageModelTotals {
  /** Cost-weighted share of the session across models, 0–1. */
  weightedShare: number;
}

export interface ClaudeUsageApiSnapshot {
  buckets: ClaudeUsageBucket[];
  /** Start of the current 5h session window (resets_at − 5h), epoch ms. */
  sessionWindowStartMs?: number;
}

export interface AgentUsagePayload {
  updatedAt: number;
  stale: boolean;
  buckets: ClaudeUsageBucket[];
  models: ClaudeUsageModel[];
}

const sessionWindowMs = 5 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Usage API response parsing
// ---------------------------------------------------------------------------

const limitKindLabels: Record<string, string> = {
  session: "Session",
  weekly_all: "Week (all)",
  weekly_scoped: "Week",
};

function bucketFromLimit(limit: unknown): ClaudeUsageBucket | null {
  if (!isRecord(limit)) return null;
  const kind = typeof limit.kind === "string" ? limit.kind : "";
  const percent = typeof limit.percent === "number" ? limit.percent : null;
  if (!kind || percent === null) return null;
  const scope = isRecord(limit.scope) ? limit.scope : undefined;
  const scopeModel = scope && isRecord(scope.model) ? scope.model : undefined;
  const scopeName = scopeModel && typeof scopeModel.display_name === "string" ? scopeModel.display_name : undefined;
  const base = limitKindLabels[kind] ?? kind;
  return {
    id: scopeName ? `${kind}:${scopeName}` : kind,
    label: scopeName ? `${base} (${scopeName})` : base,
    utilization: percent,
    resetsAt: typeof limit.resets_at === "string" ? limit.resets_at : undefined,
  };
}

const legacyBucketFields: Array<{ field: string; id: string; label: string }> = [
  { field: "five_hour", id: "session", label: "Session" },
  { field: "seven_day", id: "weekly_all", label: "Week (all)" },
  { field: "seven_day_opus", id: "weekly_opus", label: "Week (Opus)" },
  { field: "seven_day_sonnet", id: "weekly_sonnet", label: "Week (Sonnet)" },
];

/** Parse the OAuth usage endpoint response. Malformed input yields no buckets. */
export function parseUsageApiResponse(data: unknown): ClaudeUsageApiSnapshot {
  if (!isRecord(data)) return { buckets: [] };

  let buckets: ClaudeUsageBucket[] = [];
  if (Array.isArray(data.limits)) {
    buckets = data.limits.map(bucketFromLimit).filter((b): b is ClaudeUsageBucket => b !== null);
  }
  if (buckets.length === 0) {
    for (const { field, id, label } of legacyBucketFields) {
      const entry = data[field];
      if (!isRecord(entry) || typeof entry.utilization !== "number") continue;
      buckets.push({
        id,
        label,
        utilization: entry.utilization,
        resetsAt: typeof entry.resets_at === "string" ? entry.resets_at : undefined,
      });
    }
  }

  const session = buckets.find((b) => b.id === "session");
  let sessionWindowStartMs: number | undefined;
  if (session?.resetsAt) {
    const resetMs = Date.parse(session.resetsAt);
    if (Number.isFinite(resetMs)) sessionWindowStartMs = resetMs - sessionWindowMs;
  }
  return { buckets, sessionWindowStartMs };
}

// ---------------------------------------------------------------------------
// Transcript accumulation
// ---------------------------------------------------------------------------

export interface TranscriptAccumulator {
  /** Feed one raw JSONL line. Malformed or out-of-window lines are ignored. */
  addLine(line: string): void;
  /** Per-model token totals accumulated so far. */
  totals(): ClaudeUsageModelTotals[];
}

/** Accumulates per-model usage from transcript lines inside the session window. */
export function createTranscriptAccumulator(windowStartMs: number): TranscriptAccumulator {
  const seen = new Set<string>();
  const byModel = new Map<string, ClaudeUsageModelTotals>();

  return {
    addLine(line: string): void {
      if (!line || line.length < 2) return;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(entry) || entry.type !== "assistant") return;
      const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(timestamp) || timestamp < windowStartMs) return;
      const message = entry.message;
      if (!isRecord(message) || typeof message.model !== "string") return;
      // Claude Code writes error-placeholder entries under the pseudo-model
      // "<synthetic>"; they carry no real usage.
      if (message.model === "<synthetic>") return;
      const usage = message.usage;
      if (!isRecord(usage)) return;

      const dedupeKey = `${typeof message.id === "string" ? message.id : ""}:${typeof entry.requestId === "string" ? entry.requestId : ""}`;
      if (dedupeKey !== ":" && seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const totals = byModel.get(message.model) ?? {
        model: message.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
      totals.inputTokens += typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      totals.outputTokens += typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      totals.cacheCreationTokens += typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
      totals.cacheReadTokens += typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
      byModel.set(message.model, totals);
    },
    totals(): ClaudeUsageModelTotals[] {
      return [...byModel.values()];
    },
  };
}

/**
 * Splits an incremental read buffer into complete JSONL lines. A trailing
 * partial line (writer mid-append) is left unconsumed so the caller's byte
 * offset only ever advances past newline-terminated lines.
 */
export function consumeJsonlLines(buffer: Buffer): { lines: string[]; consumedBytes: number } {
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], consumedBytes: 0 };
  const lines = buffer
    .subarray(0, lastNewline)
    .toString("utf8")
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  return { lines, consumedBytes: lastNewline + 1 };
}

// ---------------------------------------------------------------------------
// Cost weighting
// ---------------------------------------------------------------------------

/** $/MTok rates; cache write bills at 1.25× input, cache read at 0.1× input. */
const modelRates: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /fable|mythos/, input: 10, output: 50 },
  { match: /opus-4-[01]\b/, input: 15, output: 75 },
  { match: /opus/, input: 5, output: 25 },
  { match: /haiku/, input: 1, output: 5 },
  { match: /sonnet/, input: 3, output: 15 },
];
const defaultRate = { input: 3, output: 15 };

function weightedUnits(totals: ClaudeUsageModelTotals): number {
  const rate = modelRates.find((r) => r.match.test(totals.model)) ?? defaultRate;
  return (
    totals.inputTokens * rate.input +
    totals.outputTokens * rate.output +
    totals.cacheCreationTokens * rate.input * 1.25 +
    totals.cacheReadTokens * rate.input * 0.1
  );
}

/** Adds cost-weighted 0–1 shares and sorts largest-first. */
export function computeWeightedShares(totals: ClaudeUsageModelTotals[]): ClaudeUsageModel[] {
  const units = totals.map((t) => ({ totals: t, units: weightedUnits(t) }));
  const sum = units.reduce((acc, u) => acc + u.units, 0);
  return units
    .map((u) => ({ ...u.totals, weightedShare: sum > 0 ? u.units / sum : 0 }))
    .sort((a, b) => b.weightedShare - a.weightedShare);
}

// ---------------------------------------------------------------------------
// Event payload
// ---------------------------------------------------------------------------

/** Builds the canonical `agent:usage` event payload. */
export function buildAgentUsagePayload(input: {
  buckets: ClaudeUsageBucket[];
  models: ClaudeUsageModel[];
  now: number;
  stale: boolean;
}): AgentUsagePayload {
  return {
    updatedAt: input.now,
    stale: input.stale,
    buckets: input.buckets,
    models: input.models,
  };
}
