# VS Code Terminal-Tab Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the pet focuses a session running in a VS Code integrated-terminal tab, reveal the exact tab (not just the window) via a VS Code extension connected to the desktop app over parked long-poll requests on the existing local IPC.

**Architecture:** The extension (`packages/vscode-extension`) sends an authenticated `vscode.wait-focus` request that the desktop parks (socket held open, 3s idle timeout lifted, ~60s keepalive re-arm). When a user triggers session focus, the desktop completes all parked requests with `{ command: "reveal-terminal", sessionAncestorPids }`; each VS Code window's extension matches the chain against its terminals' shell PIDs and calls `terminal.show(false)` on the owning terminal. Desktop keeps no per-window registry. Spec: `docs/superpowers/specs/2026-07-16-vscode-tab-focus-design.md`.

**Tech Stack:** TypeScript ESM workspace (pnpm); VS Code extension bundled to CommonJS with esbuild (VS Code's extension host cannot load ESM); assert-based `check-*.ts` self-tests per repo convention; desktop tests in `apps/desktop/tests/*.test.ts` run by `scripts/run-tests.mjs`.

## Global Constraints

- Extension marketplace ID: `openpets.openpets-vscode`; package name `openpets-vscode`; not yet published — desktop UI shows sideload command, Install button gated behind `vsCodeExtensionPublished = false`.
- Focus payload carries **PIDs only** — never paths, titles, prompts, or secrets.
- Extension must never disrupt the editor: all IPC failures swallowed (log to output channel), bounded retry with backoff.
- Zero behavior change when no extension is connected: window focus works exactly as today.
- Parked-map bounds: max 32 parked requests; server keepalive 60s (`{ command: null }`); client `responseTimeoutMs` 70s.
- Conventional commits (`feat(...)`, `test(...)`), single-line, imperative.
- All commands run from repo root unless stated; on Windows use Git Bash paths.

---

### Task 1: Protocol method `vscode.wait-focus` in `@open-pets/client`

**Files:**
- Modify: `packages/client/src/protocol.ts:22` (method union)
- Test: `packages/client/contracts/client-protocol.contract.ts` (append assertions)

**Interfaces:**
- Produces: `OpenPetsIpcMethod` union includes `"vscode.wait-focus"`. Wait-focus result shape (documented for later tasks): `{ command: null, retryAfterMs?: number } | { command: "reveal-terminal", sessionAncestorPids: number[] }`.

- [ ] **Step 1: Extend the method union**

In `packages/client/src/protocol.ts` change line 22 to:

```ts
export type OpenPetsIpcMethod = "hello" | "status" | "pets.list" | "pets.install" | "lease.acquire" | "lease.heartbeat" | "lease.release" | "pet.react" | "pet.say" | "pets.install-local" | "agent.activity" | "vscode.wait-focus";
```

Add below the union (exported types used by both extension and desktop):

```ts
export interface VsCodeFocusCommandReveal {
  readonly command: "reveal-terminal";
  readonly sessionAncestorPids: readonly number[];
}

export interface VsCodeFocusCommandNone {
  readonly command: null;
  readonly retryAfterMs?: number;
}

export type VsCodeFocusCommand = VsCodeFocusCommandReveal | VsCodeFocusCommandNone;
```

- [ ] **Step 2: Append contract assertions**

Open `packages/client/contracts/client-protocol.contract.ts`, find its existing assertion style, and append:

```ts
// vscode.wait-focus method is part of the protocol union (compile-time) and
// its result payloads have the documented runtime shape.
const revealPayload: VsCodeFocusCommand = { command: "reveal-terminal", sessionAncestorPids: [123, 456] };
const nonePayload: VsCodeFocusCommand = { command: null, retryAfterMs: 5000 };
assert.equal(revealPayload.command, "reveal-terminal");
assert.equal(nonePayload.command, null);
const waitFocusMethod: OpenPetsIpcMethod = "vscode.wait-focus";
assert.equal(waitFocusMethod, "vscode.wait-focus");
```

Add `VsCodeFocusCommand` and `OpenPetsIpcMethod` to that file's imports from `../src/protocol.js` (match existing import path style in the file).

- [ ] **Step 3: Run the package check**

Run: `pnpm --filter @open-pets/client check`
Expected: typecheck, build, and contract test pass.

- [ ] **Step 4: Commit**

```bash
git add packages/client
git commit -m "feat(client): add vscode.wait-focus protocol method and focus command types"
```

---

### Task 2: Desktop parked-request module `vscode-tab-focus.ts`

**Files:**
- Create: `apps/desktop/src/vscode-tab-focus.ts`
- Test: `apps/desktop/tests/vscode-tab-focus.test.ts`
- Modify: `apps/desktop/scripts/run-tests.mjs` (add test to the unit-test list)

**Interfaces:**
- Consumes: `VsCodeFocusCommand` shape from Task 1 (structurally; desktop does not import the client package — mirror the shape locally, matching how local-ipc mirrors protocol types).
- Produces:
  - `parkWaitFocus(entry: { requestId: string; respond: (result: VsCodeFocusPayload) => void; onPruned?: () => void }): { accepted: boolean; retryAfterMs?: number }`
  - `pruneWaitFocus(requestId: string): void` (call when the socket dies)
  - `requestTabReveal(sessionAncestorPids: readonly number[]): boolean` (true if ≥1 parked request completed)
  - `parkedWaitFocusCount(): number`
  - `type VsCodeFocusPayload = { command: null; retryAfterMs?: number } | { command: "reveal-terminal"; sessionAncestorPids: readonly number[] }`
  - Constants: `maxParkedWaitFocus = 32`, `waitFocusKeepaliveMs = 60_000`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/tests/vscode-tab-focus.test.ts` (mirror the import/assert style of an existing test, e.g. `apps/desktop/tests/notification-store.test.ts` — plain `node:assert/strict`, top-level execution):

```ts
import assert from "node:assert/strict";

import {
  maxParkedWaitFocus,
  parkWaitFocus,
  parkedWaitFocusCount,
  pruneWaitFocus,
  requestTabReveal,
  waitFocusKeepaliveMs,
  type VsCodeFocusPayload,
} from "../src/vscode-tab-focus.js";

// requestTabReveal with nothing parked -> false
assert.equal(requestTabReveal([1, 2, 3]), false);
assert.equal(parkedWaitFocusCount(), 0);

// park one, reveal completes it with the chain
const received: VsCodeFocusPayload[] = [];
const park1 = parkWaitFocus({ requestId: "r1", respond: (p) => received.push(p) });
assert.equal(park1.accepted, true);
assert.equal(parkedWaitFocusCount(), 1);
assert.equal(requestTabReveal([10, 20]), true);
assert.equal(received.length, 1);
assert.deepEqual(received[0], { command: "reveal-terminal", sessionAncestorPids: [10, 20] });
// completion removes the parked entry
assert.equal(parkedWaitFocusCount(), 0);
assert.equal(requestTabReveal([10, 20]), false);

// reveal completes ALL parked requests
const gotA: VsCodeFocusPayload[] = [];
const gotB: VsCodeFocusPayload[] = [];
parkWaitFocus({ requestId: "rA", respond: (p) => gotA.push(p) });
parkWaitFocus({ requestId: "rB", respond: (p) => gotB.push(p) });
assert.equal(requestTabReveal([7]), true);
assert.equal(gotA.length, 1);
assert.equal(gotB.length, 1);
assert.equal(parkedWaitFocusCount(), 0);

// duplicate requestId replaces the previous entry (old one answered with keepalive)
const dupFirst: VsCodeFocusPayload[] = [];
const dupSecond: VsCodeFocusPayload[] = [];
parkWaitFocus({ requestId: "dup", respond: (p) => dupFirst.push(p) });
parkWaitFocus({ requestId: "dup", respond: (p) => dupSecond.push(p) });
assert.equal(parkedWaitFocusCount(), 1);
assert.deepEqual(dupFirst, [{ command: null }]);
requestTabReveal([1]);
assert.equal(dupSecond.length, 1);

// prune removes without responding
const pruned: VsCodeFocusPayload[] = [];
parkWaitFocus({ requestId: "rp", respond: (p) => pruned.push(p) });
pruneWaitFocus("rp");
assert.equal(parkedWaitFocusCount(), 0);
assert.equal(pruned.length, 0);
assert.equal(requestTabReveal([1]), false);

// cap: entries beyond maxParkedWaitFocus are rejected with retryAfterMs
for (let i = 0; i < maxParkedWaitFocus; i += 1) {
  assert.equal(parkWaitFocus({ requestId: `cap-${i}`, respond: () => {} }).accepted, true);
}
const overCap = parkWaitFocus({ requestId: "over", respond: () => {} });
assert.equal(overCap.accepted, false);
assert.equal(typeof overCap.retryAfterMs, "number");
assert.equal(parkedWaitFocusCount(), maxParkedWaitFocus);
requestTabReveal([1]); // drain

// keepalive: parked entry is answered { command: null } after waitFocusKeepaliveMs
assert.equal(waitFocusKeepaliveMs, 60_000);
const keepalive: VsCodeFocusPayload[] = [];
parkWaitFocus({ requestId: "ka", respond: (p) => keepalive.push(p), keepaliveMs: 20 });
await new Promise((resolve) => setTimeout(resolve, 60));
assert.deepEqual(keepalive, [{ command: null }]);
assert.equal(parkedWaitFocusCount(), 0);

console.error("vscode-tab-focus tests passed.");
```

Note: `keepaliveMs` is an optional test-only override on the entry (defaults to `waitFocusKeepaliveMs`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm test:build && node .test-dist/tests/vscode-tab-focus.test.js`
Expected: FAIL — module `../src/vscode-tab-focus.js` not found.

- [ ] **Step 3: Implement the module**

Create `apps/desktop/src/vscode-tab-focus.ts`:

```ts
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
 */

import { debug } from "./logger.js";

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
    debug("vscode-focus", "wait-focus rejected over cap", { parked: parked.size });
    return { accepted: false, retryAfterMs: overCapRetryMs };
  }

  const keepaliveTimer = setTimeout(() => {
    parked.delete(entry.requestId);
    safeRespond(entry, { command: null });
  }, entry.keepaliveMs ?? waitFocusKeepaliveMs);
  keepaliveTimer.unref?.();

  parked.set(entry.requestId, { entry, keepaliveTimer });
  debug("vscode-focus", "wait-focus parked", { requestId: entry.requestId, parked: parked.size });
  return { accepted: true };
}

export function pruneWaitFocus(requestId: string): void {
  const existing = parked.get(requestId);
  if (!existing) return;
  clearTimeout(existing.keepaliveTimer);
  parked.delete(requestId);
  existing.entry.onPruned?.();
  debug("vscode-focus", "wait-focus pruned", { requestId, parked: parked.size });
}

export function requestTabReveal(sessionAncestorPids: readonly number[]): boolean {
  if (parked.size === 0 || sessionAncestorPids.length === 0) return false;
  const entries = [...parked.values()];
  parked.clear();
  for (const { entry, keepaliveTimer } of entries) {
    clearTimeout(keepaliveTimer);
    safeRespond(entry, { command: "reveal-terminal", sessionAncestorPids });
  }
  debug("vscode-focus", "tab reveal dispatched", { windows: entries.length, chainLength: sessionAncestorPids.length });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm test:build && node .test-dist/tests/vscode-tab-focus.test.js`
Expected: `vscode-tab-focus tests passed.`

- [ ] **Step 5: Register the test in the runner**

In `apps/desktop/scripts/run-tests.mjs`, add to the unit-test list (alphabetical/nearby grouping with the other entries, e.g. after `".test-dist/tests/window-pet-registry.test.js"`):

```js
  ".test-dist/tests/vscode-tab-focus.test.js",
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/vscode-tab-focus.ts apps/desktop/tests/vscode-tab-focus.test.ts apps/desktop/scripts/run-tests.mjs
git commit -m "feat(desktop): add parked-request registry for VS Code tab focus"
```

---

### Task 3: Park `vscode.wait-focus` in local-ipc and reveal at focus call-sites

**Files:**
- Modify: `apps/desktop/src/local-ipc.ts` (socket handling ~:331-371, method allowlist/parse, focus paths ~:1293-1300)
- Modify: `apps/desktop/src/window-pet-registry.ts:322-361` (add `leaseId` to focus targets)
- Modify: `apps/desktop/src/default-pet-controller.ts:53-62,375-385` and `apps/desktop/src/agent-pet-controller.ts:336-385` (reveal after window focus)
- Test: `apps/desktop/tests/session-pet-routing.test.ts` (extend if it covers focus targets) or rely on Task 2 unit tests + existing suite

**Interfaces:**
- Consumes: `parkWaitFocus`, `pruneWaitFocus`, `requestTabReveal` from Task 2; `leaseManager.getRawLease(leaseId)?.clientAncestorPids` (`lease-manager.ts:40`).
- Produces:
  - Focus targets gain `leaseId`: `{ terminalOwnerPid: number; terminalWindowId?: number; leaseId?: string }` (all three producers in `window-pet-registry.ts`).
  - `local-ipc.ts` exports `revealTabForLease(leaseId: string | undefined): void` and injects it into both controllers via existing accessor-injection pattern (`setRevealTabForLease(fn)` setters in each controller, mirroring `setDefaultNotificationStoreAccessor` at `default-pet-controller.ts:45`).

- [ ] **Step 1: Add `leaseId` to registry focus targets**

In `apps/desktop/src/window-pet-registry.ts`, update the three producers (`focusTargetForPet` :322, `focusTargetForDefault` :329, `sessionFocusTarget` :340, and the private `#focusTarget` :354) to include the session's `leaseId` (available on `TrackedSession`/`RegistrySessionInfo:19`). Return type everywhere:

```ts
{ terminalOwnerPid: number; terminalWindowId?: number; leaseId?: string } | null
```

In `sessionFocusTarget` for example:

```ts
if (parked) return { terminalOwnerPid: parked.terminalOwnerPid, terminalWindowId: parked.terminalWindowId, leaseId: parked.leaseId };
```

and in `#focusTarget`:

```ts
if (info) return { terminalOwnerPid: info.terminalOwnerPid, terminalWindowId: info.terminalWindowId, leaseId: info.leaseId };
```

Apply the same addition to every return point of these functions (read the full function bodies first — there are fallback branches).

- [ ] **Step 2: Park wait-focus requests in `handleSocket`**

In `apps/desktop/src/local-ipc.ts` import the Task 2 module:

```ts
import { parkWaitFocus, pruneWaitFocus, requestTabReveal } from "./vscode-tab-focus.js";
```

In `handleSocket` (:347-364), replace the request dispatch block so wait-focus takes the parked path (everything else unchanged):

```ts
    handled = true;
    const raw = buffer.slice(0, newline);
    void dispatchRawRequest(raw, token, socket);
```

Add below `handleRawRequest`:

```ts
async function dispatchRawRequest(raw: string, token: string, socket: net.Socket): Promise<void> {
  // vscode.wait-focus long-poll: authenticate + park instead of answering.
  let parsedForPark: OpenPetsIpcRequest | null = null;
  try {
    parsedForPark = parseIpcRequest(raw, token);
  } catch {
    parsedForPark = null; // fall through to normal path for uniform error responses
  }

  if (parsedForPark?.method === "vscode.wait-focus") {
    const request = parsedForPark;
    trackAgentConnected(request.method);
    socket.setTimeout(0); // lift the 3s idle destroy — this socket waits by design
    const park = parkWaitFocus({
      requestId: request.id,
      respond: (payload) => writeResponse(socket, okResponse(request.id, payload)),
    });
    if (!park.accepted) {
      writeResponse(socket, okResponse(request.id, { command: null, retryAfterMs: park.retryAfterMs }));
      return;
    }
    socket.once("close", () => pruneWaitFocus(request.id));
    debug("ipc", "wait-focus parked", { requestId: request.id });
    return;
  }

  const response = await handleRawRequest(raw, token);
  writeResponse(socket, response);
}
```

Check `writeResponse` (:1144): if it ends/destroys the socket after writing, that is correct for wait-focus completion too (client re-arms with a new connection). If it leaves the socket open, add `socket.end()` after the parked-completion write.

- [ ] **Step 3: Add the reveal helper and wire the IPC focus path**

In `local-ipc.ts` add:

```ts
export function revealTabForLease(leaseId: string | undefined): void {
  if (!leaseId) return;
  const chain = leaseManager.getRawLease(leaseId)?.clientAncestorPids;
  if (!chain || chain.length === 0) return;
  requestTabReveal(chain);
}
```

Change `focusSessionTerminal` (:1293-1300) to reveal after window focus:

```ts
export async function focusSessionTerminal(leaseId: string): Promise<boolean> {
  const raw = leaseManager.getRawLease(leaseId);
  if (!raw) return false;
  const sessionKey = sessionKeyForLease(raw);
  const target = sessionKey ? windowPetRegistry.sessionFocusTarget(sessionKey) : null;
  if (!target) return false;
  const focused = await focusTerminalWindow(target.terminalOwnerPid, target.terminalWindowId);
  revealTabForLease(target.leaseId ?? leaseId);
  return focused;
}
```

- [ ] **Step 4: Inject the reveal into both controllers**

In `default-pet-controller.ts` add (next to the accessor setters at :41-47):

```ts
let revealTabForLeaseAccessor: ((leaseId: string | undefined) => void) | null = null;

export function setRevealTabForLease(fn: (leaseId: string | undefined) => void): void {
  revealTabForLeaseAccessor = fn;
}
```

In `focusSessionTerminalFromDefaultPet` (:53-62) add after the `focusTerminalWindow` call:

```ts
  revealTabForLeaseAccessor?.(target.leaseId);
```

and at the second call-site (~:379, notification focus) after `focused = await focusTerminalWindow(...)`:

```ts
              revealTabForLeaseAccessor?.(target?.leaseId);
```

Mirror the same setter + two call-site additions in `agent-pet-controller.ts` (`focusSessionTerminal` closure :336-344 and the `pet:notificationFocus` handler :365-385).

In `local-ipc.ts`, where the other accessors are injected into the controllers (search for the existing `setDefaultNotificationStoreAccessor(` call), add:

```ts
setRevealTabForLease(revealTabForLease);        // default-pet-controller
setAgentRevealTabForLease(revealTabForLease);   // agent-pet-controller (name the setter accordingly)
```

Use distinct exported setter names per controller file (`setRevealTabForLease` in default, `setRevealTabForLease` is fine in agent too since imports are aliased — follow however the existing dual injections are aliased at the injection site).

- [ ] **Step 5: Typecheck and run the desktop suite**

Run: `cd apps/desktop && pnpm typecheck && pnpm test:build && node .test-dist/tests/vscode-tab-focus.test.js && node .test-dist/tests/window-pet-registry.test.js && node .test-dist/tests/session-pet-routing.test.js`
Expected: all pass (registry tests may need updating if they assert exact focus-target shapes — add `leaseId` to expected objects rather than loosening assertions).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): park vscode.wait-focus and reveal terminal tabs at focus call-sites"
```

---

### Task 4: Extension package `packages/vscode-extension`

**Files:**
- Create: `packages/vscode-extension/package.json`
- Create: `packages/vscode-extension/tsconfig.json`
- Create: `packages/vscode-extension/src/extension.ts`
- Create: `packages/vscode-extension/src/match.ts`
- Create: `packages/vscode-extension/src/check-match.ts`
- Create: `packages/vscode-extension/README.md`
- Create: `packages/vscode-extension/.vscodeignore`

**Interfaces:**
- Consumes: `readDiscoveryFile`, `sendRequest`, `OpenPetsClientError` from `@open-pets/client`; `VsCodeFocusCommand` from Task 1.
- Produces: `pickTerminalForChain(terminals, chain, capMs): Promise<number | null>` in `match.ts` (index of the owning terminal or null); VS Code extension entry `activate`/`deactivate` bundled to `dist/extension.cjs`.

- [ ] **Step 1: Package manifest**

`packages/vscode-extension/package.json`:

```json
{
  "name": "openpets-vscode",
  "displayName": "OpenPets",
  "description": "Reveal the terminal tab hosting the OpenPets session your pet points at.",
  "version": "0.1.0",
  "publisher": "openpets",
  "license": "MIT",
  "private": true,
  "repository": {
    "type": "git",
    "url": "git+https://github.com/alvinunreal/openpets.git",
    "directory": "packages/vscode-extension"
  },
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.cjs",
  "scripts": {
    "build": "tsc --noEmit && esbuild src/extension.ts --bundle --platform=node --format=cjs --external:vscode --outfile=dist/extension.cjs && esbuild src/check-match.ts --bundle --platform=node --format=esm --external:vscode --outfile=dist/check-match.mjs",
    "typecheck": "tsc --noEmit",
    "test": "node dist/check-match.mjs",
    "check": "pnpm build && pnpm test",
    "package": "vsce package --no-dependencies"
  },
  "devDependencies": {
    "@open-pets/client": "workspace:*",
    "@types/node": "^25.6.2",
    "@types/vscode": "^1.90.0",
    "@vscode/vsce": "^3.3.0",
    "esbuild": "^0.25.0",
    "typescript": "^6.0.3"
  }
}
```

Note: `private: true` — this package is published to the VS Code Marketplace via `vsce`, never to npm. `@open-pets/client` is a devDependency because esbuild bundles it into `dist/extension.cjs` (`--no-dependencies` packaging).

`packages/vscode-extension/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "noEmit": true,
    "types": ["node", "vscode"]
  },
  "include": ["src/**/*.ts"]
}
```

`packages/vscode-extension/.vscodeignore`:

```
src/**
tsconfig.json
node_modules/**
dist/check-match.mjs
```

- [ ] **Step 2: Write the failing matcher test**

`packages/vscode-extension/src/check-match.ts`:

```ts
import assert from "node:assert/strict";

import { pickTerminalForChain, type MatchableTerminal } from "./match.js";

function term(pid: number | undefined, delayMs = 0): MatchableTerminal {
  return {
    processId: new Promise((resolve) => setTimeout(() => resolve(pid), delayMs)),
  };
}

// direct match by shell pid in ancestor chain
assert.equal(await pickTerminalForChain([term(100), term(200)], [999, 200, 4], 200), 1);

// no match
assert.equal(await pickTerminalForChain([term(100), term(200)], [1, 2, 3], 200), null);

// empty inputs
assert.equal(await pickTerminalForChain([], [1], 200), null);
assert.equal(await pickTerminalForChain([term(100)], [], 200), null);

// undefined processId is skipped, others still match
assert.equal(await pickTerminalForChain([term(undefined), term(42)], [42], 200), 1);

// slow processId beyond the cap is treated as unresolved (no hang)
const started = Date.now();
assert.equal(await pickTerminalForChain([term(42, 500)], [42], 50), null);
assert.ok(Date.now() - started < 400, "cap must bound the wait");

// first matching terminal wins when several match
assert.equal(await pickTerminalForChain([term(7), term(7)], [7], 200), 0);

console.error("vscode-extension match tests passed.");
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm install` (link the new package) then `pnpm --filter openpets-vscode check`
Expected: FAIL — `./match.js` not found.

- [ ] **Step 4: Implement the matcher**

`packages/vscode-extension/src/match.ts`:

```ts
/**
 * Pure session→terminal matching. A session's agent/MCP process is a
 * descendant of the shell VS Code spawned for its tab, so the terminal's
 * shell PID appears in the session's ancestor PID chain. No VS Code imports —
 * unit-testable with plain promises.
 */

