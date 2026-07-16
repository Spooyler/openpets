import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildVsCodeMcpEntry,
  formatVsCodeMcpConfig,
  getVsCodeGlobalMcpPath,
  getVsCodeWorkspaceMcpPath,
  isValidPetId,
  validateOpenPetsPetId,
} from "./vscode-mcp.js";
import {
  classifyVsCodeMcpStatus,
  executeVsCodeMcpWrite,
  maxVsCodeConfigBytes,
  planVsCodeMcpInstall,
  planVsCodeMcpRemove,
  planVsCodeMcpReplace,
  readVsCodeMcpConfig,
} from "./vscode-status.js";
import { buildOpenPetsOnlyPreview, redactVsCodeConfig } from "./vscode-previews.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "openpets-vscode-")));

// Creating symlinks on Windows requires Developer Mode or elevation; probe once and
// skip the symlink-rejection cases (not the code under test) when unavailable.
function canCreateSymlinks(baseDir: string): boolean {
  const probeTarget = join(baseDir, "symlink-probe-target");
  const probeLink = join(baseDir, "symlink-probe-link");
  writeFileSync(probeTarget, "", "utf8");
  try {
    symlinkSync(probeTarget, probeLink);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}

try {
  const symlinksAvailable = canCreateSymlinks(root);
  if (!symlinksAvailable) console.error("WARNING: symlink creation unavailable; skipping symlink-rejection cases.");

  // Test pet ID validation
  assert.equal(isValidPetId("fixer"), true);
  assert.equal(isValidPetId("my_pet-123"), true);
  assert.equal(isValidPetId("a"), true);
  assert.equal(isValidPetId("a".repeat(64)), true);
  assert.equal(isValidPetId(""), false);
  assert.equal(isValidPetId("-invalid"), false);
  assert.equal(isValidPetId("_invalid"), false);
  assert.equal(isValidPetId("invalid/slash"), false);
  assert.equal(isValidPetId("a".repeat(65)), false);
  assert.equal(validateOpenPetsPetId("fixer"), "fixer");
  assert.throws(() => validateOpenPetsPetId("bad/pet"));
  assert.throws(() => validateOpenPetsPetId(""));

  // Test MCP entry building
  const publishedEntry = buildVsCodeMcpEntry({ mcpVersion: "2.0.6", petId: "fixer" });
  assert.deepEqual(publishedEntry, {
    type: "stdio",
    command: "npx",
    args: ["-y", "@open-pets/mcp@2.0.6", "--pet", "fixer"],
  });

  const publishedNoPet = buildVsCodeMcpEntry({ mcpVersion: "2.0.6" });
  assert.deepEqual(publishedNoPet, {
    type: "stdio",
    command: "npx",
    args: ["-y", "@open-pets/mcp@2.0.6"],
  });
  assert.throws(() => buildVsCodeMcpEntry({ mcpVersion: "latest" }));

  const localEntry = buildVsCodeMcpEntry({
    mcpVersion: "2.0.6",
    petId: "helper",
    commandMode: "local",
    mcpEntryPath: join(root, "mcp.js"),
  });
  assert.deepEqual(localEntry, {
    type: "stdio",
    command: "node",
    args: [join(root, "mcp.js"), "--pet", "helper"],
  });

  assert.throws(() => buildVsCodeMcpEntry({ mcpVersion: "2.0.6", commandMode: "local", mcpEntryPath: "relative.js" }));

  // Test config formatting uses the VS Code "servers" key
  const formatted = formatVsCodeMcpConfig({ mcpVersion: "2.0.6", petId: "fixer" });
  assert.deepEqual(formatted, {
    servers: {
      openpets: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@open-pets/mcp@2.0.6", "--pet", "fixer"],
      },
    },
  });

  // Test per-platform path helpers
  const home = join(root, "home");
  assert.equal(
    getVsCodeGlobalMcpPath("win32", home, join(home, "AppData", "Roaming")),
    join(home, "AppData", "Roaming", "Code", "User", "mcp.json")
  );
  assert.equal(
    getVsCodeGlobalMcpPath("win32", home),
    join(home, "AppData", "Roaming", "Code", "User", "mcp.json")
  );
  assert.equal(
    getVsCodeGlobalMcpPath("darwin", home),
    join(home, "Library", "Application Support", "Code", "User", "mcp.json")
  );
  assert.equal(
    getVsCodeGlobalMcpPath("linux", home),
    join(home, ".config", "Code", "User", "mcp.json")
  );
  assert.equal(getVsCodeWorkspaceMcpPath(join(root, "project")), join(root, "project", ".vscode", "mcp.json"));

  // Test missing config classification
  const missingPath = join(root, "missing", "mcp.json");
  const missingResult = readVsCodeMcpConfig(missingPath);
  assert.equal(missingResult.ok, true);
  if (missingResult.ok) {
    assert.equal(missingResult.exists, false);
    assert.deepEqual(missingResult.config, {});
  }

  const missingStatus = classifyVsCodeMcpStatus(missingResult, missingPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal(missingStatus.status, "missing");
  assert.equal(missingStatus.canInstall, true);
  assert.equal(missingStatus.canReplace, false);
  assert.equal(missingStatus.canRemove, false);

  const unsafeBasePath = join(root, "file-parent");
  writeFileSync(unsafeBasePath, "not a directory", "utf8");
  const unsafeMissingPath = join(unsafeBasePath, "Code", "User", "mcp.json");
  const unsafeMissingResult = readVsCodeMcpConfig(unsafeMissingPath);
  assert.equal(unsafeMissingResult.ok, false);
  if (!unsafeMissingResult.ok) {
    assert.equal(unsafeMissingResult.reason, "unsafe-path");
  }
  const unsafeMissingStatus = classifyVsCodeMcpStatus(unsafeMissingResult, unsafeMissingPath, { mcpVersion: "2.0.6" });
  assert.equal(unsafeMissingStatus.status, "invalid");
  assert.equal(unsafeMissingStatus.canInstall, false);

  // Test empty config classification
  const emptyDir = join(root, "empty");
  mkdirSync(emptyDir);
  const emptyPath = join(emptyDir, "mcp.json");
  writeFileSync(emptyPath, "", "utf8");
  const emptyResult = readVsCodeMcpConfig(emptyPath);
  assert.equal(emptyResult.ok, true);
  if (emptyResult.ok) {
    assert.equal(emptyResult.exists, true);
    assert.deepEqual(emptyResult.config, {});
  }

  const emptyStatus = classifyVsCodeMcpStatus(emptyResult, emptyPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal(emptyStatus.status, "missing");
  assert.equal(emptyStatus.canInstall, true);

  // Test installed status
  const installedDir = join(root, "installed");
  mkdirSync(installedDir);
  const installedPath = join(installedDir, "mcp.json");
  const installedConfig = formatVsCodeMcpConfig({ mcpVersion: "2.0.6", petId: "fixer" });
  writeFileSync(installedPath, JSON.stringify(installedConfig, null, 2), "utf8");

  const installedResult = readVsCodeMcpConfig(installedPath);
  assert.equal(installedResult.ok, true);
  const installedStatus = classifyVsCodeMcpStatus(installedResult, installedPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal(installedStatus.status, "installed");
  assert.equal(installedStatus.canInstall, false);
  assert.equal(installedStatus.canReplace, false);
  assert.equal(installedStatus.canRemove, true);
  const installedReplacePlan = planVsCodeMcpReplace(installedPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal("ok" in installedReplacePlan, true);
  if ("ok" in installedReplacePlan) {
    assert.equal(installedReplacePlan.ok, false);
  }

  // Test needs-update status for old version
  const oldVersionDir = join(root, "old-version");
  mkdirSync(oldVersionDir);
  const oldVersionPath = join(oldVersionDir, "mcp.json");
  const oldVersionConfig = formatVsCodeMcpConfig({ mcpVersion: "2.0.5", petId: "fixer" });
  writeFileSync(oldVersionPath, JSON.stringify(oldVersionConfig, null, 2), "utf8");

  const oldVersionResult = readVsCodeMcpConfig(oldVersionPath);
  const oldVersionStatus = classifyVsCodeMcpStatus(oldVersionResult, oldVersionPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal(oldVersionStatus.status, "needs-update");
  assert.equal(oldVersionStatus.canInstall, true);
  assert.equal(oldVersionStatus.canReplace, true);
  assert.equal(oldVersionStatus.canRemove, true);

  // Test needs-update status for different pet
  const diffPetDir = join(root, "diff-pet");
  mkdirSync(diffPetDir);
  const diffPetPath = join(diffPetDir, "mcp.json");
  const diffPetConfig = formatVsCodeMcpConfig({ mcpVersion: "2.0.6", petId: "helper" });
  writeFileSync(diffPetPath, JSON.stringify(diffPetConfig, null, 2), "utf8");

  const diffPetResult = readVsCodeMcpConfig(diffPetPath);
  const diffPetStatus = classifyVsCodeMcpStatus(diffPetResult, diffPetPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal(diffPetStatus.status, "needs-update");

  // Test conflict status for non-OpenPets openpets entry
  const conflictDir = join(root, "conflict");
  mkdirSync(conflictDir);
  const conflictPath = join(conflictDir, "mcp.json");
  const conflictConfig = {
    servers: {
      openpets: { type: "stdio", command: "custom", args: ["mcp"] },
    },
  };
  writeFileSync(conflictPath, JSON.stringify(conflictConfig, null, 2), "utf8");

  const conflictResult = readVsCodeMcpConfig(conflictPath);
  const conflictStatus = classifyVsCodeMcpStatus(conflictResult, conflictPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal(conflictStatus.status, "conflict");
  assert.equal(conflictStatus.canInstall, false);
  assert.equal(conflictStatus.canReplace, true);
  assert.equal(conflictStatus.canRemove, false);

  const unpinnedDir = join(root, "unpinned");
  mkdirSync(unpinnedDir);
  const unpinnedPath = join(unpinnedDir, "mcp.json");
  writeFileSync(unpinnedPath, JSON.stringify({ servers: { openpets: { type: "stdio", command: "npx", args: ["-y", "@open-pets/mcp@latest"] } } }), "utf8");
  const unpinnedStatus = classifyVsCodeMcpStatus(readVsCodeMcpConfig(unpinnedPath), unpinnedPath, { mcpVersion: "2.0.6" });
  assert.equal(unpinnedStatus.status, "conflict");

  // A Cursor-style mcpServers key must not be treated as configured
  const cursorStyleDir = join(root, "cursor-style");
  mkdirSync(cursorStyleDir);
  const cursorStylePath = join(cursorStyleDir, "mcp.json");
  writeFileSync(cursorStylePath, JSON.stringify({ mcpServers: { openpets: { type: "stdio", command: "npx", args: ["-y", "@open-pets/mcp@2.0.6"] } } }), "utf8");
  const cursorStyleStatus = classifyVsCodeMcpStatus(readVsCodeMcpConfig(cursorStylePath), cursorStylePath, { mcpVersion: "2.0.6" });
  assert.equal(cursorStyleStatus.status, "missing");

  // Test invalid status for parse error
  const parseErrorDir = join(root, "parse-error");
  mkdirSync(parseErrorDir);
  const parseErrorPath = join(parseErrorDir, "mcp.json");
  writeFileSync(parseErrorPath, "{ invalid json", "utf8");

  const parseErrorResult = readVsCodeMcpConfig(parseErrorPath);
  assert.equal(parseErrorResult.ok, false);
  if (!parseErrorResult.ok) {
    assert.equal(parseErrorResult.reason, "parse");
  }

  const parseErrorStatus = classifyVsCodeMcpStatus(parseErrorResult, parseErrorPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal(parseErrorStatus.status, "invalid");
  assert.equal(parseErrorStatus.canInstall, false);

  // Test invalid status for oversized file
  const oversizedDir = join(root, "oversized");
  mkdirSync(oversizedDir);
  const oversizedPath = join(oversizedDir, "mcp.json");
  const largeContent = JSON.stringify({ data: "x".repeat(maxVsCodeConfigBytes + 1000) });
  writeFileSync(oversizedPath, largeContent, "utf8");

  const oversizedResult = readVsCodeMcpConfig(oversizedPath);
  assert.equal(oversizedResult.ok, false);
  if (!oversizedResult.ok) {
    assert.equal(oversizedResult.reason, "size");
  }

  // Test symlink rejection
  if (symlinksAvailable) {
    const symlinkDir = join(root, "symlink-test");
    mkdirSync(symlinkDir);
    const realFile = join(symlinkDir, "real.json");
    const symlinkFile = join(symlinkDir, "symlink.json");
    writeFileSync(realFile, "{}", "utf8");
    symlinkSync(realFile, symlinkFile);

    const symlinkResult = readVsCodeMcpConfig(symlinkFile);
    assert.equal(symlinkResult.ok, false);
    if (!symlinkResult.ok) {
      assert.equal(symlinkResult.reason, "symlink");
    }

    const danglingConfigSymlink = join(symlinkDir, "dangling-config.json");
    symlinkSync(join(symlinkDir, "missing-config.json"), danglingConfigSymlink);
    const danglingConfigResult = readVsCodeMcpConfig(danglingConfigSymlink);
    assert.equal(danglingConfigResult.ok, false);
    if (!danglingConfigResult.ok) {
      assert.equal(danglingConfigResult.reason, "symlink");
    }
  }

  // Test non-regular file rejection
  const nonRegularDir = join(root, "non-regular");
  mkdirSync(nonRegularDir);
  const directoryAsConfig = join(nonRegularDir, "mcp.json");
  mkdirSync(directoryAsConfig);
  const nonRegularResult = readVsCodeMcpConfig(directoryAsConfig);
  assert.equal(nonRegularResult.ok, false);
  if (!nonRegularResult.ok) {
    assert.equal(nonRegularResult.reason, "not-regular");
  }
  const nonRegularPlan = planVsCodeMcpInstall(directoryAsConfig, { mcpVersion: "2.0.6" });
  assert.equal("ok" in nonRegularPlan, true);
  if ("ok" in nonRegularPlan) {
    assert.equal(nonRegularPlan.ok, false);
  }

  const ioStatus = classifyVsCodeMcpStatus({ ok: false, reason: "io", message: "simulated io failure" }, join(root, "io", "mcp.json"), { mcpVersion: "2.0.6" });
  assert.equal(ioStatus.status, "error");
  assert.equal(ioStatus.canInstall, false);
  assert.equal(ioStatus.canReplace, false);
  assert.equal(ioStatus.canRemove, false);

  // Test non-object top-level config
  const nonObjectDir = join(root, "non-object");
  mkdirSync(nonObjectDir);
  const nonObjectPath = join(nonObjectDir, "mcp.json");
  writeFileSync(nonObjectPath, "[]", "utf8");

  const nonObjectResult = readVsCodeMcpConfig(nonObjectPath);
  assert.equal(nonObjectResult.ok, false);
  if (!nonObjectResult.ok) {
    assert.equal(nonObjectResult.reason, "invalid-schema");
  }

  // Test non-object servers
  const badServersDir = join(root, "bad-servers");
  mkdirSync(badServersDir);
  const badServersPath = join(badServersDir, "mcp.json");
  writeFileSync(badServersPath, JSON.stringify({ servers: [] }), "utf8");

  const badServersResult = readVsCodeMcpConfig(badServersPath);
  assert.equal(badServersResult.ok, false);
  if (!badServersResult.ok) {
    assert.equal(badServersResult.reason, "invalid-schema");
  }

  // Test malformed servers.openpets (not an object)
  const malformedEntryDir = join(root, "malformed-entry");
  mkdirSync(malformedEntryDir);
  const malformedEntryPath = join(malformedEntryDir, "mcp.json");
  writeFileSync(malformedEntryPath, JSON.stringify({ servers: { openpets: "string" } }), "utf8");

  const malformedEntryResult = readVsCodeMcpConfig(malformedEntryPath);
  assert.equal(malformedEntryResult.ok, true);
  const malformedEntryStatus = classifyVsCodeMcpStatus(malformedEntryResult, malformedEntryPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal(malformedEntryStatus.status, "conflict");

  // Test backup creation
  const backupDir = join(root, "backup");
  mkdirSync(backupDir);
  const backupPath = join(backupDir, "mcp.json");
  const originalContent = JSON.stringify({ servers: { other: { type: "stdio", command: "test", args: [] } } }, null, 2);
  writeFileSync(backupPath, originalContent, "utf8");

  const installPlan = planVsCodeMcpInstall(backupPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal("targetPath" in installPlan, true);
  if ("targetPath" in installPlan) {
    assert.equal(installPlan.backupPath !== undefined, true);
    executeVsCodeMcpWrite(installPlan);
    assert.equal(existsSync(backupPath), true);
    assert.equal(existsSync(installPlan.backupPath!), true);
    const backupContent = readFileSync(installPlan.backupPath!, "utf8");
    assert.equal(backupContent, originalContent);
  }

  // Test atomic write result
  const atomicDir = join(root, "atomic");
  mkdirSync(atomicDir);
  const atomicPath = join(atomicDir, "mcp.json");

  const atomicPlan = planVsCodeMcpInstall(atomicPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal("targetPath" in atomicPlan, true);
  if ("targetPath" in atomicPlan) {
    executeVsCodeMcpWrite(atomicPlan);
    assert.equal(existsSync(atomicPath), true);
    const writtenContent = JSON.parse(readFileSync(atomicPath, "utf8"));
    assert.deepEqual(writtenContent.servers.openpets, {
      type: "stdio",
      command: "npx",
      args: ["-y", "@open-pets/mcp@2.0.6", "--pet", "fixer"],
    });
  }

  // Test VS Code-specific top-level keys (inputs, sandbox) survive install and remove
  const vsKeysDir = join(root, "vs-keys");
  mkdirSync(vsKeysDir);
  const vsKeysPath = join(vsKeysDir, "mcp.json");
  const vsKeysConfig = {
    servers: {
      other: { type: "stdio", command: "test", args: [] },
    },
    inputs: [{ type: "promptString", id: "api-key", description: "API Key", password: true }],
    sandbox: { filesystem: {}, network: {} },
  };
  writeFileSync(vsKeysPath, JSON.stringify(vsKeysConfig, null, 2), "utf8");

  const vsKeysInstallPlan = planVsCodeMcpInstall(vsKeysPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal("targetPath" in vsKeysInstallPlan, true);
  if ("targetPath" in vsKeysInstallPlan) {
    executeVsCodeMcpWrite(vsKeysInstallPlan);
    const afterInstall = JSON.parse(readFileSync(vsKeysPath, "utf8"));
    assert.deepEqual(afterInstall.inputs, vsKeysConfig.inputs);
    assert.deepEqual(afterInstall.sandbox, vsKeysConfig.sandbox);
    assert.deepEqual(afterInstall.servers.other, vsKeysConfig.servers.other);
    assert.equal(afterInstall.servers.openpets.command, "npx");
  }

  const vsKeysRemovePlan = planVsCodeMcpRemove(vsKeysPath);
  assert.equal("targetPath" in vsKeysRemovePlan, true);
  if ("targetPath" in vsKeysRemovePlan) {
    executeVsCodeMcpWrite(vsKeysRemovePlan);
    const afterRemove = JSON.parse(readFileSync(vsKeysPath, "utf8"));
    assert.equal(afterRemove.servers.openpets, undefined);
    assert.deepEqual(afterRemove.inputs, vsKeysConfig.inputs);
    assert.deepEqual(afterRemove.sandbox, vsKeysConfig.sandbox);
    assert.deepEqual(afterRemove.servers.other, vsKeysConfig.servers.other);
  }

  // Test uninstall removes only OpenPets entry
  const uninstallDir = join(root, "uninstall");
  mkdirSync(uninstallDir);
  const uninstallPath = join(uninstallDir, "mcp.json");
  const uninstallConfig = {
    servers: {
      openpets: { type: "stdio", command: "npx", args: ["-y", "@open-pets/mcp@2.0.6", "--pet", "fixer"] },
      other: { type: "stdio", command: "test", args: [] },
    },
    otherField: "keep",
  };
  writeFileSync(uninstallPath, JSON.stringify(uninstallConfig, null, 2), "utf8");

  const removePlan = planVsCodeMcpRemove(uninstallPath);
  assert.equal("targetPath" in removePlan, true);
  if ("targetPath" in removePlan) {
    executeVsCodeMcpWrite(removePlan);
    const removedContent = JSON.parse(readFileSync(uninstallPath, "utf8"));
    assert.equal(removedContent.servers.openpets, undefined);
    assert.deepEqual(removedContent.servers.other, { type: "stdio", command: "test", args: [] });
    assert.equal(removedContent.otherField, "keep");
  }

  // Test no write on invalid
  const noWriteInvalidDir = join(root, "no-write-invalid");
  mkdirSync(noWriteInvalidDir);
  const noWriteInvalidPath = join(noWriteInvalidDir, "mcp.json");
  writeFileSync(noWriteInvalidPath, "{ invalid", "utf8");

  const noWriteInvalidPlan = planVsCodeMcpInstall(noWriteInvalidPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal("ok" in noWriteInvalidPlan, true);
  if ("ok" in noWriteInvalidPlan) {
    assert.equal(noWriteInvalidPlan.ok, false);
  }

  // Test no write on conflict unless explicit replace
  const noWriteConflictDir = join(root, "no-write-conflict");
  mkdirSync(noWriteConflictDir);
  const noWriteConflictPath = join(noWriteConflictDir, "mcp.json");
  writeFileSync(noWriteConflictPath, JSON.stringify({ servers: { openpets: { type: "stdio", command: "custom", args: [] } } }), "utf8");

  const noWriteConflictPlan = planVsCodeMcpInstall(noWriteConflictPath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal("ok" in noWriteConflictPlan, true);
  if ("ok" in noWriteConflictPlan) {
    assert.equal(noWriteConflictPlan.ok, false);
  }
  const noRemoveConflictPlan = planVsCodeMcpRemove(noWriteConflictPath);
  assert.equal("ok" in noRemoveConflictPlan, true);
  if ("ok" in noRemoveConflictPlan) {
    assert.equal(noRemoveConflictPlan.ok, false);
  }

  // Test explicit replace overwrites only openpets and preserves unrelated servers
  const replaceDir = join(root, "replace");
  mkdirSync(replaceDir);
  const replacePath = join(replaceDir, "mcp.json");
  const replaceConfig = {
    servers: {
      openpets: { type: "stdio", command: "custom", args: [] },
      other: { type: "stdio", command: "test", args: [] },
    },
    topLevelField: "preserve",
  };
  writeFileSync(replacePath, JSON.stringify(replaceConfig, null, 2), "utf8");

  const replacePlan = planVsCodeMcpReplace(replacePath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal("targetPath" in replacePlan, true);
  if ("targetPath" in replacePlan) {
    executeVsCodeMcpWrite(replacePlan);
    const replacedContent = JSON.parse(readFileSync(replacePath, "utf8"));
    assert.deepEqual(replacedContent.servers.openpets, {
      type: "stdio",
      command: "npx",
      args: ["-y", "@open-pets/mcp@2.0.6", "--pet", "fixer"],
    });
    assert.deepEqual(replacedContent.servers.other, { type: "stdio", command: "test", args: [] });
    assert.equal(replacedContent.topLevelField, "preserve");
  }

  // Test preview redaction
  const redactedConfig = {
    servers: {
      openpets: { type: "stdio", command: "npx", args: ["-y", "@open-pets/mcp@2.0.6"] },
      other: {
        type: "stdio",
        command: "test",
        args: ["--token=secret123", "--api-key=abc"],
        env: { SECRET: "hidden", TOKEN: "hidden" },
        headers: { Authorization: "Bearer token123" },
      },
    },
  };

  const redacted = redactVsCodeConfig(redactedConfig);
  assert.deepEqual(redacted.servers?.openpets, { type: "stdio", command: "npx", args: ["-y", "@open-pets/mcp@2.0.6"] });
  const otherServer = redacted.servers?.other as Record<string, unknown>;
  assert.deepEqual(otherServer.args, ["--token=[REDACTED]", "--api-key=[REDACTED]"]);
  assert.equal(otherServer.env, "[REDACTED]");
  assert.equal(otherServer.headers, "[REDACTED]");

  // Test recursive and case-insensitive redaction
  const recursiveConfig = {
    servers: {
      server1: {
        type: "stdio",
        command: "test",
        ENV: { secretValue: "hidden" },
        Auth: { password: "secret" },
        nested: {
          TOKEN: "bearer123",
          credentials: { apiKey: "key123" },
        },
      },
    },
  };

  const recursiveRedacted = redactVsCodeConfig(recursiveConfig);
  const server1 = recursiveRedacted.servers?.server1 as Record<string, unknown>;
  assert.equal(server1.ENV, "[REDACTED]");
  assert.equal(server1.Auth, "[REDACTED]");
  const nested = server1.nested as Record<string, unknown>;
  assert.equal(nested.TOKEN, "[REDACTED]");
  assert.equal(nested.credentials, "[REDACTED]");

  // Test inputs redaction outside servers
  const inputsConfig = {
    servers: {},
    inputs: [{ type: "promptString", id: "key", password: "hunter2" }],
  };
  const inputsRedacted = redactVsCodeConfig(inputsConfig);
  const redactedInputs = inputsRedacted.inputs as Array<Record<string, unknown>>;
  assert.equal(redactedInputs[0]?.password, "[REDACTED]");

  // Test URL with token-like query params redaction
  const urlConfig = {
    servers: {
      server1: {
        type: "stdio",
        command: "test",
        args: ["https://example.com/api?token=secret&other=value"],
      },
    },
  };

  const urlRedacted = redactVsCodeConfig(urlConfig);
  const urlServer = urlRedacted.servers?.server1 as Record<string, unknown>;
  const urlArgs = urlServer.args as string[];
  assert.ok(urlArgs[0].includes("[REDACTED]"));
  assert.ok(!urlArgs[0].includes("secret"));

  // Test OpenPets-only preview
  const preview = buildOpenPetsOnlyPreview({ mcpVersion: "2.0.6", petId: "fixer" });
  assert.deepEqual(preview.openpets, {
    type: "stdio",
    command: "npx",
    args: ["-y", "@open-pets/mcp@2.0.6", "--pet", "fixer"],
  });

  // Test existing unrelated MCP servers preserved during install
  const preserveDir = join(root, "preserve");
  mkdirSync(preserveDir);
  const preservePath = join(preserveDir, "mcp.json");
  const preserveConfig = {
    servers: {
      other: { type: "stdio", command: "test", args: [] },
    },
    topLevel: "keep",
  };
  writeFileSync(preservePath, JSON.stringify(preserveConfig, null, 2), "utf8");

  const preservePlan = planVsCodeMcpInstall(preservePath, { mcpVersion: "2.0.6", petId: "fixer" });
  assert.equal("targetPath" in preservePlan, true);
  if ("targetPath" in preservePlan) {
    executeVsCodeMcpWrite(preservePlan);
    const preservedContent = JSON.parse(readFileSync(preservePath, "utf8"));
    assert.deepEqual(preservedContent.servers.other, { type: "stdio", command: "test", args: [] });
    assert.equal(preservedContent.topLevel, "keep");
    assert.deepEqual(preservedContent.servers.openpets, {
      type: "stdio",
      command: "npx",
      args: ["-y", "@open-pets/mcp@2.0.6", "--pet", "fixer"],
    });
  }

  if (symlinksAvailable) {
    // Test symlink parent rejection
    const symlinkParentDir = join(root, "symlink-parent");
    const realParent = join(root, "real-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, symlinkParentDir);

    const symlinkParentPath = join(symlinkParentDir, "mcp.json");
    const symlinkParentPlan = planVsCodeMcpInstall(symlinkParentPath, { mcpVersion: "2.0.6", petId: "fixer" });
    assert.equal("ok" in symlinkParentPlan, true);
    if ("ok" in symlinkParentPlan) {
      assert.equal(symlinkParentPlan.ok, false);
    }

    // Test nested symlink ancestor rejection for missing and existing config files
    const nestedReal = join(root, "nested-real");
    mkdirSync(join(nestedReal, "sub", "User"), { recursive: true });
    const nestedLink = join(root, "nested-link");
    symlinkSync(nestedReal, nestedLink);
    const nestedMissingThroughLink = join(nestedLink, "missing", "User", "mcp.json");
    const nestedMissingResult = readVsCodeMcpConfig(nestedMissingThroughLink);
    assert.equal(nestedMissingResult.ok, false);
    if (!nestedMissingResult.ok) {
      assert.equal(nestedMissingResult.reason, "symlink");
    }
    const nestedExistingThroughLink = join(nestedLink, "sub", "User", "mcp.json");
    writeFileSync(join(nestedReal, "sub", "User", "mcp.json"), "{}", "utf8");
    const nestedExistingResult = readVsCodeMcpConfig(nestedExistingThroughLink);
    assert.equal(nestedExistingResult.ok, false);
    if (!nestedExistingResult.ok) {
      assert.equal(nestedExistingResult.reason, "symlink");
    }

    const danglingLink = join(root, "dangling-link");
    symlinkSync(join(root, "missing-target"), danglingLink);
    const danglingPath = join(danglingLink, "User", "mcp.json");
    const danglingResult = readVsCodeMcpConfig(danglingPath);
    assert.equal(danglingResult.ok, false);
    if (!danglingResult.ok) {
      assert.equal(danglingResult.reason, "symlink");
    }
  }

  // Parent traversal is rejected regardless of symlink support
  const traversalPath = `${join(root, "traversal-base")}/../traversal/User/mcp.json`;
  const traversalResult = readVsCodeMcpConfig(traversalPath);
  assert.equal(traversalResult.ok, false);
  if (!traversalResult.ok) {
    assert.equal(traversalResult.reason, "unsafe-path");
  }

  // Test empty servers kept as empty object after remove
  const emptyAfterRemoveDir = join(root, "empty-after-remove");
  mkdirSync(emptyAfterRemoveDir);
  const emptyAfterRemovePath = join(emptyAfterRemoveDir, "mcp.json");
  writeFileSync(emptyAfterRemovePath, JSON.stringify({ servers: { openpets: { type: "stdio", command: "npx", args: ["-y", "@open-pets/mcp@2.0.6"] } } }), "utf8");

  const emptyRemovePlan = planVsCodeMcpRemove(emptyAfterRemovePath);
  assert.equal("targetPath" in emptyRemovePlan, true);
  if ("targetPath" in emptyRemovePlan) {
    executeVsCodeMcpWrite(emptyRemovePlan);
    const emptyRemovedContent = JSON.parse(readFileSync(emptyAfterRemovePath, "utf8"));
    assert.deepEqual(emptyRemovedContent.servers, {});
  }

  console.error("VS Code validation passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
