import assert from "node:assert/strict";
import {
  buildNotificationsView,
  createNotificationsMarkup,
  notificationsCacheKey,
  buildGroupedNotificationsView,
  createGroupedNotificationsMarkup,
} from "../src/notification-view.js";
import type { NotificationEntry } from "../src/notification-store.js";
import type { LiveStatus } from "../src/session-live-status.js";

// Minimal t() stub matching the EN catalog shape.
const enMessages: Record<string, string> = {
  "pet.notify.ageNow": "now",
  "pet.notify.ageMinutes": "{m}m",
  "pet.notify.ageHours": "{h}h",
  "pet.notify.badgeLabel": "{count} sessions need attention",
  "pet.notify.empty": "All quiet",
};
function t(key: string, vars?: Record<string, string | number>): string {
  let template = enMessages[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) template = template.replaceAll(`{${k}}`, String(v));
  return template;
}

// --- buildNotificationsView ---

const baseTime = 1_000_000;

const entries: readonly NotificationEntry[] = [
  { sessionKey: "s1", windowKey: "w:1", kind: "waiting", message: "needs permission", label: "fraud_project", updatedAt: baseTime - 30_000, firstUnresolvedAt: baseTime - 30_000, state: "unresolved" },
  { sessionKey: "s2", windowKey: "w:2", kind: "success", message: "turn done", label: "api-fix", updatedAt: baseTime - 300_000, firstUnresolvedAt: baseTime - 300_000, state: "unresolved" },
  { sessionKey: "s3", windowKey: "w:1", kind: "message", message: "refactoring", label: "webapp", updatedAt: baseTime - 10_800_000, firstUnresolvedAt: baseTime - 10_800_000, state: "resolved" },
];

const view = buildNotificationsView(entries, true, baseTime, t);

// Ordering matches input (rows() order: unresolved oldest-first, then resolved recency).
assert.equal(view.rows.length, 3, "all non-dismissed entries present");
assert.equal(view.rows[0]!.sessionKey, "s1");
assert.equal(view.rows[1]!.sessionKey, "s2");
assert.equal(view.rows[2]!.sessionKey, "s3");

// Unresolved count.
assert.equal(view.unresolvedCount, 2, "two unresolved");

// Age text buckets.
assert.equal(view.rows[0]!.ageText, "now", "30s -> now");
assert.equal(view.rows[1]!.ageText, "5m", "300s -> 5m");
assert.equal(view.rows[2]!.ageText, "3h", "10800s -> 3h");

// Dismissed entries are excluded.
const withDismissed: NotificationEntry[] = [
  ...entries,
  { sessionKey: "s4", kind: "message", message: "x", label: "l", updatedAt: baseTime, firstUnresolvedAt: baseTime, state: "dismissed" },
];
const view2 = buildNotificationsView(withDismissed, false, baseTime, t);
assert.equal(view2.rows.length, 3, "dismissed excluded");
assert.equal(view2.unresolvedCount, 2);
assert.equal(view2.open, false);

// --- createNotificationsMarkup: escaping ---

const xssEntries: readonly NotificationEntry[] = [
  { sessionKey: '<script>alert(1)</script>', kind: "message", message: '<img onerror="alert(1)">', label: '<b>bold</b>', updatedAt: baseTime, firstUnresolvedAt: baseTime, state: "unresolved" },
];
const xssView = buildNotificationsView(xssEntries, true, baseTime, t);
const xssMarkup = createNotificationsMarkup(xssView, t);
const xssHtml = xssMarkup.badge + xssMarkup.flyout;
assert.ok(!xssHtml.includes("<script>"), "sessionKey escaped");
assert.ok(!xssHtml.includes('<img onerror'), "message escaped");
assert.ok(!xssHtml.includes("<b>"), "label escaped");
assert.ok(xssHtml.includes("&lt;script&gt;"), "sessionKey HTML-escaped");
assert.ok(xssHtml.includes("&lt;b&gt;"), "label HTML-escaped");

// --- createNotificationsMarkup: 12-row cap ---

const manyEntries: NotificationEntry[] = [];
for (let i = 0; i < 15; i++) {
  manyEntries.push({ sessionKey: `s${i}`, kind: "message", message: `msg ${i}`, label: `label ${i}`, updatedAt: baseTime - i * 1_000, firstUnresolvedAt: baseTime - i * 1_000, state: "unresolved" });
}
const manyView = buildNotificationsView(manyEntries, true, baseTime, t);
assert.equal(manyView.rows.length, 12, "capped at 12 rows");
assert.equal(manyView.unresolvedCount, 15, "unresolvedCount counts all, not just displayed rows");