export interface MatchableTerminal {
  /** vscode.Terminal.processId — resolves to the shell PID or undefined. */
  readonly processId: Thenable<number | undefined>;
}

export async function pickTerminalForChain(
  terminals: readonly MatchableTerminal[],
  sessionAncestorPids: readonly number[],
  capMs: number
): Promise<number | null> {
  if (terminals.length === 0 || sessionAncestorPids.length === 0) return null;
  const chain = new Set(sessionAncestorPids);

  const pids = await Promise.all(
    terminals.map((terminal) =>
      Promise.race([
        Promise.resolve(terminal.processId).catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), capMs)),
      ])
    )
  );

  for (let index = 0; index < pids.length; index += 1) {
    const pid = pids[index];
    if (pid !== undefined && chain.has(pid)) return index;
  }
  return null;
}
```

- [ ] **Step 5: Run the matcher test**

Run: `pnpm --filter openpets-vscode check`
Expected: `vscode-extension match tests passed.` (build must succeed first — `extension.ts` from Step 6 must exist; if executing strictly in order, create `extension.ts` with a stub `export function activate() {}` / `export function deactivate() {}` before this step, then fill it in Step 6.)

- [ ] **Step 6: Implement the extension entry**

`packages/vscode-extension/src/extension.ts`:

```ts
/**
 * OpenPets VS Code extension — terminal-tab focus.
 *
 * Keeps one `vscode.wait-focus` request parked at the OpenPets desktop app
 * (long-poll over the local IPC). When the user asks the pet to focus a
 * session, the desktop completes the parked request with the session's
 * ancestor PID chain; if one of THIS window's integrated terminals owns a
 * PID in that chain, reveal it. Fire-and-forget posture: every failure is
 * swallowed into the output channel and retried with backoff — the editor
 * is never disrupted. PIDs are the only data exchanged.
 */

