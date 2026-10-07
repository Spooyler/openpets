/**
 * preference-patch.ts — pure preference-patch validation (no Electron).
 *
 * Extracted from windows.ts so the validation logic can be unit-tested
 * without an Electron process context.
 */

import { normalizeIdleChatWarnMinutes, normalizePetScale } from "./app-state-core.js";
import { isSupportedLocale, type LocalePreference } from "./i18n/index.js";
import { validateReactionAnimationOverrides } from "./reaction-animation-mapping.js";

export type PreferencePatch = {
  openDefaultPetOnLaunch?: boolean;
  locale?: LocalePreference;
  petScale?: number;
  reactionAnimationOverrides?: ReturnType<typeof validateReactionAnimationOverrides>;
  petPoolEnabled?: boolean;
  petConfinementEnabled?: boolean;
  petCrossDisplayEnabled?: boolean;
  petGravityEnabled?: boolean;
  idleChatWarnEnabled?: boolean;
  idleChatWarnMinutes?: number;
  idleChatAutoCompactEnabled?: boolean;
  notificationPolicy?: Record<string, "persistent" | "fade" | "off">;
  petAssignmentMode?: "per-session" | "per-project";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and parse an arbitrary preferences patch from the renderer.
 * Only recognised keys are forwarded; unknown keys are silently ignored.
 * Throws on malformed values so the IPC handler can return a clean error.
 */
export function validatePreferencePatch(value: unknown): PreferencePatch {
  if (!isRecord(value)) {
    throw new Error("Invalid preferences patch.");
  }

  const patch: PreferencePatch = {};

  if ("openDefaultPetOnLaunch" in value) {
    if (typeof value.openDefaultPetOnLaunch !== "boolean") throw new Error("Invalid open-on-launch value.");
    patch.openDefaultPetOnLaunch = value.openDefaultPetOnLaunch;
  }

  if ("petPoolEnabled" in value) {
    if (typeof value.petPoolEnabled !== "boolean") throw new Error("Invalid pet-pool-enabled value.");
    patch.petPoolEnabled = value.petPoolEnabled;
  }

  if ("petConfinementEnabled" in value) {
    if (typeof value.petConfinementEnabled !== "boolean") throw new Error("Invalid pet-confinement-enabled value.");
    patch.petConfinementEnabled = value.petConfinementEnabled;
  }

  if ("petGravityEnabled" in value) {
    if (typeof value.petGravityEnabled !== "boolean") throw new Error("Invalid pet-gravity-enabled value.");
    patch.petGravityEnabled = value.petGravityEnabled;
  }

  if ("idleChatWarnEnabled" in value) {
    if (typeof value.idleChatWarnEnabled !== "boolean") throw new Error("Invalid idle-chat-warn-enabled value.");
    patch.idleChatWarnEnabled = value.idleChatWarnEnabled;
  }

  if ("idleChatWarnMinutes" in value) {
    if (typeof value.idleChatWarnMinutes !== "number" || !Number.isFinite(value.idleChatWarnMinutes)) throw new Error("Invalid idle-chat-warn-minutes value.");
    patch.idleChatWarnMinutes = normalizeIdleChatWarnMinutes(value.idleChatWarnMinutes);
  }

  if ("idleChatAutoCompactEnabled" in value) {
    if (typeof value.idleChatAutoCompactEnabled !== "boolean") throw new Error("Invalid idle-chat-auto-compact-enabled value.");
    patch.idleChatAutoCompactEnabled = value.idleChatAutoCompactEnabled;
  }

  if ("petCrossDisplayEnabled" in value) {
    if (typeof value.petCrossDisplayEnabled !== "boolean") throw new Error("Invalid pet-cross-display-enabled value.");
    patch.petCrossDisplayEnabled = value.petCrossDisplayEnabled;
  }

  if ("locale" in value) {
    if (value.locale !== "system" && !isSupportedLocale(value.locale)) throw new Error("Invalid locale value.");
    patch.locale = value.locale as LocalePreference;
  }

  if ("petScale" in value) {
    if (typeof value.petScale !== "number" || !Number.isFinite(value.petScale)) throw new Error("Invalid pet scale value.");
    patch.petScale = normalizePetScale(value.petScale);
  }

  if ("reactionAnimationOverrides" in value) {
    patch.reactionAnimationOverrides = validateReactionAnimationOverrides(value.reactionAnimationOverrides);
  }

  if ("petAssignmentMode" in value) {
    if (value.petAssignmentMode !== "per-session" && value.petAssignmentMode !== "per-project") throw new Error("Invalid pet-assignment-mode value.");
    patch.petAssignmentMode = value.petAssignmentMode;
  }

  if ("notificationPolicy" in value) {
    if (isRecord(value.notificationPolicy)) {
      const validModes = new Set(["persistent", "fade", "off"]);
      const policy: Record<string, "persistent" | "fade" | "off"> = {};
      for (const [key, mode] of Object.entries(value.notificationPolicy)) {
        if (typeof key === "string" && typeof mode === "string" && validModes.has(mode)) {
          policy[key] = mode as "persistent" | "fade" | "off";
        }
      }
      patch.notificationPolicy = policy;
    }
  }

  return patch;
}
