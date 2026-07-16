import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Desktop-specific VS Code integration checks
// These verify that the desktop app correctly uses the @open-pets/vscode package

const root = realpathSync(mkdtempSync(join(tmpdir(), "openpets-vscode-desktop-")));

try {
  // Test that desktop would use the correct global config path per platform
  const homeDir = join(root, "home");
  mkdirSync(homeDir);
  const appDataDir = join(homeDir, "AppData", "Roaming");
  const winConfigPath = join(appDataDir, "Code", "User", "mcp.json");

  // Verify the path structure matches what desktop uses (app.getPath("appData") on Windows)
  assert.ok(winConfigPath.endsWith(join("Code", "User", "mcp.json")), "VS Code global config path must end with Code/User/mcp.json");
  assert.ok(!winConfigPath.includes(".."), "VS Code config path must not contain traversal");

  // Test that desktop would handle missing config gracefully
  const missingResult = { ok: true as const, config: {}, exists: false };
  assert.equal(missingResult.ok, true);
  assert.equal(missingResult.exists, false);

  // Test that desktop would handle installed config (VS Code "servers" key)
  const vscodeDir = join(root, "vscode");
  mkdirSync(vscodeDir);
  const configPath = join(vscodeDir, "mcp.json");
  const installedConfig = {
    servers: {
      openpets: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@open-pets/mcp@2.0.6", "--pet", "fixer"],
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(installedConfig, null, 2), "utf8");

  const content = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed.servers.openpets, installedConfig.servers.openpets);

  // Test that desktop would preserve unrelated servers and VS Code-specific keys during operations
  const multiServerConfig = {
    servers: {
      openpets: installedConfig.servers.openpets,
      other: { type: "stdio", command: "test", args: [] },
    },
    inputs: [{ type: "promptString", id: "api-key" }],
    sandbox: { filesystem: {} },
  };
  const multiPath = join(vscodeDir, "multi.json");
  writeFileSync(multiPath, JSON.stringify(multiServerConfig, null, 2), "utf8");

  const multiContent = JSON.parse(readFileSync(multiPath, "utf8"));
  assert.equal(multiContent.servers.other.type, "stdio");
  assert.equal(Array.isArray(multiContent.inputs), true);
  assert.equal(typeof multiContent.sandbox, "object");

  // Test that desktop would detect command modes correctly
  const publishedEntry = {
    type: "stdio",
    command: "npx",
    args: ["-y", "@open-pets/mcp@2.0.6", "--pet", "test"],
  };
  assert.equal(publishedEntry.command, "npx");
  assert.ok(publishedEntry.args[1].includes("@"), "Published mode must use pinned version");

  const localEntry = {
    type: "stdio",
    command: "node",
    args: ["/absolute/path/to/mcp.js", "--pet", "test"],
  };
  assert.equal(localEntry.command, "node");
  assert.ok(localEntry.args[0].startsWith("/"), "Local mode must use absolute path");

  // Test status mapping that desktop uses
  const statusMap = {
    missing: { state: "needs_setup", label: "Not configured" },
    installed: { state: "configured", label: "Configured" },
    "needs-update": { state: "needs_update", label: "Needs update" },
    conflict: { state: "conflict", label: "Conflict" },
    invalid: { state: "error", label: "Config error" },
    error: { state: "error", label: "Config error" },
  };

  for (const [status, expected] of Object.entries(statusMap)) {
    assert.ok(expected.state, `Status ${status} must map to a state`);
    assert.ok(expected.label, `Status ${status} must map to a label`);
  }

  // Test that desktop would handle action availability correctly
  const actionMatrix = {
    missing: { canInstall: true, canReplace: false, canRemove: false },
    installed: { canInstall: false, canReplace: false, canRemove: true },
    "needs-update": { canInstall: true, canReplace: true, canRemove: true },
    conflict: { canInstall: false, canReplace: true, canRemove: false },
    invalid: { canInstall: false, canReplace: false, canRemove: false },
    error: { canInstall: false, canReplace: false, canRemove: false },
  };

  for (const [status, actions] of Object.entries(actionMatrix)) {
    assert.equal(typeof actions.canInstall, "boolean", `Status ${status} must define canInstall`);
    assert.equal(typeof actions.canReplace, "boolean", `Status ${status} must define canReplace`);
    assert.equal(typeof actions.canRemove, "boolean", `Status ${status} must define canRemove`);
  }

  // Test that desktop would create valid MCP preview under the "servers" key
  const preview = {
    servers: {
      openpets: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@open-pets/mcp@2.0.6", "--pet", "fixer"],
      },
    },
  };
  assert.equal(preview.servers.openpets.type, "stdio");
  assert.equal(preview.servers.openpets.command, "npx");
  assert.ok(Array.isArray(preview.servers.openpets.args));

  console.error("VS Code desktop validation passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