import * as vscode from "vscode";

import { readDiscoveryFile, sendRequest, type VsCodeFocusCommand } from "@open-pets/client";

import { pickTerminalForChain } from "./match.js";

const waitResponseTimeoutMs = 70_000; // > desktop keepalive (60s)
const processIdCapMs = 2_000;
const minBackoffMs = 1_000;
const maxBackoffMs = 30_000;

let running = false;
let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("OpenPets");
  context.subscriptions.push(output);
  running = true;
  void waitLoop();
}

export function deactivate(): void {
  running = false;
}

async function waitLoop(): Promise<void> {
  let backoffMs = minBackoffMs;
  while (running) {
    try {
      const discovery = readDiscoveryFile();
      const command = await sendRequest<VsCodeFocusCommand>(discovery, "vscode.wait-focus", {}, {
        responseTimeoutMs: waitResponseTimeoutMs,
      });
      backoffMs = minBackoffMs;
      if (command.command === "reveal-terminal") {
        await revealMatchingTerminal(command.sessionAncestorPids);
      } else if (command.retryAfterMs) {
        await delay(command.retryAfterMs);
      }
      // command === null keepalive: re-arm immediately.
    } catch (error) {
      log(`wait-focus idle: ${error instanceof Error ? error.message : String(error)}`);
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }
}

async function revealMatchingTerminal(sessionAncestorPids: readonly number[]): Promise<void> {
  try {
    const terminals = vscode.window.terminals;
    const index = await pickTerminalForChain(terminals, sessionAncestorPids, processIdCapMs);
    if (index === null) return; // another window owns this session
    terminals[index]?.show(false);
    log(`revealed terminal #${index}`);
  } catch (error) {
    log(`reveal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function log(message: string): void {
  output?.appendLine(`[openpets] ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

`packages/vscode-extension/README.md` — three sentences: what it does (reveals the terminal tab your OpenPets pet points at), requires the OpenPets desktop app, no data beyond process IDs leaves the machine.

- [ ] **Step 7: Full package check + vsix packaging smoke test**

Run: `pnpm --filter openpets-vscode check && pnpm --filter openpets-vscode package`
Expected: check passes; `openpets-vscode-0.1.0.vsix` produced in the package dir. Add `*.vsix` to the package's `.gitignore` if the repo root doesn't already ignore it.

- [ ] **Step 8: Commit**

```bash
git add packages/vscode-extension
git commit -m "feat(vscode-extension): add terminal-tab focus extension with parked wait-focus loop"
```

---

### Task 5: Desktop UI — extension status section + i18n

**Files:**
- Modify: `apps/desktop/src/agent-setup.ts` (extend `VsCodeSetupStatus` with `extensionWindows: number`; new import)
- Modify: `apps/desktop/src/renderer/src/main.tsx` (VS Code detail dialog section; type update)
- Modify: `apps/desktop/src/i18n/locales/{en,ja,ko,es-419,pt-BR,zh-Hans,zh-Hant}.ts`

**Interfaces:**
- Consumes: `parkedWaitFocusCount()` from Task 2.
- Produces: `VsCodeSetupStatus.extensionWindows: number` on the snapshot (renderer mirror type updated identically).

- [ ] **Step 1: Extend the snapshot**

In `apps/desktop/src/agent-setup.ts`:
- `import { parkedWaitFocusCount } from "./vscode-tab-focus.js";`
- Add to `VsCodeSetupStatus`: `readonly extensionWindows: number;`
- In `getVsCodeSetup`, add `extensionWindows: parkedWaitFocusCount(),` to the returned `status` object.

- [ ] **Step 2: Renderer section**

In `apps/desktop/src/renderer/src/main.tsx`:
- Update the `VsCodeSetupStatus` mirror type (search `type VsCodeSetupStatus =`) with `extensionWindows: number`.
- In the `selectedId === "vscode"` dialog block (after the Management section, before the MCP-preview `<details>`), add:

```tsx
                  <section className="plugin-section">
                    <div className="plugin-section-title"><small>{t("integrations.vscode.ext.kicker")}</small><strong>{t("integrations.vscode.ext.title")}</strong></div>
                    <div className="flex items-center justify-between p-3 rounded-2xl bg-stone-50/50 border border-stone-100/50">
                      <div className="flex flex-col">
                        <strong className="text-sm text-navy">
                          {snapshot.vscodeStatus.extensionWindows > 0
                            ? t("integrations.vscode.ext.connected", { count: snapshot.vscodeStatus.extensionWindows })
                            : t("integrations.vscode.ext.notDetected")}
                        </strong>
                        <small className="text-xs text-slatecopy">{t("integrations.vscode.ext.description")}</small>
                      </div>
                      <StatusPill tone={snapshot.vscodeStatus.extensionWindows > 0 ? "green" : "slate"}>
                        {snapshot.vscodeStatus.extensionWindows > 0 ? t("integrations.vscode.ext.pill.on") : t("integrations.vscode.ext.pill.off")}
                      </StatusPill>
                    </div>
                    <p className="mt-2 text-xs text-slatecopy">{t("integrations.vscode.ext.sideloadHint")}</p>
                    <pre className="mt-2 p-3 rounded-xl bg-navy/5 text-[10px] font-mono overflow-x-auto border border-navy/5">
                      code --install-extension openpets-vscode-0.1.0.vsix
                    </pre>
                  </section>
```

Check how `t()` handles interpolation in this codebase (search for an existing key using `{count}` or similar); if it doesn't support variables, use two keys (`ext.connectedPrefix` + rendered number) instead.

- [ ] **Step 3: i18n keys (all 7 locales)**

Add next to the existing `integrations.vscode.*` keys. English values:

```ts
  "integrations.vscode.ext.kicker": "Extension",
  "integrations.vscode.ext.title": "Terminal tab focus",
  "integrations.vscode.ext.description": "Reveals the exact terminal tab when the pet focuses a session.",
  "integrations.vscode.ext.connected": "Connected — {count} window(s)",
  "integrations.vscode.ext.notDetected": "Not detected",
  "integrations.vscode.ext.pill.on": "Connected",
  "integrations.vscode.ext.pill.off": "Off",
  "integrations.vscode.ext.sideloadHint": "Build the extension package and install the .vsix in VS Code (Marketplace release pending):",
```

Translate for ja/ko/es-419/pt-BR/zh-Hans/zh-Hant following each file's existing tone (see the `integrations.vscode.description` entries added earlier as reference).

- [ ] **Step 4: Typecheck + run**

Run: `cd apps/desktop && pnpm typecheck`
Expected: PASS (both main and renderer configs).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): show VS Code extension tab-focus status in integration dialog"
```

---

### Task 6: Docs, codemaps, and end-to-end verification

**Files:**
- Create: `packages/vscode-extension/codemap.md` (mirror `packages/vscode/codemap.md` structure: responsibility, wait-loop flow, matching, safety notes)
- Modify: `packages/codemap.md` (bullet + directory row for `vscode-extension/`)
- Modify: `apps/desktop/src/codemap.md` (vscode-tab-focus module in the IPC/focus flow)
- Modify: `docs/superpowers/specs/2026-07-16-vscode-integration-design.md` — no change needed; verify the tab-focus spec's "Deferred" list still matches reality.

- [ ] **Step 1: Write the codemaps** (content per the spec's Architecture section; keep each under a page)

- [ ] **Step 2: Full workspace verification**

Run, from repo root:
```bash
pnpm --filter @open-pets/client check
pnpm --filter openpets-vscode check
cd apps/desktop && pnpm typecheck && pnpm test
```
Expected: client + extension checks pass. Desktop suite: `vscode-tab-focus.test.js` passes; pre-existing Windows-only failures (`claude-memory.test.js` symlink EPERM, `check-packaging-contract.js` missing web asset) are not regressions — verify the failure list matches what `git stash && pnpm test` produces on main if unsure.

- [ ] **Step 3: Manual E2E (real VS Code)**

1. `pnpm --filter openpets-vscode package`, then in VS Code: `code --install-extension packages/vscode-extension/openpets-vscode-0.1.0.vsix`.
2. Start the desktop app (`cd apps/desktop && pnpm dev`). Open one VS Code window with two integrated-terminal tabs, run a Claude Code session in each (`claude` in both tabs).
3. Open the Integrations → VS Code dialog: extension section shows "Connected — 1 window(s)".
4. Trigger a notification in tab 2's session (or use the pet's notification centre); click it. Expected: VS Code window comes to front AND tab 2's terminal is revealed.
5. Repeat for tab 1. Expected: tab 1 revealed.
6. Disable the extension, repeat: window focus still works, no tab switch, no errors anywhere.
7. Quit the desktop app with the extension enabled: extension output channel shows idle retries with backoff, VS Code remains responsive.

- [ ] **Step 4: Commit**

```bash
git add packages/vscode-extension/codemap.md packages/codemap.md apps/desktop/src/codemap.md
git commit -m "docs: add codemaps for VS Code tab-focus extension and desktop module"
```
