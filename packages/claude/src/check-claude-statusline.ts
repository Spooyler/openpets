import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { formatStatuslineText, handleClaudeStatuslinePayload } from "./statusline.js";
import { createOpenPetsStatuslineCommand, doctorClaudeStatusline, installClaudeStatusline, uninstallClaudeStatusline } from "./statusline-settings.js";

// formatStatuslineText: full payload, partial payloads, junk — never empty, single line.
assert.equal(
  formatStatuslineText({ model: { display_name: "Opus" }, workspace: { current_dir: "C:\\repo\\my-app" }, context_window: { used_percentage: 8 } }),
  "🐾 Opus · my-app · ctx 8%",
);
assert.equal(
  formatStatuslineText({ model: { display_name: "Opus" }, workspace: { current_dir: "/home/u/proj" } }),
  "🐾 Opus · proj",
);
assert.equal(formatStatuslineText({}), "🐾 OpenPets");
assert.equal(formatStatuslineText({ model: { display_name: "A\nB" } }), "🐾 OpenPets");
assert.equal(formatStatuslineText({ model: { display_name: "Sonnet 4.5" } }), "🐾 Sonnet 4.5");
assert.equal(formatStatuslineText({ context_window: { used_percentage: 42.6 } }), "🐾 OpenPets · ctx 43%");

const dir = mkdtempSync(join(tmpdir(), "openpets-statusline-"));
try {
  const pings: Array<string | undefined> = [];
  const lines: string[] = [];
  const leases: string[] = [];
  const options = {
    throttlePath: join(dir, "throttle.json"),
    write: (line: string) => { lines.push(line); },
    sendActivity: async (leaseId?: string) => { pings.push(leaseId); },
    client: {
      acquireLease: async (opts?: { readonly requestedPetId?: string }) => {
        leases.push(opts?.requestedPetId ?? "");
        return { leaseId: "lease-1" };
      },
    },
  };

  // First invocation: prints text, pings (no lease without configuredPetId).
  const first = await handleClaudeStatuslinePayload(JSON.stringify({ model: { display_name: "Opus" } }), { ...options, now: () => 100_000 });
  assert.equal(first.text, "🐾 Opus");
  assert.equal(first.pinged, true);
  assert.deepEqual(lines, ["🐾 Opus"]);
  assert.deepEqual(pings, [undefined]);

  // Second invocation within the 5s cooldown: prints but does NOT ping.
  const second = await handleClaudeStatuslinePayload(JSON.stringify({ model: { display_name: "Opus" } }), { ...options, now: () => 103_000 });
  assert.equal(second.pinged, false);
  assert.equal(pings.length, 1);
  assert.equal(lines.length, 2);

  // After cooldown with configuredPetId: acquires lease, pings with leaseId.
  const third = await handleClaudeStatuslinePayload(JSON.stringify({}), { ...options, configuredPetId: "fixer", now: () => 106_000 });
  assert.equal(third.pinged, true);
  assert.deepEqual(leases, ["fixer"]);
  assert.equal(pings.at(-1), "lease-1");

  // Failing ping is swallowed; text still returned.
  const failing = await handleClaudeStatuslinePayload(JSON.stringify({}), { ...options, sendActivity: async () => { throw new Error("down"); }, now: () => 112_000 });
  assert.equal(failing.text, "🐾 OpenPets");
  assert.equal(failing.pinged, false);

  // Malformed JSON: still prints fallback text, never throws.
  const malformed = await handleClaudeStatuslinePayload("not json", { ...options, now: () => 118_000 });
  assert.equal(malformed.text, "🐾 OpenPets");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.error("Claude statusline validation passed.");

const settingsDir = mkdtempSync(join(tmpdir(), "openpets-statusline-settings-"));
try {
  const command = createOpenPetsStatuslineCommand();
  assert.ok(command.includes("--openpets-managed"));
  assert.ok(/\bstatusline\b/.test(command));
  assert.ok(!/\bhook\b/.test(command));
  assert.ok(createOpenPetsStatuslineCommand("published", "fixer").endsWith("--pet fixer"));

  // Fresh settings: not installed → install → installed → idempotent → uninstall.
  const path = join(settingsDir, "settings.json");
  writeFileSync(path, JSON.stringify({ theme: "dark" }), "utf8");
  assert.equal(doctorClaudeStatusline(path).status, "not_installed");
  const installed = installClaudeStatusline(path);
  assert.equal(installed.status, "installed");
  assert.equal(installed.changed, true);
  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(written.theme, "dark");
  assert.equal(written.statusLine.type, "command");
  assert.equal(written.statusLine.padding, 0);
  assert.ok(written.statusLine.command.includes("--openpets-managed"));
  assert.equal(written.statusLine.refreshInterval, undefined);
  assert.equal(installClaudeStatusline(path).changed, false);
  assert.equal(uninstallClaudeStatusline(path).changed, true);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).statusLine, undefined);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).theme, "dark");

  // Foreign statusLine: conflict, install refuses and leaves it untouched.
  writeFileSync(path, JSON.stringify({ statusLine: { type: "command", command: "my-custom-status" } }), "utf8");
  assert.equal(doctorClaudeStatusline(path).status, "conflict");
  const refused = installClaudeStatusline(path);
  assert.equal(refused.status, "conflict");
  assert.equal(refused.changed, false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).statusLine.command, "my-custom-status");
  // Uninstall never touches a foreign statusLine.
  assert.equal(uninstallClaudeStatusline(path).changed, false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).statusLine.command, "my-custom-status");

  // Stale managed entry (different pet) → needs_update; reinstall replaces it.
  writeFileSync(path, JSON.stringify({ statusLine: { type: "command", command: createOpenPetsStatuslineCommand("published", "old-pet"), padding: 0 } }), "utf8");
  assert.equal(doctorClaudeStatusline(path, "published", "fixer").status, "needs_update");
  assert.equal(installClaudeStatusline(path, "published", "fixer").status, "installed");
  assert.ok(JSON.parse(readFileSync(path, "utf8")).statusLine.command.endsWith("--pet fixer"));

  // Invalid settings shapes → error status.
  writeFileSync(path, JSON.stringify({ statusLine: "bad" }), "utf8");
  assert.equal(doctorClaudeStatusline(path).status, "error");
} finally {
  rmSync(settingsDir, { recursive: true, force: true });
}
console.error("Claude statusline settings validation passed.");
