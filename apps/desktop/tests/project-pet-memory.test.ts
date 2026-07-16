import assert from "node:assert/strict";

import {
  maxProjectPetAssignments,
  normalizeProjectPath,
  normalizeProjectPetAssignments,
  withProjectPetAssignment,
  withoutProjectPetAssignment,
} from "../src/project-pet-memory.js";

// normalizeProjectPath
assert.equal(normalizeProjectPath(undefined), null, "non-string -> null");
assert.equal(normalizeProjectPath("   "), null, "blank -> null");
assert.equal(normalizeProjectPath("a".repeat(1025)), null, "too long -> null");
assert.equal(normalizeProjectPath("/home/user/proj/"), "/home/user/proj", "trailing slash stripped");
assert.equal(normalizeProjectPath("C:\\Users\\Dev\\Proj\\", true), "c:/users/dev/proj", "win32: backslashes + lowercase");
assert.equal(normalizeProjectPath("/Case/Kept", false), "/Case/Kept", "case kept when case-sensitive");
assert.equal(normalizeProjectPath("/"), "/", "root survives");

// normalizeProjectPetAssignments
assert.equal(normalizeProjectPetAssignments(undefined), undefined, "undefined -> undefined");
assert.equal(normalizeProjectPetAssignments([]), undefined, "array -> undefined");
assert.equal(normalizeProjectPetAssignments({}), undefined, "empty -> undefined");
assert.deepEqual(
  normalizeProjectPetAssignments({ "/a/b/": "fox", "  ": "cat", "/c": 7, "/d": "Bad Pet!" }),
  { "/a/b": "fox" },
  "keeps only valid path->safe-pet-id entries",
);
{
  const big: Record<string, string> = {};
  for (let i = 0; i < maxProjectPetAssignments + 10; i++) big[`/p/${i}`] = "fox";
  const normalized = normalizeProjectPetAssignments(big);
  assert.equal(Object.keys(normalized ?? {}).length, maxProjectPetAssignments, "capped on read");
}

// withProjectPetAssignment — recency refresh + eviction
{
  let map: Record<string, string> | undefined;
  map = withProjectPetAssignment(map, "/a", "fox");
  map = withProjectPetAssignment(map, "/b", "cat");
  map = withProjectPetAssignment(map, "/a", "dog"); // refreshes /a to newest
  assert.deepEqual(Object.entries(map), [["/b", "cat"], ["/a", "dog"]], "rewrite refreshes position");
  for (let i = 0; i < maxProjectPetAssignments; i++) map = withProjectPetAssignment(map, `/fill/${i}`, "fox");
  assert.equal(Object.keys(map).length, maxProjectPetAssignments, "capped");
  assert.equal(map["/b"], undefined, "least-recently-written evicted");
  assert.equal(map[`/fill/${maxProjectPetAssignments - 1}`], "fox", "newest kept");
}

// withoutProjectPetAssignment
assert.equal(withoutProjectPetAssignment(undefined, "/a"), undefined, "missing map passthrough");
assert.deepEqual(withoutProjectPetAssignment({ "/a": "fox", "/b": "cat" }, "/a"), { "/b": "cat" });
assert.equal(withoutProjectPetAssignment({ "/a": "fox" }, "/a"), undefined, "empty collapses to undefined");

console.log("project-pet-memory tests passed");
