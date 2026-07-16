/**
 * window-select.ts
 *
 * Pure selection of the terminal window among multiple windows owned by the
 * same process. Multi-window apps (VS Code, Windows Terminal) run every window
 * out of ONE process, so "largest window owned by the terminal PID" collapses
 * all of them onto whichever window happens to be biggest — and flips when the
 * relative sizes change. Disambiguate by matching window titles against the
 * session's cwd path segments (VS Code titles carry the workspace folder name),
 * and latch onto the previous selection when it is still a valid candidate.
 *
 * No imports — intentionally side-effect-free (same pattern as window-chain.ts).
 */

export interface SelectableWindow {
  readonly id: number;
  readonly title: string;
  readonly bounds: { readonly width: number; readonly height: number };
}

/**
 * True when the window belongs to the OS desktop shell — a process that can
 * never be a terminal emulator but sits in every GUI app's ancestor chain
 * (explorer.exe launched it) and always owns visible windows. Accepting it as
 * a terminal sends "focus session" clicks to a random Explorer window.
 * Matched by executable basename, not display name (which is localized,
 * e.g. "Windows Intéző" on a Hungarian system).
 */
export function isDesktopShellWindow(ownerPath: string | undefined): boolean {
  if (!ownerPath) return false;
  const base = ownerPath.split(/[\\/]/).pop()?.toLowerCase();
  return base === "explorer.exe" || base === "finder";
}

/**
 * Split a cwd into candidate directory names, deepest-first.
 * Drive-letter segments ("C:") and empty segments are dropped; segments
 * shorter than 2 chars are too ambiguous to title-match.
 */
export function cwdSegments(cwd: string): string[] {
  return cwd
    .split(/[\\/]+/)
    .filter((seg) => seg.length >= 2 && !/^[A-Za-z]:$/.test(seg))
    .reverse();
}

/**
 * Pick the window hosting a session among `windows` (all owned by the same
 * terminal PID).
 *
 * Priority:
 *   1. Narrow to windows whose title contains the deepest cwd segment that
 *      matches ANY window title (case-insensitive). VS Code default titles
 *      are "file - folder - Visual Studio Code", so the workspace folder
 *      matches its own window only.
 *   2. Within the candidate set, keep the previously selected window when it
 *      is still present (stability latch — prevents flip-flopping between
 *      equally-valid candidates as sizes/titles change).
 *   3. Otherwise the largest candidate by area.
 */
export function selectTerminalWindow<T extends SelectableWindow>(
  windows: readonly T[],
  cwd?: string,
  previousWindowId?: number,
): T | null {
  if (windows.length === 0) return null;

  let candidates: readonly T[] = windows;
  if (cwd && windows.length > 1) {
    for (const segment of cwdSegments(cwd)) {
      const needle = segment.toLowerCase();
      const matched = windows.filter((w) => w.title.toLowerCase().includes(needle));
      if (matched.length > 0) {
        candidates = matched;
        break;
      }
    }
  }

  if (previousWindowId !== undefined) {
    const previous = candidates.find((w) => w.id === previousWindowId);
    if (previous) return previous;
  }

  return candidates.reduce((best, w) =>
    w.bounds.width * w.bounds.height > best.bounds.width * best.bounds.height ? w : best,
  );
}
