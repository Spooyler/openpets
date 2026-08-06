import assert from "node:assert/strict";
import {
  parseUsageApiResponse,
  createTranscriptAccumulator,
  computeWeightedShares,
  buildAgentUsagePayload,
  consumeJsonlLines,
} from "../src/claude-usage.js";

// ---------------------------------------------------------------------------
// parseUsageApiResponse — modern `limits[]` shape (captured 2026-07)
// ---------------------------------------------------------------------------
{
  const api = {
    five_hour: { utilization: 72.0, resets_at: "2026-07-27T11:10:00.647770+00:00" },
    seven_day: { utilization: 24.0, resets_at: "2026-07-31T07:00:00.647797+00:00" },
    seven_day_opus: null,
    limits: [
      { kind: "session", group: "session", percent: 72, severity: "normal", resets_at: "2026-07-27T11:10:00.647770+00:00", scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 24, severity: "normal", resets_at: "2026-07-31T07:00:00.647797+00:00", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 28, severity: "normal", resets_at: "2026-07-31T07:00:00.648061+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ],
  };
  const parsed = parseUsageApiResponse(api);
  assert.equal(parsed.buckets.length, 3);
  assert.deepEqual(parsed.buckets[0], {
    id: "session",
    label: "Session",
    utilization: 72,
    resetsAt: "2026-07-27T11:10:00.647770+00:00",
  });
  assert.equal(parsed.buckets[1].id, "weekly_all");
  assert.equal(parsed.buckets[1].label, "Week (all)");
  assert.equal(parsed.buckets[2].id, "weekly_scoped:Fable");
  assert.equal(parsed.buckets[2].label, "Week (Fable)");
  assert.equal(parsed.buckets[2].utilization, 28);
  // Session window start = session resets_at − 5h
  const expectedStart = Date.parse("2026-07-27T11:10:00.647770+00:00") - 5 * 60 * 60 * 1000;
  assert.equal(parsed.sessionWindowStartMs, expectedStart);
}

// parseUsageApiResponse — legacy fallback shape (no `limits` array)
{
  const api = {
    five_hour: { utilization: 62, resets_at: "2026-07-27T12:00:00+00:00" },
    seven_day: { utilization: 41, resets_at: "2026-07-30T07:00:00+00:00" },
    seven_day_opus: { utilization: 23, resets_at: "2026-07-30T07:00:00+00:00" },
  };
  const parsed = parseUsageApiResponse(api);
  assert.equal(parsed.buckets.length, 3);
  assert.equal(parsed.buckets[0].id, "session");
  assert.equal(parsed.buckets[0].utilization, 62);
  assert.equal(parsed.buckets[1].id, "weekly_all");
  assert.equal(parsed.buckets[2].id, "weekly_opus");
  assert.equal(parsed.buckets[2].label, "Week (Opus)");
  assert.ok(parsed.sessionWindowStartMs);
}

// parseUsageApiResponse — garbage input degrades to empty, never throws
{
  assert.deepEqual(parseUsageApiResponse(null).buckets, []);
  assert.deepEqual(parseUsageApiResponse("nope").buckets, []);
  assert.deepEqual(parseUsageApiResponse({ limits: "bad" }).buckets, []);
  assert.equal(parseUsageApiResponse(null).sessionWindowStartMs, undefined);
}

// ---------------------------------------------------------------------------
// createTranscriptAccumulator — per-model sums, window filter, dedupe
// ---------------------------------------------------------------------------
{
  const windowStart = Date.parse("2026-07-27T06:10:00Z");
  const acc = createTranscriptAccumulator(windowStart);

  const entry = (over: Record<string, unknown>, usage: Record<string, number>) =>
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-27T08:02:12.219Z",
      requestId: "req_1",
      message: { id: "msg_1", model: "claude-fable-5", usage },
      ...over,
    });

  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 };

  acc.addLine(entry({}, usage));
  acc.addLine(entry({}, usage)); // exact duplicate (same msg id + request id) — must not double-count
  acc.addLine(entry({ requestId: "req_2", message: { id: "msg_2", model: "claude-fable-5", usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }, usage));
  acc.addLine(entry({ requestId: "req_3", message: { id: "msg_3", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } }, usage));
  // before the window — ignored
  acc.addLine(entry({ timestamp: "2026-07-27T01:00:00Z", requestId: "req_4", message: { id: "msg_4", model: "claude-fable-5", usage } }, usage));
  // non-assistant and malformed lines — ignored, no throw
  acc.addLine(JSON.stringify({ type: "user", timestamp: "2026-07-27T08:00:00Z" }));
  acc.addLine("{not json");
  acc.addLine("");
  // Claude Code error-placeholder entries use the pseudo-model "<synthetic>" — ignored
  acc.addLine(entry({ requestId: "req_5", message: { id: "msg_5", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } }, usage));

  const totals = acc.totals();
  assert.equal(totals.length, 2);
  const fable = totals.find((t) => t.model === "claude-fable-5");
  const haiku = totals.find((t) => t.model === "claude-haiku-4-5-20251001");
  assert.ok(fable && haiku);
  assert.equal(fable.inputTokens, 15);
  assert.equal(fable.outputTokens, 25);
  assert.equal(fable.cacheCreationTokens, 100);
  assert.equal(fable.cacheReadTokens, 1000);
  assert.equal(haiku.inputTokens, 1);
  assert.equal(haiku.cacheReadTokens, 4);
}

