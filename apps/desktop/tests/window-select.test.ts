/**
 * Unit tests for selectTerminalWindow / cwdSegments in window-select.ts.
 *
 * Regression context: multi-window apps (VS Code) run every window out of one
 * process, so all sessions used to collapse onto the single largest window —
 * and the selection flipped whenever a different window became the largest,
 * silently tearing down window→pet bindings.
 *
 * Cases:
 *   (1) cwdSegments: deepest-first, drops drive letters / empty / 1-char segments.
 *   (2) Single window: returned regardless of cwd.
 *   (3) Title match beats size: the window whose title carries the cwd folder
 *       name wins even when another window is larger.
 *   (4) Deepest matching segment wins over shallower ones.
 *   (5) No title match: falls back to largest window.
 *   (6) Match is case-insensitive.
 *   (7) Stability latch: previous selection is kept while still a candidate.
 *   (8) Latch does not resurrect a window that disappeared.
 *   (9) Latch cannot override a cwd title match pointing elsewhere.
 *  (10) Empty window list returns null.
 */
import assert from "node:assert/strict";

import { cwdSegments, isDesktopShellWindow, selectTerminalWindow, type SelectableWindow } from "../src/window-select.js";

function win(id: number, title: string, width = 100, height = 100): SelectableWindow {
  return { id, title, bounds: { width, height } };
}

// (1) cwdSegments
assert.deepEqual(
  cwdSegments("C:\\Users\\dev\\projects\\openpets"),
  ["openpets", "projects", "dev", "Users"],
  "drops drive letter, deepest-first",
);
assert.deepEqual(cwdSegments("/home/dev/a/openpets"), ["openpets", "dev", "home"], "drops 1-char segments");

// (2) Single window
assert.equal(selectTerminalWindow([win(1, "anything")], "C:\\work\\openpets")?.id, 1);

// (3) Title match beats size
{
  const windows = [
    win(10, "main.ts - openpets - Visual Studio Code", 800, 600),
    win(20, "App.java - shop-backend - Visual Studio Code", 1920, 1080),
  ];
  assert.equal(selectTerminalWindow(windows, "C:\\dev\\openpets")?.id, 10, "smaller matching window wins");
  assert.equal(selectTerminalWindow(windows, "C:\\dev\\shop-backend")?.id, 20);
}

// (4) Deepest matching segment wins
{
  const windows = [
    win(1, "notes.md - projects - Visual Studio Code", 500, 500),
    win(2, "main.ts - openpets - Visual Studio Code", 500, 500),
  ];
  // cwd .../projects/openpets: "openpets" (deepest) matches window 2 first.
  assert.equal(selectTerminalWindow(windows, "C:\\projects\\openpets")?.id, 2);
}

// (5) No title match → largest
{
  const windows = [win(1, "vim", 500, 500), win(2, "htop", 900, 900)];
  assert.equal(selectTerminalWindow(windows, "C:\\dev\\openpets")?.id, 2);
}

// (6) Case-insensitive match
{
  const windows = [win(1, "README.md - OpenPets - Visual Studio Code"), win(2, "other - Visual Studio Code", 999, 999)];
  assert.equal(selectTerminalWindow(windows, "C:\\dev\\openpets")?.id, 1);
}

// (7) Stability latch keeps previous selection among equal candidates
{
  const windows = [win(1, "term", 500, 500), win(2, "term", 900, 900)];
  assert.equal(selectTerminalWindow(windows, undefined, 1)?.id, 1, "previous window kept even though 2 is larger");
}

// (8) Latch ignores a vanished window
{
  const windows = [win(2, "term", 900, 900)];
  assert.equal(selectTerminalWindow(windows, undefined, 1)?.id, 2);
}

// (9) Latch cannot override a title match elsewhere
{
  const windows = [
    win(1, "misc - Visual Studio Code", 900, 900),
    win(2, "main.ts - openpets - Visual Studio Code", 500, 500),
  ];
  assert.equal(selectTerminalWindow(windows, "C:\\dev\\openpets", 1)?.id, 2, "cwd match beats the latch");
}

// (10) Empty list
assert.equal(selectTerminalWindow([], "C:\\dev\\openpets"), null);

// (11) isDesktopShellWindow — matched by executable basename, never by
// (localized) display name; regression for the "double-click focuses Windows
// Explorer" bug (chain walk latched onto explorer.exe).
assert.equal(isDesktopShellWindow("C:\\Windows\\explorer.exe"), true);
assert.equal(isDesktopShellWindow("C:\\WINDOWS\\Explorer.EXE"), true, "case-insensitive");
assert.equal(isDesktopShellWindow("/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"), true);
assert.equal(isDesktopShellWindow("C:\\Program Files\\WindowsTerminal\\WindowsTerminal.exe"), false);
assert.equal(isDesktopShellWindow("C:\\tools\\my-explorer.exe\\code.exe"), false, "only the basename counts");
assert.equal(isDesktopShellWindow(undefined), false, "missing path is never treated as shell");

console.log("window-select.test.ts passed");
