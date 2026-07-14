/**
 * notification-view.ts — pure builders for notification badge + flyout markup.
 *
 * No Electron dependency; safe to import from main process and tests.
 * Pet-window.ts consumes the view/markup; controllers build it from stores.
 */

import type { NotificationEntry } from "./notification-store.js";

export interface PetNotificationsView {
  readonly open: boolean;
  readonly unresolvedCount: number;
  readonly rows: readonly {
    sessionKey: string;
    label: string;
    message: string;
    ageText: string;
    state: "unresolved" | "resolved";
    error?: boolean;
  }[];
}

/** Max rows rendered in the flyout (12-row cap keeps bodyHtml under 64 KB). */
const MAX_ROWS = 12;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ageText(updatedAt: number, now: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const deltaMs = Math.max(0, now - updatedAt);
  const deltaSec = Math.floor(deltaMs / 1_000);
  if (deltaSec < 60) return t("pet.notify.ageNow");
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return t("pet.notify.ageMinutes", { m: deltaMin });
  const deltaHr = Math.floor(deltaMin / 60);
  return t("pet.notify.ageHours", { h: deltaHr });
}


export function buildNotificationsView(
  entries: readonly NotificationEntry[],
  open: boolean,
  now: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
  errorSessionKeys?: ReadonlySet<string>,
): PetNotificationsView {
  let unresolvedCount = 0;
  const rows: PetNotificationsView["rows"][number][] = [];
  for (const entry of entries) {
    if (entry.state === "dismissed") continue;
    if (entry.state === "unresolved") unresolvedCount += 1;
    if (rows.length < MAX_ROWS) {
      rows.push({
        sessionKey: entry.sessionKey,
        label: entry.label,
        message: entry.message,
        ageText: ageText(entry.updatedAt, now, t),
        state: entry.state as "unresolved" | "resolved",
        error: errorSessionKeys?.has(entry.sessionKey) || undefined,
      });
    }
  }
  return { open, unresolvedCount, rows };
}

export function createNotificationsMarkup(
  view: PetNotificationsView,
  t: (key: string, vars?: Record<string, string | number>) => string,
): { badge: string; flyout: string } {
  // Badge: visible when count > 0 or flyout is open.
  let badge = "";
  if (view.unresolvedCount > 0 || view.open) {
    const countLabel = view.unresolvedCount > 0 ? String(view.unresolvedCount) : "0";
    const ariaLabel = escapeHtml(t("pet.notify.badgeLabel", { count: view.unresolvedCount }));
    badge = `<div class="notify-badge" data-count="${escapeHtml(countLabel)}" role="status" aria-label="${ariaLabel}">${escapeHtml(countLabel)}</div>`;
  }

  // Flyout: only when open.
  let flyout = "";
  if (view.open) {
    const rowsHtml = view.rows.length > 0
      ? view.rows.map((row) => {
          const stateClass = row.state === "unresolved" ? " is-unresolved" : "";
          const errorClass = row.error ? " is-error" : "";
          return `<div class="notify-row${stateClass}${errorClass}" data-notify-row data-session-key="${escapeHtml(row.sessionKey)}"><span class="notify-dot"></span><span class="notify-label">${escapeHtml(row.label)}</span><span class="notify-message">${escapeHtml(row.message)}</span><span class="notify-age">${escapeHtml(row.ageText)}</span></div>`;
        }).join("")
      : `<div class="notify-empty">${escapeHtml(t("pet.notify.empty"))}</div>`;

    flyout = `<div class="notify-flyout">${rowsHtml}</div>`;
  }

  return { badge, flyout };
}

export function notificationsCacheKey(view: PetNotificationsView | null | undefined): string {
  if (!view) return "n:none";
  const rowKeys = view.rows.map((r) => `${r.sessionKey}:${r.state}:${r.ageText}${r.error ? ":err" : ""}`).join(",");
  return `n:${view.open}:${view.unresolvedCount}:${rowKeys}`;
}