const manyMarkup = createNotificationsMarkup(manyView, t);
const rowCount = (manyMarkup.flyout.match(/data-notify-row/g) || []).length;
assert.equal(rowCount, 12, "HTML renders exactly 12 rows");

// --- createNotificationsMarkup: empty flyout ---

const emptyView = buildNotificationsView([], true, baseTime, t);
assert.equal(emptyView.unresolvedCount, 0);
assert.equal(emptyView.rows.length, 0);
const emptyMarkup = createNotificationsMarkup(emptyView, t);
assert.ok(emptyMarkup.flyout.includes("All quiet"), "empty message shown");
assert.ok(emptyMarkup.flyout.includes("notify-flyout"), "flyout still rendered when open");
assert.ok(emptyMarkup.badge.includes("notify-badge"), "badge rendered when open even with count=0");

// --- createNotificationsMarkup: badge hidden when closed and count=0 ---

const closedEmptyView = buildNotificationsView([], false, baseTime, t);
const closedEmptyMarkup = createNotificationsMarkup(closedEmptyView, t);
assert.equal(closedEmptyMarkup.badge, "", "no badge when count=0 and closed");
assert.equal(closedEmptyMarkup.flyout, "", "no flyout when closed");

// --- createNotificationsMarkup: badge visible when count>0 and closed ---

const closedWithCount = buildNotificationsView(entries.slice(0, 1), false, baseTime, t);
const closedWithCountMarkup = createNotificationsMarkup(closedWithCount, t);
assert.ok(closedWithCountMarkup.badge.includes("notify-badge"), "badge shown when count>0");
assert.equal(closedWithCountMarkup.flyout, "", "no flyout when closed");

// --- createNotificationsMarkup: error row ---

{
  const errorEntries: readonly NotificationEntry[] = [
    { sessionKey: "e1", kind: "waiting", message: "needs focus", label: "err-proj", updatedAt: baseTime, firstUnresolvedAt: baseTime, state: "unresolved" },
    { sessionKey: "e2", kind: "message", message: "ok", label: "ok-proj", updatedAt: baseTime, firstUnresolvedAt: baseTime, state: "unresolved" },
  ];
  const errorKeys = new Set(["e1"]);
  const errorView = buildNotificationsView(errorEntries, true, baseTime, t, errorKeys);
  assert.equal(errorView.rows[0]!.error, true, "error flag set on matching row");
  assert.equal(errorView.rows[1]!.error, undefined, "error flag absent on non-matching row");
  const errorMarkup = createNotificationsMarkup(errorView, t);
  assert.ok(errorMarkup.flyout.includes("is-error"), "is-error class rendered on error row");
  // Count: exactly one error row
  const errorRowCount = (errorMarkup.flyout.match(/is-error/g) || []).length;
  assert.equal(errorRowCount, 1, "exactly one row has is-error class");
}

// --- notificationsCacheKey ---

assert.equal(notificationsCacheKey(null), "n:none");
assert.equal(notificationsCacheKey(undefined), "n:none");
const key1 = notificationsCacheKey(view);
assert.ok(key1.startsWith("n:true:2:"), "open view cacheKey starts with open:count");
const key2 = notificationsCacheKey(view2);
assert.ok(key2.startsWith("n:false:2:"), "closed view cacheKey starts with closed:count");
assert.notEqual(key1, key2, "different open states produce different keys");

// --- buildGroupedNotificationsView: groups by windowKey ---

