/**
 * vscode-tab-focus.ts
 *
 * Parked-request registry for the VS Code extension's `vscode.wait-focus`
 * long-poll. Each connected VS Code window keeps one request parked here;
 * `requestTabReveal` completes ALL of them with the session's ancestor PID
 * chain and only the window whose integrated terminal owns a PID in the
 * chain acts (the others just re-arm). Stateless matching keeps this module
 * free of any window/terminal bookkeeping.
 *
 * Socket lifetime is the caller's concern: local-ipc parks the entry with a
 * `respond` callback bound to the socket and calls `pruneWaitFocus` when the
 * socket closes. A keepalive timer answers `{ command: null }` so clients
 * re-arm and dead-connection detection keeps working.
 *
 * logger is lazy-loaded via createRequire (same pattern as
 * pet-fallback-notify.ts) so this module stays importable — and, unlike that
 * module, actually callable — from the plain-Node test suite: logger.ts reads
 * `electron`'s `app.isPackaged` at module-load time, which throws outside an
 * Electron process. Logging failures are swallowed; they must never affect
 * parked-request behavior.
 */

import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

type LoggerModule = typeof import("./logger.js");

function debug(scope: "terminal-focus", message: string, fields?: Record<string, unknown>): void {
  try {
    (nodeRequire("./logger.js") as LoggerModule).debug(scope, message, fields);
  } catch {
    // Logger unavailable outside Electron (e.g. test suite) — logging is best-effort.
  }
}

export type VsCodeFocusPayload =
  | { readonly command: null; readonly retryAfterMs?: number }
  | { readonly command: "reveal-terminal"; readonly sessionAncestorPids: readonly number[] };

export interface ParkWaitFocusEntry {
  readonly requestId: string;
  readonly respond: (payload: VsCodeFocusPayload) => void;
  readonly onPruned?: () => void;
  /** Test-only override of the keepalive interval. */
  readonly keepaliveMs?: number;
}

export const maxParkedWaitFocus = 32;
export const waitFocusKeepaliveMs = 60_000;
const overCapRetryMs = 5_000;

interface ParkedEntry {
  readonly entry: ParkWaitFocusEntry;
  readonly keepaliveTimer: NodeJS.Timeout;
}

const parked = new Map<string, ParkedEntry>();

export function parkWaitFocus(entry: ParkWaitFocusEntry): { accepted: boolean; retryAfterMs?: number } {
  const existing = parked.get(entry.requestId);
  if (existing) {
    clearTimeout(existing.keepaliveTimer);
    parked.delete(entry.requestId);
    safeRespond(existing.entry, { command: null });
  }

  if (parked.size >= maxParkedWaitFocus) {
    debug("terminal-focus", "wait-focus rejected over cap", { parked: parked.size });
    return { accepted: false, retryAfterMs: overCapRetryMs };
  }

  const keepaliveTimer = setTimeout(() => {
    parked.delete(entry.requestId);
    safeRespond(entry, { command: null });
  }, entry.keepaliveMs ?? waitFocusKeepaliveMs);
  keepaliveTimer.unref?.();

  parked.set(entry.requestId, { entry, keepaliveTimer });
  debug("terminal-focus", "wait-focus parked", { requestId: entry.requestId, parked: parked.size });
  return { accepted: true };
}

export function pruneWaitFocus(requestId: string): void {
  const existing = parked.get(requestId);
  if (!existing) return;
  clearTimeout(existing.keepaliveTimer);
  parked.delete(requestId);
  existing.entry.onPruned?.();
  debug("terminal-focus", "wait-focus pruned", { requestId, parked: parked.size });
}

export function requestTabReveal(sessionAncestorPids: readonly number[]): boolean {
  if (parked.size === 0 || sessionAncestorPids.length === 0) return false;
  const entries = [...parked.values()];
  parked.clear();
  for (const { entry, keepaliveTimer } of entries) {
    clearTimeout(keepaliveTimer);
    safeRespond(entry, { command: "reveal-terminal", sessionAncestorPids });
  }
  debug("terminal-focus", "tab reveal dispatched", { windows: entries.length, chainLength: sessionAncestorPids.length });
  return entries.length > 0;
}

export function parkedWaitFocusCount(): number {
  return parked.size;
}

function safeRespond(entry: ParkWaitFocusEntry, payload: VsCodeFocusPayload): void {
  try {
    entry.respond(payload);
  } catch {
    // Socket already gone — nothing to do.
  }
}
