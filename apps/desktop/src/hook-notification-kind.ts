import { t } from "./i18n/index.js";

/**
 * High-value Claude hook events mapped to a distinct notification kind. The
 * hook event name (not the reaction) drives this: a manual `openpets_react`
 * MCP call carries no hookEventName, so it can never masquerade as one of
 * these — only a real Claude hook firing PermissionRequest/Stop/StopFailure
 * produces the "Needs approval" / "Task complete" / "Task failed" wording.
 */
export const hookEventToNotificationKind: Record<string, string> = {
  PermissionRequest: "permission",
  Stop: "complete",
  StopFailure: "error",
};

export function notificationKindForHookEvent(hookEventName: string | undefined): string | undefined {
  return hookEventName ? hookEventToNotificationKind[hookEventName] : undefined;
}

export function hookNotificationMessage(kind: string): string {
  if (kind === "permission") return t("pet.notify.needsApproval");
  if (kind === "complete") return t("pet.notify.taskComplete");
  if (kind === "error") return t("pet.notify.taskFailed");
  return kind;
}
