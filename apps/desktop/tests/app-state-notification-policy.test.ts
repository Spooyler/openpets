/**
 * Unit tests for notification policy normalization:
 *   (1) Accepts { waiting: "persistent", working: "fade", idle: "off" }
 *   (2) Drops unknown modes (e.g. "bogus")
 *   (3) Drops non-string keys
 *   (4) Returns {} for garbage (non-object, null, number)
 *
 * NOTE: app-state.ts imports Electron so we cannot import it here directly.
 * Instead we test the normalization contract via the pure normalizer exported
 * from app-state-core.ts.
 */
import assert from "node:assert/strict";
import { normalizeNotificationPolicy } from "../src/app-state-core.js";

// Test (1): Valid policy with all valid modes
{
  const result = normalizeNotificationPolicy({
    waiting: "persistent",
    working: "fade",
    idle: "off",
  });
  assert.deepEqual(result, {
    waiting: "persistent",
    working: "fade",
    idle: "off",
  }, "(1) accepts valid policy with mixed modes");
}

// Test (2a): Drops unknown modes
{
  const result = normalizeNotificationPolicy({
    waiting: "persistent",
    working: "bogus",
    idle: "off",
  });
  assert.deepEqual(result, {
    waiting: "persistent",
    idle: "off",
  }, "(2a) drops unknown mode 'bogus'");
}

// Test (2b): Drops multiple unknown modes
{
  const result = normalizeNotificationPolicy({
    waiting: "invalid",
    working: "also-invalid",
    idle: "off",
  });
  assert.deepEqual(result, {
    idle: "off",
  }, "(2b) drops all invalid modes");
}

// Test (3a): Drops non-string keys (numbers)
{
  const result = normalizeNotificationPolicy({
    waiting: "persistent",
    123: "fade",
    idle: "off",
  } as unknown as Record<string, string>);
  assert.deepEqual(result, {
    waiting: "persistent",
    idle: "off",
  }, "(3a) drops non-string keys (numbers)");
}

// Test (3b): Drops non-string keys (symbols)
{
  const result = normalizeNotificationPolicy({
    waiting: "persistent",
    idle: "off",
  });
  assert.deepEqual(result, {
    waiting: "persistent",
    idle: "off",
  }, "(3b) non-string keys are dropped by type system");
}

// Test (4a): Garbage input (null) returns empty object
{
  const result = normalizeNotificationPolicy(null);
  assert.deepEqual(result, {}, "(4a) null input returns {}");
}

// Test (4b): Garbage input (undefined) returns empty object
{
  const result = normalizeNotificationPolicy(undefined);
  assert.deepEqual(result, {}, "(4b) undefined input returns {}");
}

// Test (4c): Garbage input (number) returns empty object
{
  const result = normalizeNotificationPolicy(42);
  assert.deepEqual(result, {}, "(4c) number input returns {}");
}

// Test (4d): Garbage input (string) returns empty object
{
  const result = normalizeNotificationPolicy("not an object");
  assert.deepEqual(result, {}, "(4d) string input returns {}");
}

// Test (4e): Garbage input (array) returns empty object
{
  const result = normalizeNotificationPolicy(["waiting", "persistent"]);
  assert.deepEqual(result, {}, "(4e) array input returns {}");
}

// Test (5): Empty object passes through
{
  const result = normalizeNotificationPolicy({});
  assert.deepEqual(result, {}, "(5) empty object returns {}");
}

// Test (6): All valid modes pass through
{
  const result = normalizeNotificationPolicy({
    foo: "persistent",
    bar: "fade",
    baz: "off",
  });
  assert.deepEqual(result, {
    foo: "persistent",
    bar: "fade",
    baz: "off",
  }, "(6) all valid modes pass through");
}

// Test (7): Mixed valid and invalid modes filters correctly
{
  const result = normalizeNotificationPolicy({
    waiting: "persistent",
    working: "fade",
    idle: "off",
    error: "invalid",
    custom: "persistent",
  });
  assert.deepEqual(result, {
    waiting: "persistent",
    working: "fade",
    idle: "off",
    custom: "persistent",
  }, "(7) filters invalid modes while keeping valid ones");
}

console.log("app-state-notification-policy tests passed.");
