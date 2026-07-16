/**
 * project-pet-memory.ts — pure logic for the persisted project→pet map.
 *
 * Keys are normalized project paths (forward slashes, no trailing separator,
 * lowercased on case-insensitive filesystems); values are pet ids. The map is
 * capped: re-writing a key refreshes its position, and the least-recently-
 * written entry is evicted past the cap (same idiom as perMonitorPositions).
 */

import { assertSafePetId } from "./pet-paths.js";

export const maxProjectPetAssignments = 128;

/** Normalize a cwd into a stable map key. Returns null for unusable input. */
export function normalizeProjectPath(cwd: unknown, caseInsensitive: boolean = process.platform === "win32"): string | null {
  if (typeof cwd !== "string") return null;
  let path = cwd.trim();
  if (!path || path.length > 1024) return null;
  path = path.replace(/\\/g, "/");
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return caseInsensitive ? path.toLowerCase() : path;
}

/** Parse a persisted assignments map, dropping malformed entries. */
export function normalizeProjectPetAssignments(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawPet] of Object.entries(value as Record<string, unknown>)) {
    if (count >= maxProjectPetAssignments) break;
    const key = normalizeProjectPath(rawKey);
    if (key === null || typeof rawPet !== "string") continue;
    try {
      assertSafePetId(rawPet);
    } catch {
      continue;
    }
    if (key in result) continue;
    result[key] = rawPet;
    count += 1;
  }
  return count > 0 ? result : undefined;
}

/** Insert/update one assignment, refreshing recency and evicting past the cap. */
export function withProjectPetAssignment(
  existing: Record<string, string> | undefined,
  key: string,
  petId: string,
): Record<string, string> {
  const entries = Object.entries(existing ?? {}).filter(([k]) => k !== key);
  entries.push([key, petId]);
  return Object.fromEntries(entries.slice(-maxProjectPetAssignments));
}

/** Remove one assignment; collapses an empty map back to undefined. */
export function withoutProjectPetAssignment(
  existing: Record<string, string> | undefined,
  key: string,
): Record<string, string> | undefined {
  if (!existing || !(key in existing)) return existing;
  const entries = Object.entries(existing).filter(([k]) => k !== key);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