{
  const groupedEntries: readonly NotificationEntry[] = [
    { sessionKey: "s1", windowKey: "w:1", kind: "waiting", message: "needs permission", label: "fraud_project", updatedAt: baseTime - 30_000, firstUnresolvedAt: baseTime - 30_000, state: "unresolved" },
    { sessionKey: "s2", windowKey: "w:2", kind: "success", message: "turn done", label: "api-fix", updatedAt: baseTime - 300_000, firstUnresolvedAt: baseTime - 300_000, state: "unresolved" },
    { sessionKey: "s3", windowKey: "w:1", kind: "message", message: "refactoring", label: "webapp", updatedAt: baseTime - 10_800_000, firstUnresolvedAt: baseTime - 10_800_000, state: "resolved" },
  ];
  const liveStatuses = new Map<string, LiveStatus>([["s1", "thinking"]]);
  const groupedView = buildGroupedNotificationsView(groupedEntries, true, baseTime, t, liveStatuses);

  assert.equal(groupedView.groups.length, 2, "two window groups");
  const w1 = groupedView.groups.find((g) => g.windowKey === "w:1")!;
  const w2 = groupedView.groups.find((g) => g.windowKey === "w:2")!;
  assert.equal(w1.rows.length, 2, "w:1 has two sessions");
  assert.equal(w2.rows.length, 1, "w:2 has one session");
  assert.equal(w1.sessionCount, 2);
  assert.equal(w2.sessionCount, 1);

  // Live status: present for s1, defaults to idle for s2/s3.
  const s1Row = w1.rows.find((r) => r.sessionKey === "s1")!;
  const s3Row = w1.rows.find((r) => r.sessionKey === "s3")!;
  const s2Row = w2.rows.find((r) => r.sessionKey === "s2")!;
  assert.equal(s1Row.liveStatus, "thinking", "live status used when present");
  assert.equal(s3Row.liveStatus, "idle", "defaults to idle when no live status");
  assert.equal(s2Row.liveStatus, "idle", "defaults to idle when no live status");

  // Unresolved count across all groups.
  assert.equal(groupedView.unresolvedCount, 2, "unresolved count spans groups");

  // Entries with no windowKey fall into "default" group.
  const noWindowEntries: readonly NotificationEntry[] = [
    { sessionKey: "s5", kind: "message", message: "x", label: "l", updatedAt: baseTime, firstUnresolvedAt: baseTime, state: "unresolved" },
  ];
  const noWindowView = buildGroupedNotificationsView(noWindowEntries, true, baseTime, t, new Map());
  assert.equal(noWindowView.groups.length, 1);
  assert.equal(noWindowView.groups[0]!.windowKey, "default");
}

// --- buildGroupedNotificationsView: MAX_GROUPED_ROWS cap ---

{
  const manyGroupedEntries: NotificationEntry[] = [];
  for (let i = 0; i < 60; i++) {
    manyGroupedEntries.push({ sessionKey: `g${i}`, windowKey: `w:${i % 3}`, kind: "message", message: `msg ${i}`, label: `label ${i}`, updatedAt: baseTime - i * 1_000, firstUnresolvedAt: baseTime - i * 1_000, state: "unresolved" });
  }
  const manyGroupedView = buildGroupedNotificationsView(manyGroupedEntries, true, baseTime, t, new Map());
  const totalRows = manyGroupedView.groups.reduce((sum, g) => sum + g.rows.length, 0);
  assert.equal(totalRows, 50, "capped at MAX_GROUPED_ROWS total rows across groups");
  assert.equal(manyGroupedView.unresolvedCount, 60, "unresolvedCount counts all, not just displayed rows");
}

// --- createGroupedNotificationsMarkup: HTML structure ---

{
  const markupEntries: readonly NotificationEntry[] = [
    { sessionKey: "m1", windowKey: "w:1", kind: "waiting", message: "needs input", label: "proj-a", updatedAt: baseTime, firstUnresolvedAt: baseTime, state: "unresolved" },
    { sessionKey: "m2", windowKey: "w:1", kind: "message", message: "done", label: "proj-b", updatedAt: baseTime, firstUnresolvedAt: baseTime, state: "resolved" },
  ];
  const liveStatuses = new Map<string, LiveStatus>([["m1", "running"]]);
  const markupView = buildGroupedNotificationsView(markupEntries, true, baseTime, t, liveStatuses);
  const markup = createGroupedNotificationsMarkup(markupView, t);

  assert.ok(markup.flyout.includes("notify-flyout-grouped"), "grouped flyout class present");
  assert.ok(markup.flyout.includes('data-window-key="w:1"'), "group header has window key");
  assert.ok(markup.flyout.includes("notify-group-label"), "group label rendered");
  assert.ok(markup.flyout.includes(">2<"), "session count rendered in group header");
  assert.ok(markup.flyout.includes("status-running"), "live status class rendered on status dot");
  assert.ok(markup.flyout.includes("status-idle"), "idle status class rendered for session with no live status");
  assert.ok(markup.flyout.includes("proj-a"), "session label rendered");
  assert.ok(markup.flyout.includes("is-unresolved"), "unresolved row class rendered");
  assert.ok(markup.badge.includes("notify-badge"), "badge rendered");

  // Empty groups.
  const emptyGroupedView = buildGroupedNotificationsView([], true, baseTime, t, new Map());
  const emptyGroupedMarkup = createGroupedNotificationsMarkup(emptyGroupedView, t);
  assert.ok(emptyGroupedMarkup.flyout.includes("All quiet"), "empty message shown for grouped view");

  // Closed view renders no flyout.
  const closedGroupedView = buildGroupedNotificationsView(markupEntries, false, baseTime, t, liveStatuses);
  const closedGroupedMarkup = createGroupedNotificationsMarkup(closedGroupedView, t);
  assert.equal(closedGroupedMarkup.flyout, "", "no flyout when closed");
}

console.log("notification-view: all assertions passed.");