// ---------------------------------------------------------------------------
// computeWeightedShares — cost-weighted share of the session
// ---------------------------------------------------------------------------
{
  const totals = [
    { model: "claude-fable-5", inputTokens: 100, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 },
    { model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ];
  const models = computeWeightedShares(totals);
  // Fable $10/$50 vs Haiku $1/$5 per MTok → weights 6000 vs 600 → shares 10/11 vs 1/11
  const fable = models.find((m) => m.model === "claude-fable-5");
  const haiku = models.find((m) => m.model === "claude-haiku-4-5");
  assert.ok(fable && haiku);
  assert.ok(Math.abs(fable.weightedShare - 10 / 11) < 1e-9, `fable share ${fable.weightedShare}`);
  assert.ok(Math.abs(haiku.weightedShare - 1 / 11) < 1e-9, `haiku share ${haiku.weightedShare}`);
  // token counts carried through
  assert.equal(fable.inputTokens, 100);
  // sorted by share, largest first
  assert.equal(models[0].model, "claude-fable-5");
}

// cache tokens are weighted (write 1.25× input rate, read 0.1× input rate)
{
  const models = computeWeightedShares([
    { model: "claude-opus-4-8", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1000, cacheReadTokens: 0 },
    { model: "claude-opus-4-8-x", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 12_500 },
  ]);
  // write: 1000 × 1.25 × $5 = 6250; read: 12500 × 0.1 × $5 = 6250 → equal shares
  assert.ok(Math.abs(models[0].weightedShare - 0.5) < 1e-9);
  assert.ok(Math.abs(models[1].weightedShare - 0.5) < 1e-9);
}

// zero tokens → zero shares, no NaN
{
  const models = computeWeightedShares([
    { model: "claude-opus-4-8", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ]);
  assert.equal(models[0].weightedShare, 0);
}

// ---------------------------------------------------------------------------
// consumeJsonlLines — incremental read: complete lines only, byte-accurate
// ---------------------------------------------------------------------------
{
  const buf = Buffer.from('{"a":1}\n{"b":2}\n{"partial', "utf8");
  const res = consumeJsonlLines(buf);
  assert.deepEqual(res.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(res.consumedBytes, Buffer.byteLength('{"a":1}\n{"b":2}\n'));
}

// no newline yet → nothing consumed, offset must not advance
{
  const res = consumeJsonlLines(Buffer.from("no newline yet", "utf8"));
  assert.deepEqual(res.lines, []);
  assert.equal(res.consumedBytes, 0);
}

// CRLF endings are tolerated; multi-byte chars keep byte offsets accurate
{
  const buf = Buffer.from('{"a":"í"}\r\n{"tail', "utf8");
  const res = consumeJsonlLines(buf);
  assert.deepEqual(res.lines, ['{"a":"í"}']);
  assert.equal(res.consumedBytes, Buffer.byteLength('{"a":"í"}\r\n'));
}

// ---------------------------------------------------------------------------
// buildAgentUsagePayload — event payload shape
// ---------------------------------------------------------------------------
{
  const payload = buildAgentUsagePayload({
    buckets: [{ id: "session", label: "Session", utilization: 72, resetsAt: "2026-07-27T11:10:00Z" }],
    models: computeWeightedShares([
      { model: "claude-fable-5", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ]),
    now: 1_700_000_000_000,
    stale: false,
  });
  assert.equal(payload.updatedAt, 1_700_000_000_000);
  assert.equal(payload.stale, false);
  assert.equal(payload.buckets.length, 1);
  assert.equal(payload.models.length, 1);
  assert.equal(payload.models[0].model, "claude-fable-5");
}

console.log("Claude usage core tests passed.");
