import assert from "node:assert/strict";

import { errorResponse, maxIpcMessageBytes, parseIpcRequest, validateReaction, validateSayMessage, validateInstallLocalKind, validateInstallLocalPath, validateCwd } from "../src/local-ipc-protocol.js";

const token = "test-token";
const valid = {
  id: "1",
  version: 1,
  token,
  method: "status",
  params: {},
};

parseIpcRequest(JSON.stringify(valid), token);
parseIpcRequest(JSON.stringify({ ...valid, method: "pets.list" }), token);
parseIpcRequest(JSON.stringify({ ...valid, method: "pets.install-local" }), token);
assert.throws(() => parseIpcRequest(JSON.stringify({ ...valid, token: "bad" }), token));
assert.throws(() => parseIpcRequest(JSON.stringify({ ...valid, version: 2 }), token));
assert.throws(() => parseIpcRequest(JSON.stringify({ ...valid, method: "pet.install" }), token));
assert.throws(() => parseIpcRequest("not json", token));

validateReaction("testing");
validateReaction("waving");
assert.throws(() => validateReaction("bad"));

validateSayMessage("Working on it");
for (const unsafe of [
  "",
  "a".repeat(141),
  "line one\nline two",
  "```code```",
  "const secret = 1",
  "https://example.com",
  "/Users/alvin/project/file.ts",
  "api_key=abc123",
]) {
  assert.throws(() => validateSayMessage(unsafe));
}

if (Buffer.byteLength(JSON.stringify({ message: "x".repeat(maxIpcMessageBytes) }), "utf8") <= maxIpcMessageBytes) {
  throw new Error("Oversized fixture was not oversized.");
}

validateInstallLocalPath("/tmp/my-pet.zip");
assert.throws(() => validateInstallLocalPath(""));
assert.throws(() => validateInstallLocalPath("./my-pet"));
assert.throws(() => validateInstallLocalPath("\x00"));
assert.throws(() => validateInstallLocalPath("a".repeat(2049)));
assert.equal(validateInstallLocalKind("zip"), "zip");
assert.equal(validateInstallLocalKind("folder"), "folder");
assert.throws(() => validateInstallLocalKind("file"));

const response = errorResponse("1", new Error("boom"));
if (response.ok || response.error?.code !== "internal_error") {
  throw new Error("Failed to create structured error response.");
}

// --- validateCwd (optional, tolerant — mirrors validateSessionNonce) ---
assert.equal(validateCwd(undefined), undefined, "cwd absent is fine");
assert.equal(validateCwd(42), undefined, "non-string cwd ignored");
assert.equal(validateCwd("  "), undefined, "blank cwd ignored");
assert.equal(validateCwd("C:\\Users\\me\\fraud_project"), "C:\\Users\\me\\fraud_project");
assert.equal(validateCwd("/home/me/api-fix"), "/home/me/api-fix");
assert.equal(validateCwd("x".repeat(1025)), undefined, "cwd >1024 chars ignored");
assert.equal(validateCwd("bad\u0000path"), undefined, "control chars rejected");

console.log("Local IPC protocol validation passed.");
