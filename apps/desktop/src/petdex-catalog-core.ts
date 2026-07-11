/**
 * Pure validation/parsing for the Petdex community catalog (no Electron imports).
 *
 * Petdex pets use the same Codex pet package format OpenPets already installs
 * (pet.json + spritesheet.webp, validated by codex-pets-core). OpenPets never
 * rehosts Petdex assets: everything is fetched from the pinned asset host at
 * user-initiated browse/install time, with submitter attribution in the UI.
 */

export const petdexAssetHost = "assets.petdex.dev";
export const petdexManifestUrl = "https://assets.petdex.dev/manifests/petdex-v1.json";
export const petdexPetPageUrl = "https://petdex.dev/pets/";
export const maxPetdexManifestBytes = 8 * 1024 * 1024;
export const maxPetdexPets = 5_000;

export interface PetdexManifestEntry {
  readonly slug: string;
  readonly displayName: string;
  readonly kind: string;
  readonly submittedBy: string;
  readonly spritesheetUrl: string;
  readonly petJsonUrl: string;
  readonly zipUrl: string;
}

export function parsePetdexManifest(value: unknown): readonly PetdexManifestEntry[] {
  if (!isRecord(value) || !Array.isArray(value.pets)) throw new Error("Petdex manifest must contain a pets array.");
  const entries: PetdexManifestEntry[] = [];
  const seen = new Set<string>();
  for (const item of value.pets) {
    if (entries.length >= maxPetdexPets) break;
    const entry = tryParsePetdexEntry(item);
    if (!entry || seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    entries.push(entry);
  }
  return entries;
}

export function validatePetdexAssetUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Petdex asset URL must be a string.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Petdex asset URL is invalid.");
  }
  if (url.protocol !== "https:") throw new Error("Petdex asset URL must use https.");
  if (url.hostname !== petdexAssetHost) throw new Error("Petdex asset URL host is not allowed.");
  if (url.port !== "") throw new Error("Petdex asset URL must not set a port.");
  if (url.username !== "" || url.password !== "") throw new Error("Petdex asset URL must not embed credentials.");
  return value;
}

function tryParsePetdexEntry(value: unknown): PetdexManifestEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.slug !== "string" || !isSafePetdexSlug(value.slug)) return undefined;
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  if (displayName.length === 0 || displayName.length > 80) return undefined;
  const kind = typeof value.kind === "string" ? value.kind.trim().slice(0, 40) : "";
  const submittedBy = typeof value.submittedBy === "string" ? value.submittedBy.trim().slice(0, 80) : "";
  try {
    return {
      slug: value.slug,
      displayName,
      kind,
      submittedBy,
      spritesheetUrl: validatePetdexAssetUrl(value.spritesheetUrl),
      petJsonUrl: validatePetdexAssetUrl(value.petJsonUrl),
      zipUrl: validatePetdexAssetUrl(value.zipUrl),
    };
  } catch {
    return undefined;
  }
}

// Same rule as safe Codex pet ids: the slug doubles as the installed pet id.
export function isSafePetdexSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) && value !== "builtin";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
