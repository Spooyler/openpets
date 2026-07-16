# Session Pet Assignment — Project Memory & Sessions-Tab Picker

**Date:** 2026-07-16
**Status:** Approved in brainstorming; awaiting implementation plan
**Scope:** `apps/desktop` (window-pet-registry, local-ipc, app-state, Control Center Sessions tab, Settings), small wire-protocol addition in `packages/client` / `packages/mcp`
**Builds on:** `2026-07-14-pet-attention-model-design.md` (window bindings, one pet per window, notification stores — all unchanged)

## Problem

Three defects in how sessions get pets today:

1. **Startup assignment is effectively random.** Pool pets are drawn per
   window, but in whatever order each session's terminal identity resolves
   (a PPID-walk race at app start). Nothing remembers which window or project
   had which pet, so every OpenPets restart reshuffles.
2. **Pets cannot be changed from the Sessions tab.** The tab is read-only
   regarding pets (focus / hide / disconnect only) and shows a flat list, not
   window groups.
3. **New sessions auto-adopt a pet.** The 2026-07-14 spec settled the pool as
   opt-in and **off by default** ("single persistent default pet; dedicated
   pets only via `--pet`, `openpets_adopt`, or opt-in pool"), but
   `app-state.ts` ships `petPoolEnabled: true`, so a configured pool draws a
   pet for every new window automatically.

## Decisions (settled during design)

| Question | Decision |
|---|---|
| Stickiness | Pets stick to **projects** (normalized cwd), persisted across restarts. |
| Brand-new session | Default pet — unless its window already has a pet (join it) or its project has a remembered pet. |
| Group model | Group = terminal window (one pet per window stands). A session alone in its window is the individual case. |
| Pool | Stays, but strictly opt-in automation: default **off**, draws only when no memory matches, and each draw is written into memory so it stops reshuffling. |
| Picker semantics | Same move semantics as `openpets_adopt`: "this window's pet is now X". |

## 1. Assignment model & project memory

### New state

`preferences.projectPetAssignments?: Record<string, string>` — normalized
project path → petId.

- Normalization: absolute path, trailing separators stripped, lowercased on
  win32. Malformed entries are dropped by a normalizer on read (same pattern
  as `normalizePetPoolOrder`).
- Capped at 128 entries; re-writing a project refreshes its position and the
  least-recently-written entry is evicted when the cap is exceeded.

### Resolution chain

When a session's terminal identity resolves with **no explicit pet request**,
the registry decides in order:

1. **Window already bound** → join the existing binding (unchanged).
2. **Project memory** → if the session's cwd maps to a pet that is installed,
   not broken, not the default/built-in, and **not bound to another window**
   → bind and spawn it. Non-stealing: if occupied elsewhere, fall through.
   First window wins when the same project is open twice; the second falls to
   default. Stale entries (uninstalled/broken pet) are pruned on read.
3. **Pool auto-draw** → only when `petPoolEnabled` is on AND the window is not
   user-closed. A drawn pet is **written to project memory**, so pool
   assignment becomes stable after the first draw.
4. **Default pet.** No random step anywhere.

Sessions without a cwd, or whose identity never resolves, behave exactly as
today (default coverage). Leases, TTLs, heartbeats, nonces, and
one-pet-per-window are untouched.

### Memory writes

Memory is written when a pet is *called*:

- `--pet X` at session start (lease acquires an explicit target and carries a
  cwd),
- `openpets_adopt X` mid-session,
- the Sessions-tab picker (Section 2),
- a pool auto-draw (step 3 above).

Writes are guarded **once per (sessionKey, petId)** so a lease re-acquire
after sleep/expiry re-sending the same `--pet` does not overwrite a newer
assignment made in the UI.

### Memory clears

- Picking **Default** in the Sessions tab clears the entries for that
  window's session cwds.
- `openpets_adopt` back to default clears the entry for the session's cwd.
- Settings gains a **Clear remembered assignments** action (clear-all).

### Wire protocol: tri-state `requestedPetId`

To distinguish "explicitly default" from "unspecified", `lease.acquire`
accepts:

| Value | Meaning |
|---|---|
| `"petid"` | Explicit pet: bind + write memory. |
| `null` | Explicitly default (adopt-to-default): unbind the window, clear the cwd's memory entry, and mark the window user-closed so an enabled pool does not immediately re-draw (same suppression as the picker's **Default**). The session lands on default coverage without re-running the chain. |
| absent | Unspecified: run the resolution chain. |

