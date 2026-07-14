export interface OnboardingPreferenceLike {
  readonly onboardingCompleted?: unknown;
}

export const petScaleOptions = [
  { label: "XS", value: 0.5 },
  { label: "Small", value: 0.75 },
  { label: "Medium", value: 1 },
  { label: "Large", value: 1.25 },
  { label: "Huge", value: 1.5 },
] as const;
export type PetScaleValue = typeof petScaleOptions[number]["value"];
export const defaultPetScale: PetScaleValue = 1;

export function normalizePetScale(value: unknown): PetScaleValue {
  return petScaleOptions.find((option) => option.value === value)?.value ?? defaultPetScale;
}

export function normalizeOnboardingCompleted(value: OnboardingPreferenceLike): boolean {
  return typeof value.onboardingCompleted === "boolean" ? value.onboardingCompleted : false;
}

export function markOnboardingCompleted<T extends { readonly preferences: Record<string, unknown> }>(state: T): T {
  return {
    ...state,
    preferences: {
      ...state.preferences,
      onboardingCompleted: true,
    },
  };
}

/**
 * Derive a stable string key for a display from its geometry.
 * Format: `"${x},${y},${width}x${height}"`.
 * Display IDs can change across reboots on some platforms, so we key on
 * physical bounds instead.
 */
export function deriveDisplayKey(bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): string {
  return `${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`;
}

export function shouldShowDefaultPetForExternalEvent(_visible: boolean, _openOnLaunch: boolean, paused: boolean): boolean {
  // Agent activity is an explicit display trigger; open-on-launch only controls startup.
  return !paused;
}

/**
 * Normalize the petConfinementEnabled preference value.
 * Default is true (confinement on). Non-boolean values fall back to the default.
 */
export function normalizePetConfinementEnabled(value: unknown, defaultValue = true): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

/**
 * Normalize the petCrossDisplayEnabled preference value.
 * Default is false (cross-display roaming off). Non-boolean values fall back to the default.
 */
export function normalizePetCrossDisplayEnabled(value: unknown, defaultValue = false): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

/**
 * Normalize the petGravityEnabled preference value.
 * Default is false (gravity off). Non-boolean values fall back to the default.
 */
export function normalizePetGravityEnabled(value: unknown, defaultValue = false): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

/**
 * Normalize the notificationPolicy preference value.
 * Filters to keep only valid mode strings ("persistent", "fade", "off") and string keys.
 * Drops numeric keys (e.g. { 123: "fade" }). Returns {} for garbage input (non-object, null, number, array, etc).
 */
export function normalizeNotificationPolicy(value: unknown): Record<string, "persistent" | "fade" | "off"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const validModes = new Set(["persistent", "fade", "off"]);
  const result: Record<string, "persistent" | "fade" | "off"> = {};

  for (const [key, mode] of Object.entries(value)) {
    // Skip numeric keys (JavaScript converts { 123: "x" } to { "123": "x" }, so detect that)
    const parsed = parseInt(key, 10);
    if (!isNaN(parsed) && String(parsed) === key) {
      continue;
    }

    if (typeof mode === "string" && validModes.has(mode)) {
      result[key] = mode as "persistent" | "fade" | "off";
    }
  }

  return result;
}
