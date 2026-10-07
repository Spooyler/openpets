/**
 * session-focus.ts
 *
 * The one target shape + dispatch for "focus this session" actions
 * (double-click, notification-row click, group-header click). A target can
 * carry a terminal window identity (raise the OS window), a herdr pane
 * context (switch the multiplexer to the session's pane — see
 * herdr-focus.ts), or both; herdr-hosted sessions typically have only the
 * pane context because their process ancestry roots at herdr's windowless
 * server and never reaches the terminal emulator. For those, the OS window
 * is raised via the herdr CLIENT process instead (herdr-window.ts).
 */

import { focusHerdrPane, type HerdrFocusContext } from "./herdr-focus.js";
import { focusHerdrClientWindow } from "./herdr-window.js";
import { focusTerminalWindow } from "./terminal-focus.js";

export interface SessionFocusTarget {
  readonly terminalOwnerPid?: number;
  readonly terminalWindowId?: number;
  readonly herdr?: HerdrFocusContext;
  readonly leaseId?: string;
}

/**
 * Dispatch every focus mechanism the target supports, concurrently.
 * Resolves true when at least one succeeded. Never throws.
 */
export async function focusSessionTarget(target: SessionFocusTarget): Promise<boolean> {
  const hasTerminalIdentity = target.terminalOwnerPid !== undefined && target.terminalOwnerPid > 0;
  const [windowFocused, paneFocused, clientWindowFocused] = await Promise.all([
    hasTerminalIdentity
      ? focusTerminalWindow(target.terminalOwnerPid!, target.terminalWindowId).catch(() => false)
      : Promise.resolve(false),
    target.herdr ? focusHerdrPane(target.herdr) : Promise.resolve(false),
    target.herdr ? focusHerdrClientWindow(target.herdr) : Promise.resolve(false),
  ]);
  return windowFocused || paneFocused || clientWindowFocused;
}
