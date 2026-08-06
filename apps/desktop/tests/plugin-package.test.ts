import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeDeletePluginInstallDir } from "../src/plugin-package.js";

const deleteRoot = mkdtempSync(join(tmpdir(), "openpets-plugin-delete-"));
const outside = mkdtempSync(join(tmpdir(), "openpets-plugin-outside-"));
symlinkSync(outside, join(deleteRoot, "plugins"), "junction");
await assert.rejects(() => safeDeletePluginInstallDir(deleteRoot, "test-plug", join(deleteRoot, "plugins", "test-plug"), "bundled"), /invalid|unexpected/);

console.error("Plugin package validation passed.");