`packages/mcp` already models this tri-state internally
(`LeaseContext.requestedPetId?: string | null`); it currently collapses
`null` → absent in `resolveRequestedPetId` before sending. It stops
collapsing and sends `null` on the wire. `packages/client` types widen
accordingly; `check-mcp-contract.ts` covers all three states. Absent stays
absent — fully backward compatible.

## 2. Sessions tab — grouping & pet picker

### Grouping

`getSessionsSnapshot()` adds a per-session `windowKey` (derived from the
lease's terminal identity — the same key the registry uses). The renderer
groups rows under window headers:

- **Group header:** terminal app name, current pet (name + origin badge:
  *assigned / pool / default*), and the pet picker.
- **Rows:** one per session as today — project, uptime, notifications,
  health, and the existing focus / hide / disconnect actions.
- Windows with no binding still form groups (header shows "Default pet", with
  a picker so the window can be given a pet).
- Sessions with unresolved identity land in an "identifying…" group with no
  picker.

### Picker

A dropdown per group listing every installed, non-broken pet (built-in and
current default excluded) plus **Default**. Pets bound to another window show
an "in use" hint but remain selectable.

- **Pick pet X** → rebind the window with adopt move semantics: the
  notification store carries over on a swap; if X was bound elsewhere, that
  other binding closes and its sessions fall to default coverage. Project
  memory is written for each distinct cwd among the window's sessions. Any
  user-closed flag on the window is cleared.
- **Pick Default** → unbind: pet closes, sessions fall to default coverage,
  memory entries for the window's cwds are cleared, and the window is marked
  user-closed so an enabled pool does not immediately re-draw for it.

### Plumbing

One new preload/API method: `assignWindowPet(windowKey, petId | null)`,
driving the existing registry rebind/unbind machinery (`#bindExplicit` /
`onUserClosedPet`). The picker reuses the already-loaded installed-pets list.
No new window-lifecycle code.

### Known v1 quirk (accepted)

A session started with `--pet X` whose window is re-assigned to Y in the UI
flips back to X if its MCP client performs a full lease re-acquire (e.g.
reconnect after laptop sleep) — the client re-sends its configured pet, and
explicit requests win. Project memory keeps Y for future sessions (the
write-once guard prevents the reconnect from rewriting memory). A full fix
requires pushing assignments into MCP client state; out of scope for v1.

## 3. Settings & defaults

- `petPoolEnabled` default flips to **false** for fresh state (matches the
  2026-07-14 spec). Existing installs keep their stored value — no migration;
  users who never wanted auto-draw flip the toggle off once.
- Settings copy: the toggle is relabeled **"Auto-assign pool pets to new
  terminal windows"**, with the pool order list beneath it.
- New Settings action: **Clear remembered assignments**.
- New i18n keys (picker, group headers, badges, clear action) across all 7
  locales.

## Error handling

- Memory reads/writes are best-effort; malformed entries dropped on read.
- Assignment failures in the UI surface through the existing Control Center
  toast/error pattern.
- Remembered pet ineligible (uninstalled / broken / became default) → chain
  falls through to default; the stale entry is pruned.

## Testing

- **Unit — registry:** resolution chain order (binding → memory → pool →
  default); non-stealing memory bind; user-closed suppression; pool draw
  writes memory; rebind/unbind via `assignWindowPet` paths.
- **Unit — memory store:** path normalization (win32 casing), LRU cap,
  write-once-per-session guard, clear-on-default, stale-entry pruning.
- **Unit — snapshot:** `windowKey` present, grouping fields correct.
- **Contract:** tri-state `requestedPetId` in `packages/client`,
  `packages/mcp`, `check-mcp-contract.ts`.
- **Manual matrix (Windows):** many Claude sessions open → restart OpenPets →
  every window re-gains its remembered pet regardless of identity-resolve
  order; picker on a multi-tab Windows Terminal group rebinds all its
  sessions; adopt-to-default clears memory; pool off → new session lands on
  the default pet.

## Out of scope

- Per-session pets within one window (one-pet-per-window stands).
- Pushing UI assignments into MCP client configuration.
- Memory management UI beyond clear-all (the picker edits entries
  project-by-project).
- Tab-level focus (stays reverted).
