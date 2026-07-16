# OpenPets Performance Optimizations

## Immediate wins

- [ ] **Pause sprite animation during idle hold** (`pet-window.ts` ~L913-948)
  - After idle animation completes one loop, set `animation-play-state: paused` via IPC
  - Resume on any state change (say, react, activity transition)
  - Biggest single idle CPU/GPU win — same unfixed bug as Codex #20680

- [ ] **Replace Windows mouse-forwarding poll with native forward** (`pet-window.ts` ~L422-430)
  - Current: 750ms `setTimeout` loop probing cursor position per visible pet window
  - Replace with `win.setIgnoreMouseEvents(true, { forward: true })` (Electron 42+ supports this natively)
  - Eliminates the polling timer entirely

- [ ] **Make confinement polling adaptive** (`confinement-poller.ts`)
  - Current: `get-windows` every ~500ms enumerates ALL OS windows via `EnumWindows`
  - Options: skip ticks when pet is well within bounds, increase interval to 2-3s, gate on confinement being enabled

- [ ] **Share single hidden BrowserWindow for JS plugins** (`plugin-js-host.ts:48`)
  - Current: separate Chromium renderer process per JS plugin (~30-50 MB each)
  - Use iframes or MessageChannel isolation in a single hidden window instead

## Medium-term

- [ ] **Cap pet window frame rate** — `win.webContents.setFrameRate(4)` to match sprite animation rate (~3.6 fps effective), default 60 fps is pure waste for a pixel pet

- [ ] **Verify lazy creation of all non-pet windows** — control center is on-demand (good), verify plugin JS hosts / panel / voice / toast windows are truly deferred until first use

- [ ] **Verify backgroundThrottling works for overlay windows** — transparent always-on-top windows may not trigger Electron's "backgrounded" state; implement manual throttling via `visibilitychange` or display power events if needed

## Architectural

- [ ] **Hybrid Tauri pet window** — pet overlay is just a transparent window cycling a spritesheet; implement as a Tauri window (system webview, ~5 MB) while keeping Node.js backend for MCP/IPC/plugins as a sidecar

- [ ] **Pre-render sprite frames to texture atlas** — pre-slice spritesheet into individual frames at load time, swap `src` on a controlled timer instead of CSS `background-position` animation; enables full timer control (stop completely during idle) without compositor involvement
