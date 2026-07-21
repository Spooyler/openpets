import assert from "node:assert/strict";
import { hookNotificationMessage, notificationKindForHookEvent } from "../src/hook-notification-kind.js";

// hookEventToNotificationKind mapping
assert.strictEqual(notificationKindForHookEvent("PermissionRequest"), "permission");
assert.strictEqual(notificationKindForHookEvent("Stop"), "complete");
assert.strictEqual(notificationKindForHookEvent("StopFailure"), "error");
assert.strictEqual(notificationKindForHookEvent("PreToolUse"), undefined);
assert.strictEqual(notificationKindForHookEvent("UserPromptSubmit"), undefined);
assert.strictEqual(notificationKindForHookEvent(undefined), undefined);

// hookNotificationMessage wording per kind
assert.ok(hookNotificationMessage("permission").length > 0, "permission message must be non-empty");
assert.ok(hookNotificationMessage("complete").length > 0, "complete message must be non-empty");
assert.ok(hookNotificationMessage("error").length > 0, "error message must be non-empty");
assert.strictEqual(hookNotificationMessage("unknown-kind"), "unknown-kind", "unrecognized kind falls back to itself");

console.log("Hook notification kind mapping passed.");
