export interface OnboardingPreferenceLike {
  readonly onboardingCompleted?: unknown;
}

export const petScaleOptions = [
  { label: "XS", value: 0.35 },
  { label: "Small", value: 0.5 },
  { label: "Medium", value: 0.75 },
  { label: "Large", value: 1 },
  { label: "Huge", value: 1.25 },
] as const;
export const minPetScale = 0.1;
export const maxPetScale = 3;
export type PetScaleValue = number;
export const defaultPetScale: PetScaleValue = 0.75;

export function normalizePetScale(value: unknown): PetScaleValue {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultPetScale;
  return Math.round(Math.max(minPetScale, Math.min(maxPetScale, value)) * 100) / 100;
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
 * Normalize the sessionAssignment preference value.
 * Default is "hub". Invalid values fall back to the default.
 */
export function normalizeSessionAssignment(value: unknown): "hub" | "auto-spawn" {
  return value === "hub" || value === "auto-spawn" ? value : "hub";
}

/**
 * Normalize the petSelectionStrategy preference value.
 * Default is "random". Invalid values fall back to the default.
 */
export function normalizePetSelectionStrategy(value: unknown): "random" | "ordered" {
  return value === "random" || value === "ordered" ? value : "random";
}

export const defaultIdleChatWarnMinutes = 50;
export const minIdleChatWarnMinutes = 5;
/** Must stay below the fixed 59-minute auto-compact threshold (idle-chat-watchdog.ts). */
export const maxIdleChatWarnMinutes = 58;

/**
 * Normalize the idleChatWarnMinutes preference value.
 * Non-numeric input falls back to the default; numeric input is clamped to
 * [minIdleChatWarnMinutes, maxIdleChatWarnMinutes] and rounded to an integer.
 */
export function normalizeIdleChatWarnMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultIdleChatWarnMinutes;
  return Math.min(maxIdleChatWarnMinutes, Math.max(minIdleChatWarnMinutes, Math.round(value)));
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
