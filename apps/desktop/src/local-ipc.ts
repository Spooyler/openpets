import { randomBytes } from "node:crypto";
import net from "node:net";

import { Notification, shell, systemPreferences } from "electron";

import { applyAgentPetReaction, applyAgentPetSay, clearAgentPetDismissal, clearAgentPetLeaseState, hideAgentPet, isAgentPetDismissed, isAgentPetHidden, refreshAgentPetBusyBadge, refreshAgentPetNotifications, repositionConfinedPet, scheduleFarewellClose, setAgentPetFocusTargetAccessor, setAgentPetStoreAccessor, setAgentPetUserClosedAccessor, setAgentSessionFocusTargetAccessor, setRevealTabForLease as setAgentRevealTabForLease, showAgentPet, unhideAgentPet } from "./agent-pet-controller.js";
import { classifyAnalyticsError, trackDesktopEvent, trackDesktopIntegrationActivity } from "./analytics.js";
import { forgetProjectPet, getAppStateSnapshot, getRememberedProjectPet, recordOpenPetsActivity, rememberProjectPet } from "./app-state.js";
import { builtInPet } from "./built-in-pet.js";
import { applyExternalPetReaction, applyExternalPetSay, getDefaultPetPaused, isDefaultPetVisible, refreshDefaultPetBusyBadge, refreshDefaultPetNotifications, setDefaultNotificationStoreAccessor, setDefaultPetBubbleDismissedHandler, setDefaultSessionFocusTargetAccessor, setRevealTabForLease, setSessionTerminalFocusResolver } from "./default-pet-controller.js";
import { createStaleLeaseStatus, LeaseManager, type LeaseSnapshot, type PetLease } from "./lease-manager.js";
import { debug, error as logError, info } from "./logger.js";
import { cleanupUnixSocket, getDiscoveryFilePath, getIpcEndpointConfig, parseIpcEndpoint, protectUnixSocket, removeDiscoveryFile, writeDiscoveryFile, type IpcEndpoint, type IpcEndpointConfig, type OpenPetsDiscoveryFile } from "./local-ipc-paths.js";
import { stat } from "node:fs/promises";
import { errorResponse, IpcProtocolError, isRecord, maxIpcMessageBytes, okResponse, parseIpcRequest, validateCwd, validateHookEventName, validateInstallLocalKind, validateInstallLocalPath, validateInstallPetId, validateOptionalLeaseId, validateReaction, validateRequestedPetId, validateSayMessage, validateSessionNonce, type OpenPetsIpcRequest } from "./local-ipc-protocol.js";
import { installPet, installPetFromFolderWithResult, installPetFromZipFileWithResult } from "./pet-installation.js";
import { clearConfinementState, getConfinementState, setConfinementState } from "./confinement-manager.js";
import { isConfinementSupported } from "./capabilities.js";
import { resolveAndSubscribe, type ConfinementPollerDeps } from "./confinement-poller.js";
import { findTerminalWindowForPid, getAncestorPidChain, subscribeActiveWindowTracking, subscribeWindowTracking, type TerminalWindowInfo } from "./window-tracker.js";
import { focusTerminalWindow } from "./terminal-focus.js";
import { parkWaitFocus, pruneWaitFocus, requestTabReveal } from "./vscode-tab-focus.js";
import { warnPetFallback } from "./pet-fallback-notify.js";
import { getEligiblePoolPetIds, resolvePoolAssignment, resolveRandomPoolAssignment } from "./pet-pool.js";
import { t } from "./i18n/index.js";
import { WindowPetRegistry, windowKeyForIdentity } from "./window-pet-registry.js";
import { NotificationStore, sessionLabelFromCwd } from "./notification-store.js";
import { SessionLiveStatusTracker, type LiveStatus } from "./session-live-status.js";
import { SpeechBubbleQueue } from "./speech-bubble-queue.js";

let ipcServer: net.Server | null = null;
let ipcDiscovery: OpenPetsDiscoveryFile | null = null;
let leaseCleanupTimer: NodeJS.Timeout | null = null;
let agentConnectedTracked = false;
const sessionLiveStatus = new SessionLiveStatusTracker();
/** Queues speech bubbles from concurrent hub-mode sessions targeting the default pet, one visible at a time. */
const speechBubbleQueue = new SpeechBubbleQueue({ maxDepth: 5 });

/** Snapshot of per-session activity status for the notification flyout, derived from hook reactions. */
export function getSessionLiveStatuses(): ReadonlyMap<string, LiveStatus> {
  return sessionLiveStatus.all();
}

/**
 * High-value Claude hook events mapped to a distinct notification kind. The
 * hook event name (not the reaction) drives this: a manual `openpets_react`
 * MCP call carries no hookEventName, so it can never masquerade as one of
 * these — only a real Claude hook firing PermissionRequest/Stop/StopFailure
 * produces the "Needs approval" / "Task complete" / "Task failed" wording.
 */
const hookEventToNotificationKind: Record<string, string> = {
  PermissionRequest: "permission",
  Stop: "complete",
  StopFailure: "error",
};

function notificationKindForHookEvent(hookEventName: string | undefined): string | undefined {
  return hookEventName ? hookEventToNotificationKind[hookEventName] : undefined;
}

function hookNotificationMessage(kind: string): string {
  if (kind === "permission") return t("pet.notify.needsApproval");
  if (kind === "complete") return t("pet.notify.taskComplete");
  if (kind === "error") return t("pet.notify.taskFailed");
  return kind;
}

/** Kind + message for a pet.react notification row: hook-mapped events get the
 * high-value wording; everything else keeps the generic per-reaction message. */
function reactionNotification(reaction: import("./local-ipc-protocol.js").OpenPetsReaction, hookEventName: string | undefined): { kind: string; message: string } {
  const mappedKind = notificationKindForHookEvent(hookEventName);
  if (mappedKind) return { kind: mappedKind, message: hookNotificationMessage(mappedKind) };
  return { kind: reaction, message: t(("pet.notify.reaction." + reaction) as import("./i18n/index.js").MessageKey) };
}

interface DisconnectedSession {
  readonly actualPetName: string;
  readonly targetKind: "default" | "explicit";
  readonly terminalAppName?: string;
  readonly cwd?: string;
  readonly clientPid?: number;
  readonly disconnectedAt: number;
  readonly reason: "released" | "expired" | "pid_dead";
}

export interface EnrichedSessionSnapshot extends LeaseSnapshot {
  readonly unresolvedNotifications: number;
  readonly confinementState?: "confined" | "minimized" | "occluded" | "free-roam";
  readonly petVisible: boolean;
  readonly petDismissed: boolean;
  readonly canFocus: boolean;
  readonly healthPct: number;
  /** The pet actually displayed for this session (may differ from lease target when pool-assigned). */
  readonly displayPetId?: string;
  readonly displayPetName?: string;
  readonly displayPetOrigin?: "explicit" | "pool";
  readonly windowKey?: string;
}

const recentlyDisconnected: DisconnectedSession[] = [];
const maxDisconnectedHistory = 10;

/** Sessions blocked from re-acquiring after UI disconnect. Keyed by sessionNonce → clientPid. */
const blockedSessions = new Map<string, number>();

function isSessionBlocked(sessionNonce: string | undefined, clientPid: number | undefined): boolean {
  if (!sessionNonce || !blockedSessions.has(sessionNonce)) return false;
  const blockedPid = blockedSessions.get(sessionNonce)!;
  if (clientPid !== undefined && clientPid !== blockedPid) {
    blockedSessions.delete(sessionNonce);
    return false;
  }
  try {
    process.kill(blockedPid, 0);
  } catch {
    blockedSessions.delete(sessionNonce);
    return false;
  }
  return true;
}

function recordDisconnection(lease: PetLease, reason: DisconnectedSession["reason"]): void {
  const petName = lease.targetKind === "default"
    ? getCurrentDefaultPet().displayName
    : getPetDisplayName(lease.actualPetId);
  recentlyDisconnected.unshift({
    actualPetName: petName,
    targetKind: lease.targetKind,
    terminalAppName: lease.terminalAppName,
    cwd: lease.cwd,
    clientPid: lease.clientPid,
    disconnectedAt: Date.now(),
    reason,
  });
  if (recentlyDisconnected.length > maxDisconnectedHistory) {
    recentlyDisconnected.length = maxDisconnectedHistory;
  }
}

function recordDisconnectionFromSnapshot(s: LeaseSnapshot, reason: DisconnectedSession["reason"]): void {
  recentlyDisconnected.unshift({
    actualPetName: s.actualTargetPetName,
    targetKind: s.targetKind,
    terminalAppName: s.terminalAppName,
    cwd: s.cwd,
    clientPid: s.clientPid,
    disconnectedAt: Date.now(),
    reason,
  });
  if (recentlyDisconnected.length > maxDisconnectedHistory) {
    recentlyDisconnected.length = maxDisconnectedHistory;
  }
}
/** leaseId → window-tracking unsubscribe function (for confined agent pets). */
const confinementUnsubscribers = new Map<string, () => void>();
const leaseManager = new LeaseManager({
  resolveTarget: resolveLeaseTarget,
  getDefaultPetId: () => getCurrentDefaultPet().id,
  getPetDisplayName: (petId, targetKind) => targetKind === "default" ? getCurrentDefaultPet().displayName : getPetDisplayName(petId),
  onLog: (level, message, fields) => level === "debug" ? debug("lease", message, fields) : info("lease", message, fields),
  isPetEligible,
  // heartbeat()/get() release a stale lease internally when it's already past
  // expiry (e.g. after laptop sleep), ahead of the next 5s cleanup tick. Notify
  // the registry the same way the cleanup pass does so the pet binding doesn't
  // leak until the tick catches up.
  onExpired: (lease) => {
    recordDisconnection(lease, "expired");
    notifyLeaseGone(lease, sessionKeyForLease(lease));
  },
});

// Pet lifecycle is driven by window→pet bindings, not lease counts: the registry
// decides when to spawn/close/rebind pets as sessions resolve their terminal
// identity. Side effects run through injected callbacks (agent-pet-controller /
// confinement); pool assignment happens here per-window at identity-resolve time.
const windowPetRegistry = new WindowPetRegistry({
  callbacks: {
    spawnPet: (_windowKey, petId) => { clearAgentPetDismissal(petId); showAgentPet(petId); },
    closePet: (_windowKey, petId, reason) => {
      // Session ended but its window is still alive: say goodbye and close after
      // a short grace period instead of tearing the pet down immediately. Every
      // other close reason (window closed, user dismissed, rebind, pool disabled)
      // still tears down right away.
      if (reason === "session-ended") {
        scheduleFarewellClose(petId);
        return;
      }
      clearAgentPetLeaseState(petId);
      clearConfinementState(petId);
    },
    rebindPet: (_windowKey, fromPetId, toPetId) => {
      clearAgentPetLeaseState(fromPetId);
      clearConfinementState(fromPetId);
      clearAgentPetDismissal(toPetId);
      showAgentPet(toPetId);
    },
    sessionEndedNotice: (label, petId, windowKey) => {
      windowPetRegistry.defaultStore.record({ sessionKey: `ended:${petId}:${Date.now()}`, windowKey, kind: "message", message: t("pet.notify.sessionEnded", { label }), label });
      refreshDefaultPetNotifications();
    },
  },
  drawPoolPet: (occupied) => {
    const state = getAppStateSnapshot();
    const eligible = getEligiblePoolPetIds(state.pets.installed, builtInPet.id, getCurrentDefaultPet().id);
    const orderedPool = state.preferences.petPoolOrder ?? [];
    const countActiveExplicit = (petId: string) => (occupied.has(petId) ? 1 : 0);
    const input = { orderedPool, eligiblePetIds: eligible, countActiveExplicit };
    const result = state.preferences.petSelectionStrategy === "random"
      ? resolveRandomPoolAssignment(input)
      : resolvePoolAssignment(input);
    return result?.petId ?? null;
  },
  resolveRememberedPet: (cwd, occupied) => {
    const remembered = getRememberedProjectPet(cwd);
    if (!remembered) return null;
    const state = getAppStateSnapshot();
    const eligible = getEligiblePoolPetIds(state.pets.installed, builtInPet.id, getCurrentDefaultPet().id);
    if (!eligible.includes(remembered)) {
      // Stale entry (uninstalled / broken / became default) — prune on read.
      if (cwd) forgetProjectPet(cwd);
      return null;
    }
    if (occupied.has(remembered)) return null; // non-stealing: first window won
    return remembered;
  },
  onPoolPetDrawn: (cwd, petId) => {
    if (cwd) rememberProjectPet(cwd, petId);
  },
  storeFactory: () => new NotificationStore({
    policy: (kind) => getAppStateSnapshot().preferences.notificationPolicy?.[kind] ?? "persistent",
  }),
});

export function getWindowPetRegistry(): WindowPetRegistry {
  return windowPetRegistry;
}

// The default pet focuses the terminal of the session that most recently
// interacted with it (say/react), falling back to the freshest heartbeat.
setSessionTerminalFocusResolver(() => {
  const target = windowPetRegistry.focusTargetForDefault();
  if (target) return target;
  // Legacy fallback: lease manager's focusable default lease (pre-registry path).
  const lease = leaseManager.getFocusableDefaultLease();
  if (!lease?.terminalOwnerPid) return null;
  return { terminalOwnerPid: lease.terminalOwnerPid, terminalWindowId: lease.terminalWindowId, leaseId: lease.leaseId };
});
setDefaultNotificationStoreAccessor(() => windowPetRegistry.defaultStore);
setAgentPetStoreAccessor((petId) => windowPetRegistry.storeForPet(petId));
setAgentPetFocusTargetAccessor((petId) => windowPetRegistry.focusTargetForPet(petId));
// Row-level focus: target the clicked session's own window, not the pet's
// aggregate target — a pet's coverage can span multiple terminal windows.
setAgentSessionFocusTargetAccessor((sessionKey) => windowPetRegistry.sessionFocusTarget(sessionKey));
setDefaultSessionFocusTargetAccessor((sessionKey) => windowPetRegistry.sessionFocusTarget(sessionKey));
// Advance the speech bubble queue once the currently displayed bubble auto-dismisses.
setDefaultPetBubbleDismissedHandler((sessionKey) => {
  const next = speechBubbleQueue.dismiss(sessionKey);
  if (next) applyExternalPetSay(`${next.label}: ${next.message}`, undefined, next.sessionKey);
});
setRevealTabForLease(revealTabForLease);
setAgentRevealTabForLease(revealTabForLease);
// Menu "Close pet": route through the registry so the window's sessions drop
// onto the default pet's flyout, same as any other registry-driven close.
// Returns false for pets with no registry binding (e.g. plugin-spawned pets),
// so the caller falls back to the legacy lease-based dismissal.
setAgentPetUserClosedAccessor((petId) => {
  const windowKey = windowPetRegistry.windowForPet(petId);
  if (windowKey === null) return false;
  windowPetRegistry.onUserClosedPet(windowKey);
  return true;
});

/** Tracks requestedPetIds for which we have already shown a fallback warning notification. */
const warnedFallbackPets = new Set<string>();

/** sessionKey → petIds whose project-memory write already happened. Guards
 *  lease re-acquires (which re-send the same --pet) from overwriting a newer
 *  assignment; a NEW pet for the same session (adopt/UI) still writes. */
const projectMemoryWrites = new Map<string, Set<string>>();

function recordProjectMemoryOnce(sessionKey: string | null, cwd: string | undefined, petId: string): void {
  if (!sessionKey || !cwd) return;
  let seen = projectMemoryWrites.get(sessionKey);
  if (!seen) {
    seen = new Set();
    projectMemoryWrites.set(sessionKey, seen);
  }
  if (seen.has(petId)) return;
  seen.add(petId);
  rememberProjectPet(cwd, petId);
}

const safePetIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export async function startLocalIpcServer(): Promise<void> {
  if (ipcServer) {
    debug("ipc", "start skipped", { reason: "already-started" });
    return;
  }

  const endpointConfig = getIpcEndpointConfig();
  const token = randomBytes(32).toString("base64url");
  cleanupUnixSocket(endpointConfig.advertisedEndpoint);

  const server = net.createServer((socket) => handleSocket(socket, token, endpointConfig));

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      listenOnEndpoint(server, endpointConfig.bindEndpoint, () => {
        server.off("error", reject);
        protectUnixSocket(endpointConfig.advertisedEndpoint);
        resolve();
      });
    });
  } catch (error) {
    trackDesktopEvent("desktop_ipc_server_failed", { error_code: classifyAnalyticsError(error, "ipc_listen_failed"), endpoint_kind: endpointConfig.bindEndpoint.kind });
    throw error;
  }
  server.on("error", (error) => {
    trackDesktopEvent("desktop_ipc_server_failed", { error_code: classifyAnalyticsError(error, "ipc_server_error"), endpoint_kind: endpointConfig.bindEndpoint.kind });
    logError("ipc", "server error", error);
    console.error("OpenPets local IPC server error.", error);
  });

  ipcServer = server;
  const listeningEndpoint = getListeningEndpoint(server, endpointConfig);
  ipcDiscovery = writeDiscoveryFile(listeningEndpoint, token);
  leaseCleanupTimer = setInterval(() => {
    // Capture leaseId→sessionKey BEFORE the cleanup passes release the leases —
    // once released, a lease's raw record (and its sessionNonce) is gone, so the
    // returned snapshots can no longer be turned into a registry sessionKey.
    const sessionKeys = captureSessionKeysByLeaseId();
    const expiredSnapshots = leaseManager.cleanupExpired();
    for (const s of expiredSnapshots) recordDisconnectionFromSnapshot(s, "expired");
    cleanupReleasedLeases(expiredSnapshots, sessionKeys);
    const pidDeadSnapshots = leaseManager.checkPidLiveness();
    for (const s of pidDeadSnapshots) recordDisconnectionFromSnapshot(s, "pid_dead");
    cleanupReleasedLeases(pidDeadSnapshots, sessionKeys);
  }, 5_000);
  leaseCleanupTimer.unref?.();

  // Auto-resolve: when the user focuses a terminal window, resolve any
  // unresolved notification rows keyed to that window and refresh the view.
  subscribeActiveWindowTracking((win) => {
    if (!win) return;
    for (const petId of windowPetRegistry.resolveWindowFocusByPid(win.ownerPid)) refreshAgentPetNotifications(petId);
    refreshDefaultPetNotifications();
  });

  info("ipc", "server started", { endpointKind: endpointConfig.bindEndpoint.kind, bindEndpoint: formatEndpoint(endpointConfig.bindEndpoint), advertisedEndpoint: listeningEndpoint, discoveryPath: getDiscoveryFilePath() });
  console.log(`OpenPets local IPC listening at ${listeningEndpoint}.`);
}

export function stopLocalIpcServer(): void {
  const server = ipcServer;
  const discovery = ipcDiscovery;
  ipcServer = null;
  ipcDiscovery = null;
  info("ipc", "server stopping", { hadServer: Boolean(server), discoveryPath: discovery ? getDiscoveryFilePath() : undefined, endpoint: discovery?.endpoint });
  if (leaseCleanupTimer) clearInterval(leaseCleanupTimer);
  leaseCleanupTimer = null;
  removeDiscoveryFile(discovery);

  if (server) {
    server.close();
  }

  if (discovery) {
    cleanupUnixSocket(discovery.endpoint);
  }
}

/**
 * Handle petPoolEnabled toggle: despawn all active pool pets on disable,
 * respawn pets for still-alive sessions' windows on re-enable.
 * Pool lifecycle now lives in the window registry, keyed by window.
 * Must be called AFTER the preference has been updated in app state.
 */
export function dispatchPoolToggle(enabled: boolean): void {
  if (enabled) windowPetRegistry.onPoolEnabled();
  else windowPetRegistry.onPoolDisabled();
}

function handleSocket(socket: net.Socket, token: string, endpointConfig: IpcEndpointConfig): void {
  const bindEndpoint = endpointConfig.bindEndpoint;
  if (bindEndpoint.kind === "tcp" && !isAllowedRemoteAddress(socket.remoteAddress, bindEndpoint.host)) {
    info("ipc", "socket rejected", { reason: "unauthorized-remote", remoteAddress: socket.remoteAddress, bindHost: bindEndpoint.host });
    socket.destroy();
    return;
  }

  debug("ipc", "socket accepted", { endpointKind: bindEndpoint.kind, remoteAddress: socket.remoteAddress });

  socket.setEncoding("utf8");
  socket.setTimeout(3_000, () => socket.destroy());

  let buffer = "";
  let handled = false;

  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk;

    if (Buffer.byteLength(buffer, "utf8") > maxIpcMessageBytes) {
      handled = true;
      info("ipc", "request rejected", { reason: "too-large", bytes: Buffer.byteLength(buffer, "utf8") });
      writeResponse(socket, errorResponse(null, new IpcProtocolError("invalid_request", "IPC request is too large.")));
      return;
    }

    const newline = buffer.indexOf("\n");
    if (newline === -1) return;

    handled = true;
    const raw = buffer.slice(0, newline);
    void dispatchRawRequest(raw, token, socket);
  });

  socket.on("error", (error) => {
    if (isBenignSocketCloseError(error)) return;
    logError("ipc", "client socket error", error);
    console.error("OpenPets local IPC client socket error.", error);
  });
}

function listenOnEndpoint(server: net.Server, endpoint: IpcEndpoint, callback: () => void): void {
  if (endpoint.kind === "tcp") {
    server.listen({ host: endpoint.host, port: endpoint.port }, callback);
    return;
  }

  server.listen(endpoint.path, callback);
}

function getListeningEndpoint(server: net.Server, endpointConfig: IpcEndpointConfig): string {
  const bindEndpoint = endpointConfig.bindEndpoint;
  if (bindEndpoint.kind !== "tcp") return bindEndpoint.path;

  const address = server.address();
  const actualPort = (!address || typeof address === "string") ? bindEndpoint.port : address.port;

  // Use the advertised endpoint if it's different from bind endpoint
  const advertisedParsed = parseIpcEndpoint(endpointConfig.advertisedEndpoint, { allowPortZero: true, allowNonLoopback: true });
  if (advertisedParsed.kind === "tcp" && advertisedParsed.host !== bindEndpoint.host) {
    // Use advertised host with actual port (in case bind used port 0)
    return `tcp://${advertisedParsed.host}:${actualPort}`;
  }

  return `tcp://${bindEndpoint.host}:${actualPort}`;
}

function formatEndpoint(endpoint: IpcEndpoint): string {
  if (endpoint.kind === "tcp") return `tcp://${endpoint.host}:${endpoint.port}`;
  return endpoint.path;
}

function isAllowedRemoteAddress(address: string | undefined, bindHost: string): boolean {
  if (!address) return false;

  // Always allow loopback
  if (address === "::1" || isLoopbackAddress(address)) {
    return true;
  }

  // If binding to 0.0.0.0 or non-loopback, allow private/local addresses
  if (bindHost === "0.0.0.0" || bindHost !== "127.0.0.1") {
    return isPrivateOrLocalAddress(address);
  }

  return false;
}

function isLoopbackAddress(address: string): boolean {
  if (address.startsWith("::ffff:")) {
    address = address.slice(7);
  }

  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts[0] === 127 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function isPrivateOrLocalAddress(address: string): boolean {
  // Handle IPv4-mapped IPv6 addresses
  if (address.startsWith("::ffff:")) {
    address = address.slice(7);
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;

  // Loopback: 127.0.0.0/8
  if (parts[0] === 127) return true;

  // Private: 10.0.0.0/8
  if (parts[0] === 10) return true;

  // Private: 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // Private: 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;

  // Link-local: 169.254.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}

async function handleRawRequest(raw: string, token: string) {
  let requestId: string | null = null;
  try {
    const request = parseIpcRequest(raw, token);
    requestId = request.id;
    trackAgentConnected(request.method);
    debug("ipc", "request received", { requestId, method: request.method });
    return okResponse(request.id, await handleRequest(request));
  } catch (error) {
    logError("ipc", "request failed", error instanceof Error ? error : { requestId, error });
    return errorResponse(requestId, error);
  }
}

async function dispatchRawRequest(raw: string, token: string, socket: net.Socket): Promise<void> {
  // vscode.wait-focus long-poll: authenticate + park instead of answering.
  let parsedForPark: OpenPetsIpcRequest | null = null;
  try {
    parsedForPark = parseIpcRequest(raw, token);
  } catch {
    parsedForPark = null; // fall through to normal path for uniform error responses
  }

  if (parsedForPark?.method === "vscode.wait-focus") {
    const request = parsedForPark;
    trackAgentConnected(request.method);
    socket.setTimeout(0); // lift the 3s idle destroy — this socket waits by design
    const park = parkWaitFocus({
      requestId: request.id,
      respond: (payload) => writeResponse(socket, okResponse(request.id, payload)),
    });
    if (!park.accepted) {
      writeResponse(socket, okResponse(request.id, { command: null, retryAfterMs: park.retryAfterMs }));
      return;
    }
    socket.once("close", () => pruneWaitFocus(request.id));
    debug("ipc", "wait-focus parked", { requestId: request.id });
    return;
  }

  const response = await handleRawRequest(raw, token);
  writeResponse(socket, response);
}

async function handleRequest(request: OpenPetsIpcRequest): Promise<unknown> {
  if (request.method === "hello") {
    return {
      ok: true,
      protocol: "openpets-ipc",
      protocolVersion: 1,
      appVersion: ipcDiscovery?.appVersion ?? "0.0.0",
    };
  }

  if (request.method === "status") {
    const params = isRecord(request.params) ? request.params : {};
    const leaseId = validateOptionalLeaseId(params.leaseId);
    if (leaseId) {
      const lease = leaseManager.get(leaseId);
      if (!lease) return createStaleLeaseStatus(leaseId);
      return { ok: true, appRunning: true, ...lease };
    }
    const state = getAppStateSnapshot();
    const defaultPet = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId) ?? builtInPet;
    return {
      ok: true,
      appRunning: true,
      protocolVersion: 1,
      appVersion: ipcDiscovery?.appVersion ?? "0.0.0",
      defaultPet: {
        id: defaultPet.id,
        displayName: defaultPet.displayName,
        builtIn: defaultPet.builtIn,
        broken: "broken" in defaultPet && defaultPet.broken === true,
      },
      paused: getDefaultPetPaused(),
      defaultPetVisible: isDefaultPetVisible(),
      openDefaultPetOnLaunch: state.preferences.openDefaultPetOnLaunch,
      speechBubblesEnabled: state.preferences.speechBubblesEnabled,
    };
  }

  if (request.method === "pets.list") {
    const state = getAppStateSnapshot();
    return {
      ok: true,
      pets: state.pets.installed.map((pet) => ({
        id: pet.id,
        displayName: pet.displayName,
        builtIn: pet.builtIn,
        broken: pet.broken === true,
      })),
      defaultPetId: state.preferences.defaultPetId,
    };
  }

  if (request.method === "pets.install") {
    const params = isRecord(request.params) ? request.params : {};
    const petId = validateInstallPetId(params.petId);
    trackDesktopEvent("desktop_pet_install_started", { source: "catalog", entrypoint: "ipc" });
    let state;
    try {
      state = await installPet(petId);
      trackDesktopEvent("desktop_pet_install_completed", { source: "catalog", entrypoint: "ipc" });
    } catch (error) {
      trackDesktopEvent("desktop_pet_install_failed", { source: "catalog", entrypoint: "ipc", error_code: classifyAnalyticsError(error, "pet_install_failed") });
      throw error;
    }
    const installed = state.pets.installed.find((pet) => pet.id === petId);
    if (!installed) throw new IpcProtocolError("install_failed", "Pet install did not complete.");
    return { ok: true, petId: installed.id, displayName: installed.displayName, installed: true };
  }

  if (request.method === "pets.install-local") {
    const params = isRecord(request.params) ? request.params : {};
    const localPath = validateInstallLocalPath(params.path);
    const kind = validateInstallLocalKind(params.kind);
    trackDesktopEvent("desktop_pet_install_started", { source: "local", entrypoint: "ipc" });
    try {
      const stats = await stat(localPath);
      let installResult;
      if (kind === "folder") {
        if (!stats.isDirectory()) throw new IpcProtocolError("invalid_params", "Local pet path must be a folder.");
        installResult = await installPetFromFolderWithResult(localPath);
      } else {
        if (!stats.isFile()) throw new IpcProtocolError("invalid_params", "Local pet path must be a zip file.");
        installResult = await installPetFromZipFileWithResult(localPath);
      }
      trackDesktopEvent("desktop_pet_install_completed", { source: "local", entrypoint: "ipc" });
      const installedPet = installResult.state.pets.installed.find((pet) => pet.id === installResult.petId);
      if (!installedPet) throw new IpcProtocolError("install_failed", "Local pet install did not complete.");
      return { ok: true, petId: installedPet.id, displayName: installedPet.displayName, installed: true };
    } catch (error) {
      trackDesktopEvent("desktop_pet_install_failed", { source: "local", entrypoint: "ipc", error_code: classifyAnalyticsError(error, "pet_install_failed") });
      throw error;
    }
  }

  if (request.method === "lease.acquire") {
    const params = isRecord(request.params) ? request.params : {};
    const requestedPetId = validateRequestedPetId(params.requestedPetId);
    const clientPid = typeof params.clientPid === "number" && params.clientPid > 0 ? params.clientPid : undefined;
    const sessionNonce = validateSessionNonce(params.sessionNonce);
    const cwd = validateCwd(params.cwd);
    debug("ipc", "lease acquire requested", { requestId: request.id, requestedPetId, clientPid, sessionNonce });
    if (isSessionBlocked(sessionNonce, clientPid)) {
      debug("ipc", "lease acquire rejected — session blocked", { requestId: request.id, sessionNonce, clientPid });
      throw new IpcProtocolError("session_blocked", "Session was disconnected from the UI.");
    }
    const lease = leaseManager.acquire(requestedPetId, clientPid, sessionNonce, cwd);
    // Project memory: an explicitly-called pet is remembered for this project;
    // an explicit return-to-default forgets it (spec: tri-state requestedPetId).
    if (requestedPetId === null && cwd) forgetProjectPet(cwd);
    if (lease.targetKind === "explicit" && cwd) {
      recordProjectMemoryOnce(
        clientPid !== undefined && sessionNonce !== undefined ? `${clientPid}:${sessionNonce}` : null,
        cwd,
        lease.actualTargetPetId,
      );
    }
    // Spawning now happens when the session's terminal identity resolves (via
    // the registry). Identity can lag a beat, so give an explicit lease a 3s
    // grace: if no window has bound its pet by then and the lease is still live,
    // surface it anyway so it is visible before identity lands. The later
    // onSessionIdentified spawn is then a no-op (the registry returns the current
    // pet and the existing window is reused).
    if (lease.targetKind === "explicit") {
      const gracePetId = lease.actualTargetPetId;
      const graceLeaseId = lease.leaseId;
      const graceTimer = setTimeout(() => {
        if (windowPetRegistry.windowForPet(gracePetId) === null && leaseManager.get(graceLeaseId)) {
          clearAgentPetDismissal(gracePetId);
          showAgentPet(gracePetId);
        }
      }, 3_000);
      graceTimer.unref?.();
    }
    trackDesktopEvent("desktop_lease_acquired", { requested_pet: requestedPetId ? "explicit" : "default", target_kind: lease.targetKind, fallback_reason: lease.fallbackReason });
    warnPetFallback(requestedPetId ?? undefined, lease.fallbackReason, warnedFallbackPets);
    // Resolve terminal window identity asynchronously (non-blocking).
    // Only attempt on macOS where window-bounds polling is supported.
    if (clientPid !== undefined && isConfinementSupported()) {
      void resolveTerminalIdentity(lease.leaseId, clientPid);
    }
    return lease;
  }

  if (request.method === "lease.heartbeat") {
    const params = isRecord(request.params) ? request.params : {};
    const leaseId = validateRequiredLeaseId(params.leaseId);
    debug("ipc", "lease heartbeat requested", { requestId: request.id, leaseId });
    try {
      return leaseManager.heartbeat(leaseId);
    } catch {
      throw new IpcProtocolError("unknown_lease", "Unknown or expired lease.");
    }
  }

  if (request.method === "lease.release") {
    const params = isRecord(request.params) ? request.params : {};
    const leaseId = validateRequiredLeaseId(params.leaseId);
    debug("ipc", "lease release requested", { requestId: request.id, leaseId });
    const rawLease = leaseManager.getRawLease(leaseId);
    if (rawLease) recordDisconnection(rawLease, "released");
    if (rawLease?.targetKind === "explicit") {
      return releaseExplicitLease(leaseId);
    }
    const sessionKey = rawLease ? sessionKeyForLease(rawLease) : null;
    const result = leaseManager.release(leaseId);
    if (sessionKey) {
      if (!sessionHasOtherLiveLease(sessionKey, leaseId)) projectMemoryWrites.delete(sessionKey);
      windowPetRegistry.onSessionGone(sessionKey);
      sessionLiveStatus.remove(sessionKey);
    }
    return result;
  }

  if (request.method === "agent.activity") {
    const params = isRecord(request.params) ? request.params : {};
    const lease = getLeaseTarget(params.leaseId);
    debug("ipc", "agent activity ping", { requestId: request.id, leaseId: lease?.leaseId, targetKind: lease?.targetKind });
    if (lease?.targetKind === "explicit") {
      return { ok: true, refreshed: refreshAgentPetBusyBadge(lease.actualTargetPetId), leaseId: lease.leaseId };
    }
    return { ok: true, refreshed: refreshDefaultPetBusyBadge() };
  }

  if (request.method === "pet.react") {
    const params = isRecord(request.params) ? request.params : {};
    const reaction = validateReaction(params.reaction);
    const hookEventName = validateHookEventName(params.hookEventName);
    const lease = getLeaseTarget(params.leaseId);
    if (lease) leaseManager.touchActivity(lease.leaseId);
    const rawLease = lease ? leaseManager.getRawLease(lease.leaseId) : null;
    const petId = lease?.actualTargetPetId ?? getCurrentDefaultPet().id;
    debug("ipc", "pet react requested", { requestId: request.id, reaction, hookEventName, leaseId: lease?.leaseId, targetKind: lease?.targetKind, actualPetId: lease?.actualTargetPetId });
    if (lease?.targetKind === "explicit") {
      const rawSessionKey = rawLease ? sessionKeyForLease(rawLease) : null;
      if (rawSessionKey) sessionLiveStatus.update(rawSessionKey, reaction);
      const { kind, message } = reactionNotification(reaction, hookEventName);
      recordSessionNotification(rawLease, kind, message);
      const displayPet = displayPetForLease(rawLease);
      const applied = displayPet ? applyAgentPetReaction(displayPet, reaction) : applyExternalPetReaction(reaction);
      if (!displayPet) enqueueUrgentDefaultBubble(rawLease, kind, reaction);
      safeRecordOpenPetsActivity({ kind: "react", reaction, petId: displayPet ?? petId, surface: displayPet ? "agent" : "default" });
      trackDesktopIntegrationActivity("react", { integration_type: "ipc", target_kind: lease.targetKind, shown: applied.shown, reason: applied.reason });
      return { ok: true, reaction, shown: applied.shown, reason: applied.reason, leaseId: lease.leaseId };
    }
    const sessionPet = await resolveSessionPetTarget(lease, params);
    if (sessionPet) {
      leaseManager.touchActivity(sessionPet.leaseId);
      const sessionPetKey = sessionKeyForLease(sessionPet);
      if (sessionPetKey) sessionLiveStatus.update(sessionPetKey, reaction);
      const { kind: sessionKind, message: sessionMessage } = reactionNotification(reaction, hookEventName);
      recordSessionNotification(sessionPet, sessionKind, sessionMessage);
      const displayPet = displayPetForLease(sessionPet);
      debug("ipc", "react routed to session pet", { requestId: request.id, petId: sessionPet.actualPetId, sessionLeaseId: sessionPet.leaseId });
      const applied = displayPet ? applyAgentPetReaction(displayPet, reaction) : applyExternalPetReaction(reaction);
      if (!displayPet) enqueueUrgentDefaultBubble(sessionPet, sessionKind, reaction);
      safeRecordOpenPetsActivity({ kind: "react", reaction, petId: displayPet ?? sessionPet.actualPetId, surface: displayPet ? "agent" : "default" });
      trackDesktopIntegrationActivity("react", { integration_type: "ipc", target_kind: "session-routed", shown: applied.shown, reason: applied.reason });
      return { ok: true, reaction, shown: applied.shown, reason: applied.reason };
    }
    const defaultSessionKey = rawLease ? sessionKeyForLease(rawLease) : null;
    if (defaultSessionKey) sessionLiveStatus.update(defaultSessionKey, reaction);
    const { kind: defaultKind, message: defaultMessage } = reactionNotification(reaction, hookEventName);
    recordSessionNotification(rawLease, defaultKind, defaultMessage);
    const displayPet = displayPetForLease(rawLease);
    const applied = displayPet ? applyAgentPetReaction(displayPet, reaction) : applyExternalPetReaction(reaction);
    if (!displayPet) enqueueUrgentDefaultBubble(rawLease, defaultKind, reaction);
    safeRecordOpenPetsActivity({ kind: "react", reaction, petId: displayPet ?? petId, surface: displayPet ? "agent" : "default" });
    trackDesktopIntegrationActivity("react", { integration_type: "ipc", target_kind: lease?.targetKind ?? "default", shown: applied.shown, reason: applied.reason });
    return { ok: true, reaction, shown: applied.shown, reason: applied.reason };
  }

  const params = isRecord(request.params) ? request.params : {};
  const message = validateSayMessage(params.message);
  const reaction = params.reaction === undefined ? undefined : validateReaction(params.reaction);
  const lease = getLeaseTarget(params.leaseId);
  if (lease) leaseManager.touchActivity(lease.leaseId);
  const rawLease = lease ? leaseManager.getRawLease(lease.leaseId) : null;
  const petId = lease?.actualTargetPetId ?? getCurrentDefaultPet().id;
  debug("ipc", "pet say requested", { requestId: request.id, reaction, messageLength: message.length, leaseId: lease?.leaseId, targetKind: lease?.targetKind, actualPetId: lease?.actualTargetPetId });
  if (lease?.targetKind === "explicit") {
    recordSessionNotification(rawLease, reaction ?? "message", message);
    const displayPet = displayPetForLease(rawLease);
    const applied = displayPet ? applyAgentPetSay(displayPet, message, reaction) : sayToDefaultPet(rawLease, message, reaction);
    safeRecordOpenPetsActivity({ kind: "say", reaction, petId: displayPet ?? petId, surface: displayPet ? "agent" : "default" });
    trackDesktopIntegrationActivity("say", { integration_type: "ipc", target_kind: lease.targetKind, shown: applied.shown, reason: applied.reason, has_reaction: Boolean(reaction) });
    return { ok: true, shown: applied.shown, reason: applied.reason, reaction, leaseId: lease.leaseId };
  }
  const sessionPet = await resolveSessionPetTarget(lease, params);
  if (sessionPet) {
    leaseManager.touchActivity(sessionPet.leaseId);
    recordSessionNotification(sessionPet, reaction ?? "message", message);
    const displayPet = displayPetForLease(sessionPet);
    debug("ipc", "say routed to session pet", { requestId: request.id, petId: sessionPet.actualPetId, sessionLeaseId: sessionPet.leaseId });
    const applied = displayPet ? applyAgentPetSay(displayPet, message, reaction) : sayToDefaultPet(sessionPet, message, reaction);
    safeRecordOpenPetsActivity({ kind: "say", reaction, petId: displayPet ?? sessionPet.actualPetId, surface: displayPet ? "agent" : "default" });
    trackDesktopIntegrationActivity("say", { integration_type: "ipc", target_kind: "session-routed", shown: applied.shown, reason: applied.reason, has_reaction: Boolean(reaction) });
    return { ok: true, shown: applied.shown, reason: applied.reason, reaction };
  }
  recordSessionNotification(rawLease, reaction ?? "message", message);
  const displayPet = displayPetForLease(rawLease);
  const applied = displayPet ? applyAgentPetSay(displayPet, message, reaction) : sayToDefaultPet(rawLease, message, reaction);
  safeRecordOpenPetsActivity({ kind: "say", reaction, petId: displayPet ?? petId, surface: displayPet ? "agent" : "default" });
  trackDesktopIntegrationActivity("say", { integration_type: "ipc", target_kind: lease?.targetKind ?? "default", shown: applied.shown, reason: applied.reason, has_reaction: Boolean(reaction) });
  return { ok: true, shown: applied.shown, reason: applied.reason, reaction };
}

function trackAgentConnected(method: string): void {
  if (agentConnectedTracked) return;
  agentConnectedTracked = true;
  trackDesktopEvent("desktop_agent_connected", { method });
}

function safeRecordOpenPetsActivity(activity: Parameters<typeof recordOpenPetsActivity>[0]): void {
  try {
    recordOpenPetsActivity(activity);
  } catch (error) {
    debug("ipc", "activity record failed", { error: error instanceof Error ? error.message : String(error), kind: activity.kind, reaction: activity.reaction, petId: activity.petId });
  }
}

function validateRequiredLeaseId(value: unknown): string {
  const leaseId = validateOptionalLeaseId(value);
  if (!leaseId) throw new IpcProtocolError("invalid_params", "Lease id is required.");
  return leaseId;
}

function getLeaseTarget(value: unknown) {
  const leaseId = validateOptionalLeaseId(value);
  if (!leaseId) return null;
  const lease = leaseManager.get(leaseId);
  if (!lease) throw new IpcProtocolError("unknown_lease", "Unknown or expired lease.");
  return lease;
}

/** `${clientPid}:${sessionNonce}` for a lease, or null when either is missing. */
export function sessionKeyForLease(lease: PetLease): string | null {
  return lease.clientPid && lease.sessionNonce ? `${lease.clientPid}:${lease.sessionNonce}` : null;
}

/**
 * Routes a say targeting the default pet through the speech bubble queue, so
 * concurrent hub-mode sessions get session-labeled, queued bubbles instead of
 * clobbering each other's message. Anonymous callers (no session key) bypass
 * the queue entirely, same as before.
 */
function sayToDefaultPet(lease: PetLease | null | undefined, message: string, reaction: import("./local-ipc-protocol.js").OpenPetsReaction | undefined): { readonly shown: boolean; readonly reason?: string } {
  const sessionKey = lease ? sessionKeyForLease(lease) : null;
  if (!sessionKey) return applyExternalPetSay(message, reaction);
  const label = sessionLabelFromCwd(lease?.cwd, lease?.terminalAppName ?? "session");
  const shown = speechBubbleQueue.enqueue(sessionKey, label, message);
  if (!shown) return { shown: false, reason: "queued" };
  return applyExternalPetSay(`${shown.label}: ${shown.message}`, reaction, shown.sessionKey);
}

/**
 * For hook-mapped urgent reactions (needs-approval / task-failed) targeting
 * the default pet, enqueues a session-labeled speech bubble alongside the
 * reaction badge that applyExternalPetReaction already set.
 */
function enqueueUrgentDefaultBubble(lease: PetLease | null | undefined, kind: string, reaction: import("./local-ipc-protocol.js").OpenPetsReaction): void {
  if (kind !== "permission" && kind !== "error") return;
  const sessionKey = lease ? sessionKeyForLease(lease) : null;
  if (!sessionKey) return;
  const label = sessionLabelFromCwd(lease?.cwd, lease?.terminalAppName ?? "session");
  const shown = speechBubbleQueue.enqueue(sessionKey, label, hookNotificationMessage(kind));
  if (shown) applyExternalPetSay(`${shown.label}: ${shown.message}`, reaction, shown.sessionKey);
}

/**
 * True when a live lease OTHER than excludeLeaseId still resolves to sessionKey —
 * the session continues under a different lease (e.g. an adopt lease swap, where
 * a new lease is acquired for the same clientPid:sessionNonce before the old one
 * is released). Callers must not clear the projectMemoryWrites guard for that
 * sessionKey in this case: the guard exists to stop a re-acquire on the
 * surviving lease from re-sending the session's original --pet and clobbering a
 * newer project-memory write.
 */
function sessionHasOtherLiveLease(sessionKey: string, excludeLeaseId: string): boolean {
  for (const lease of leaseManager.getAllRawLeases()) {
    if (lease.leaseId !== excludeLeaseId && sessionKeyForLease(lease) === sessionKey) return true;
  }
  return false;
}

/**
 * Snapshot leaseId→sessionKey for every identified lease (those with a resolved
 * terminal identity — exactly the sessions the registry tracks). Taken BEFORE a
 * cleanup pass releases leases, so cleanupReleasedLeases can still map a released
 * snapshot back to its registry sessionKey.
 */
function captureSessionKeysByLeaseId(): Map<string, string> {
  const map = new Map<string, string>();
  for (const lease of leaseManager.getConfinedLeases()) {
    const sessionKey = sessionKeyForLease(lease);
    if (sessionKey) map.set(lease.leaseId, sessionKey);
  }
  return map;
}

/**
 * Shared teardown notification for a lease that has left the LeaseManager:
 * unsubscribe confinement tracking for explicit leases, and tell the window
 * registry the session is gone when a sessionKey is known. Used by the
 * periodic cleanup pass (cleanupReleasedLeases) and by the LeaseManager's
 * onExpired hook (heartbeat()/get() releasing a stale lease internally,
 * ahead of the next cleanup tick).
 */
function notifyLeaseGone(lease: { readonly leaseId: string; readonly targetKind: string }, sessionKey: string | null): void {
  if (lease.targetKind === "explicit") unsubscribeConfinement(lease.leaseId);
  if (sessionKey) {
    if (!sessionHasOtherLiveLease(sessionKey, lease.leaseId)) projectMemoryWrites.delete(sessionKey);
    windowPetRegistry.onSessionGone(sessionKey);
    sessionLiveStatus.remove(sessionKey);
  }
}

function cleanupReleasedLeases(
  leases: readonly { readonly leaseId: string; readonly targetKind: string }[],
  sessionKeys?: ReadonlyMap<string, string>,
): void {
  for (const lease of leases) {
    notifyLeaseGone(lease, sessionKeys?.get(lease.leaseId) ?? null);
  }
}

function releaseExplicitLease(leaseId: string): { readonly released: boolean } {
  const raw = leaseManager.getRawLease(leaseId);
  const sessionKey = raw ? sessionKeyForLease(raw) : null;
  unsubscribeConfinement(leaseId);
  const result = leaseManager.release(leaseId);
  if (sessionKey) {
    if (!sessionHasOtherLiveLease(sessionKey, leaseId)) projectMemoryWrites.delete(sessionKey);
    windowPetRegistry.onSessionGone(sessionKey);
    sessionLiveStatus.remove(sessionKey);
  }
  return result;
}

/**
 * Register a session with the window registry once its terminal identity has
 * resolved. The registry binds/spawns the pet (explicit request, pool draw, or
 * default coverage) and returns the pet now bound to the session's window, or
 * null when the session stays on the default pet or isn't fully identified yet.
 */
function registerIdentifiedSession(leaseId: string): string | null {
  const raw = leaseManager.getRawLease(leaseId);
  if (!raw?.clientPid || !raw.sessionNonce || !raw.terminalOwnerPid) return null;
  const { petPoolEnabled, sessionAssignment } = getAppStateSnapshot().preferences;
  return windowPetRegistry.onSessionIdentified(
    {
      sessionKey: `${raw.clientPid}:${raw.sessionNonce}`,
      leaseId,
      terminalOwnerPid: raw.terminalOwnerPid,
      terminalWindowId: raw.terminalWindowId,
      label: sessionLabelFromCwd(raw.cwd, raw.terminalAppName ?? "session"),
      cwd: raw.cwd,
    },
    raw.targetKind === "explicit" ? raw.actualPetId : raw.requestedPetId === null ? null : undefined,
    petPoolEnabled === true,
    sessionAssignment,
  );
}

/** The pet currently bound to the lease's terminal window, or null (anonymous
 *  caller, unresolved identity, or default coverage).
 *
 *  Grace-window fallback: when the window identity hasn't resolved yet (no
 *  terminalOwnerPid) but the lease targets an explicit pet, fall back to
 *  lease.actualPetId so the already-visible grace-spawned pet receives the
 *  say/react instead of misrouting to the default pet. */
function displayPetForLease(lease: PetLease | null | undefined): string | null {
  const windowKey = lease?.terminalOwnerPid ? windowKeyForIdentity(lease.terminalWindowId, lease.terminalOwnerPid) : undefined;
  const registryPet = windowKey ? windowPetRegistry.petForWindow(windowKey) : null;
  if (registryPet) return registryPet;
  // Explicit lease during pre-identity grace window: the pet was spawned by
  // the 3s grace timer but identity hasn't resolved yet so no registry binding
  // exists. Route to the explicit pet directly.
  if (lease && lease.targetKind === "explicit" && lease.actualPetId) return lease.actualPetId;
  return null;
}

/**
 * Record a say/react into the notification store that owns the caller's session
 * (its binding store, else the default store) and mark the session active.
 * Anonymous callers (no clientPid+sessionNonce) animate the pet but write no row.
 */
function recordSessionNotification(lease: PetLease | null, kind: string, message: string): void {
  const sessionKey = lease?.clientPid && lease.sessionNonce ? `${lease.clientPid}:${lease.sessionNonce}` : undefined;
  if (!sessionKey) return;
  const windowKey = lease?.terminalOwnerPid ? windowKeyForIdentity(lease.terminalWindowId, lease.terminalOwnerPid) : undefined;
  const label = sessionLabelFromCwd(lease?.cwd, lease?.terminalAppName ?? "session");
  windowPetRegistry.storeForSession(sessionKey).record({ sessionKey, windowKey, terminalAppName: lease?.terminalAppName, kind, message, label });
  windowPetRegistry.touchSessionActivity(sessionKey);
  const displayPet = displayPetForLease(lease);
  if (displayPet) refreshAgentPetNotifications(displayPet);
  else refreshDefaultPetNotifications();
}

async function resolveTerminalIdentity(leaseId: string, clientPid: number): Promise<void> {
  // Get the petId — required to key confinement state. Non-explicit leases
  // don't participate in window confinement, but the default pet still needs
  // the terminal identity for its focus-session-window action.
  const lease = leaseManager.getRawLease(leaseId);
  if (!lease) return;
  if (lease.targetKind !== "explicit") {
    void resolveDefaultLeaseTerminalIdentity(leaseId, clientPid);
    return;
  }
  const petId = lease.actualPetId;

  const deps: ConfinementPollerDeps = {
    findTerminal: async (pid) => {
      const termInfo = await findTerminalWindowForPid(pid, lease.cwd);
      // Diagnostic: distinguish (A) zero windows [permission], (B) no ancestor,
      // (C) resolved. window-tracker already logs windowCount at info level.
      if (!termInfo) {
        info("ipc", "terminal identity first resolve returned null — poller will self-heal", {
          leaseId,
          clientPid: pid,
        });
      } else {
        info("ipc", "terminal identity resolved", {
          leaseId,
          clientPid: pid,
          terminalPid: termInfo.terminalPid,
          appName: termInfo.appName,
          isMinimized: termInfo.isMinimized,
          isOccluded: termInfo.isOccluded,
        });
      }
      return termInfo;
    },
    subscribe: (id, pid, onFound, onNull) => subscribeWindowTracking(id, pid, onFound, onNull, lease.cwd),
    setIdentity: (termInfo) => {
      const changed = leaseManager.setTerminalIdentity(leaseId, {
        terminalOwnerPid: termInfo.terminalPid,
        terminalAppName: termInfo.appName,
        terminalWindowId: termInfo.window?.id,
      });
      if (!changed) return;
      void captureClientAncestry(leaseId, clientPid);
      // Identity resolved → let the registry bind/spawn the pet for this window.
      registerIdentifiedSession(leaseId);
    },
    // Confinement follows the registry's bound pet for this window (falling back
    // to the explicit lease pet during the pre-identity grace window).
    applyUpdate: (termInfo) => {
      const windowKey = windowKeyForIdentity(termInfo.window?.id, termInfo.terminalPid);
      applyConfinementUpdate(windowPetRegistry.petForWindow(windowKey) ?? petId, termInfo);
    },
    isAlive: () => !!leaseManager.getRawLease(leaseId),
    onDead: () => unsubscribeConfinement(leaseId),
    // Phase 2: Screen Recording permission — macOS only.
    // On Windows and Linux there is no SR permission concept; window enumeration
    // is available without it, so we treat the status as always "granted".
    getScreenPermissionStatus: () =>
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : "granted",
    // Phase 2: opens the SR pane in System Settings on macOS.
    // No-op on other platforms (they have no equivalent permission to grant).
    promptScreenPermission: () => {
      if (process.platform === "darwin") {
        void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
      }
    },
    // Phase 2: fires the one-time actionable notification (macOS only).
    notifyScreenPermission: (onAction) => {
      if (process.platform !== "darwin") return;
      info("ipc", "Screen Recording permission not granted — showing notification", {
        leaseId,
        status: systemPreferences.getMediaAccessStatus("screen"),
      });
      if (!Notification.isSupported()) return;
      const title = t("confinement.screenPermission.title");
      const body = t("confinement.screenPermission.body");
      const n = new Notification({ title, body, silent: true });
      n.on("click", onAction);
      n.show();
    },
  };

  try {
    await resolveAndSubscribe(leaseId, clientPid, deps, confinementUnsubscribers);
  } catch (err) {
    info("ipc", "terminal identity resolution error", { leaseId, clientPid, error: String(err) });
  }
}

/**
 * Default-target leases don't participate in confinement, but the default pet
 * can still focus the session terminal. Resolve the identity once (retrying a
 * few times — window enumeration can lag right after acquire) and store it on
 * the lease. No poller: a terminal window's owner PID is stable for the life
 * of the session.
 */
async function resolveDefaultLeaseTerminalIdentity(leaseId: string, clientPid: number): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const rawLease = leaseManager.getRawLease(leaseId);
    if (!rawLease) return;
    try {
      const termInfo = await findTerminalWindowForPid(clientPid, rawLease.cwd);
      if (termInfo) {
        leaseManager.setTerminalIdentity(leaseId, {
          terminalOwnerPid: termInfo.terminalPid,
          terminalAppName: termInfo.appName,
          terminalWindowId: termInfo.window?.id,
        });
        void captureClientAncestry(leaseId, clientPid);
        // Identity resolved → register with the registry (pool draw / default
        // coverage).
        const boundPetId = registerIdentifiedSession(leaseId);
        info("ipc", "terminal identity resolved (default lease)", { leaseId, clientPid, attempt, terminalPid: termInfo.terminalPid, appName: termInfo.appName, boundPetId });
        // Pool-drawn pets need confinement tracking just like explicit-lease pets.
        if (boundPetId) {
          void subscribePoolConfinement(leaseId, clientPid, boundPetId);
        }
        return;
      }
    } catch (err) {
      info("ipc", "terminal identity resolution error (default lease)", { leaseId, clientPid, error: String(err) });
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  }
  info("ipc", "terminal identity unresolved (default lease)", { leaseId, clientPid });
}

/**
 * Subscribe a pool-drawn pet to the confinement poller so it tracks its
 * terminal window bounds. Mirrors the explicit-lease path in
 * resolveTerminalIdentity but starts after identity is already resolved.
 */
async function subscribePoolConfinement(leaseId: string, clientPid: number, petId: string): Promise<void> {
  const leaseCwd = leaseManager.getRawLease(leaseId)?.cwd;
  const deps: ConfinementPollerDeps = {
    findTerminal: (pid) => findTerminalWindowForPid(pid, leaseCwd),
    subscribe: (id, pid, onFound, onNull) => subscribeWindowTracking(id, pid, onFound, onNull, leaseCwd),
    setIdentity: (termInfo) => {
      const changed = leaseManager.setTerminalIdentity(leaseId, {
        terminalOwnerPid: termInfo.terminalPid,
        terminalAppName: termInfo.appName,
        terminalWindowId: termInfo.window?.id,
      });
      // Keep the registry's window binding in sync with a real identity change
      // (e.g. the session's window closed and it re-resolved elsewhere) —
      // otherwise the lease's windowKey drifts from the binding and say/react
      // silently misroutes to the default pet.
      if (changed) registerIdentifiedSession(leaseId);
    },
    applyUpdate: (termInfo) => {
      const windowKey = windowKeyForIdentity(termInfo.window?.id, termInfo.terminalPid);
      applyConfinementUpdate(windowPetRegistry.petForWindow(windowKey) ?? petId, termInfo);
    },
    isAlive: () => !!leaseManager.getRawLease(leaseId),
    onDead: () => unsubscribeConfinement(leaseId),
    getScreenPermissionStatus: () =>
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : "granted",
    promptScreenPermission: () => {
      if (process.platform === "darwin") {
        void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
      }
    },
    notifyScreenPermission: (onAction) => {
      if (process.platform !== "darwin") return;
      if (!Notification.isSupported()) return;
      const title = t("confinement.screenPermission.title");
      const body = t("confinement.screenPermission.body");
      const n = new Notification({ title, body, silent: true });
      n.on("click", onAction);
      n.show();
    },
  };

  try {
    await resolveAndSubscribe(leaseId, clientPid, deps, confinementUnsubscribers);
  } catch (err) {
    info("ipc", "pool confinement subscription error", { leaseId, clientPid, petId, error: String(err) });
  }
}

/** Record the client's ancestor PID chain on the lease (cache-warm right after the identity walk). */
async function captureClientAncestry(leaseId: string, clientPid: number): Promise<void> {
  try {
    const chain = await getAncestorPidChain(clientPid);
    leaseManager.setClientAncestry(leaseId, chain);
  } catch (err) {
    debug("ipc", "client ancestry capture failed", { leaseId, clientPid, error: String(err) });
  }
}

/**
 * Route a say/react from a lease-less or default-lease caller to the pet of
 * the session it belongs to. Short-lived helper processes (Claude Code hooks)
 * share the coding agent's process ancestry with that session's MCP client, so
 * the caller's PID chain identifies the session. Returns undefined when no
 * dedicated session pet matches — the caller falls through to the default pet.
 */
async function resolveSessionPetTarget(
  lease: { readonly leaseId: string; readonly targetKind: string } | null | undefined,
  params: Record<string, unknown>,
): Promise<PetLease | undefined> {
  if (lease && lease.targetKind !== "default") return undefined;
  if (!leaseManager.hasSessionRoutableLeases()) {
    debug("ipc", "session routing skipped — no routable leases");
    return undefined;
  }
  // Preference order: ancestry supplied by the caller (short-lived hooks — the
  // only chance to observe a process that dies right after this request),
  // then ancestry stored on the lease, then a live walk of the caller's pid.
  let chain: readonly number[] | undefined = validateClientAncestorPids(params.clientAncestorPids);
  const chainSource = chain ? "caller-supplied" : "none";
  if (!chain) chain = lease ? leaseManager.getRawLease(lease.leaseId)?.clientAncestorPids : undefined;
  if (!chain || chain.length === 0) {
    const clientPid = typeof params.clientPid === "number" && params.clientPid > 0 ? Math.floor(params.clientPid) : undefined;
    if (clientPid === undefined) {
      debug("ipc", "session routing failed — no ancestry chain", { chainSource, hasClientPid: false });
      return undefined;
    }
    try {
      chain = await getAncestorPidChain(clientPid);
    } catch {
      return undefined;
    }
  }
  if (chain.length === 0) return undefined;
  const match = leaseManager.findSessionPetLease(chain);
  if (!match) {
    debug("ipc", "session routing — no match", { chainSource, chainLength: chain.length, chainHead: chain.slice(0, 5) });
  }
  return match;
}

function validateClientAncestorPids(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const pids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) return undefined;
    pids.push(Math.floor(entry));
  }
  return pids;
}

function applyConfinementUpdate(petId: string, info: TerminalWindowInfo): void {
  setConfinementState(petId, {
    terminalBounds: info.window?.bounds ?? null,
    terminalMinimized: info.isMinimized,
    terminalOccluded: info.isOccluded,
    terminalOwnerPid: info.terminalPid,
    appName: info.appName,
  });
  repositionConfinedPet(petId);
}

function unsubscribeConfinement(leaseId: string): void {
  const unsub = confinementUnsubscribers.get(leaseId);
  if (unsub) { unsub(); confinementUnsubscribers.delete(leaseId); }
}

function writeResponse(socket: net.Socket, response: unknown): void {
  if (socket.destroyed || !socket.writable) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

function isBenignSocketCloseError(error: NodeJS.ErrnoException): boolean {
  return error.code === "EPIPE" || error.code === "ECONNRESET" || error.code === "ERR_STREAM_DESTROYED";
}

function resolveLeaseTarget(requestedPetId: string | undefined): { readonly targetKind: "default" | "explicit"; readonly actualPetId: string; readonly fallbackReason?: "invalid_pet_id" | "pet_not_installed" | "pet_broken" | "default_broken_fallback_builtin" } {
  const defaultPet = getCurrentDefaultPetWithFallback();

  if (!requestedPetId) {
    // No explicit pet requested → default target. Pool assignment no longer
    // happens here: it is a per-window draw performed by the registry's
    // drawPoolPet callback at terminal-identity-resolve time.
    return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: defaultPet.fallbackReason };
  }

  // Explicit request for the built-in or the current default: honour it directly
  // without consulting the pool (pre-pool semantics, "explicit always wins").
  if (requestedPetId === builtInPet.id || requestedPetId === defaultPet.id) {
    return { targetKind: "default", actualPetId: defaultPet.id };
  }

  if (!safePetIdPattern.test(requestedPetId)) {
    return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: "invalid_pet_id" };
  }
  const pet = getAppStateSnapshot().pets.installed.find((candidate) => candidate.id === requestedPetId);
  if (!pet) return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: "pet_not_installed" };
  if (pet.broken) return { targetKind: "default", actualPetId: defaultPet.id, fallbackReason: "pet_broken" };
  return { targetKind: "explicit", actualPetId: pet.id };
}

function getCurrentDefaultPet(): { readonly id: string; readonly displayName: string } {
  const pet = getCurrentDefaultPetWithFallback();
  return { id: pet.id, displayName: pet.displayName };
}

function getCurrentDefaultPetWithFallback(): { readonly id: string; readonly displayName: string; readonly fallbackReason?: "default_broken_fallback_builtin" } {
  const state = getAppStateSnapshot();
  const configuredDefault = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);
  if (configuredDefault && !configuredDefault.broken) return configuredDefault;
  return { ...builtInPet, fallbackReason: "default_broken_fallback_builtin" };
}

function getPetDisplayName(petId: string): string {
  return getAppStateSnapshot().pets.installed.find((pet) => pet.id === petId)?.displayName ?? petId;
}

function isPetEligible(petId: string): boolean {
  return getAppStateSnapshot().pets.installed.some((pet) => pet.id === petId && !pet.broken);
}

export function getSessionsSnapshot(): {
  sessions: readonly EnrichedSessionSnapshot[];
  recentlyDisconnected: readonly DisconnectedSession[];
  pool: { used: number; total: number } | null;
  assignablePets: ReadonlyArray<{ id: string; displayName: string; inUse: boolean }>;
  serverTime: number;
} {
  const now = Date.now();
  const rawLeases = leaseManager.getAllRawLeases();
  const state = getAppStateSnapshot();
  const ttlMs = 15_000;

  const sessions: EnrichedSessionSnapshot[] = rawLeases.map((lease) => {
    const snap = leaseManager.snapshot(lease);
    const sessionKey = sessionKeyForLease(lease);
    const store = sessionKey ? windowPetRegistry.storeForSession(sessionKey) : null;
    const unresolvedNotifications = store?.unresolvedCount() ?? 0;

    let confinementState: EnrichedSessionSnapshot["confinementState"];
    if (lease.targetKind === "explicit") {
      const conf = getConfinementState(lease.actualPetId);
      if (conf) {
        if (conf.terminalMinimized) confinementState = "minimized";
        else if (conf.terminalOccluded) confinementState = "occluded";
        else if (conf.terminalBounds) confinementState = "confined";
        else confinementState = "free-roam";
      }
    }

    let petVisible = true;
    let petDismissed = false;
    if (lease.targetKind === "explicit") {
      petDismissed = isAgentPetDismissed(lease.actualPetId);
      petVisible = !petDismissed && !isAgentPetHidden(lease.actualPetId);
    }

    const focusTarget = sessionKey ? windowPetRegistry.sessionFocusTarget(sessionKey) : null;
    const canFocus = focusTarget !== null;

    const elapsed = now - lease.lastHeartbeatAt;
    const healthPct = Math.max(0, Math.min(1, 1 - elapsed / ttlMs));

    const displayPet = sessionKey ? windowPetRegistry.displayPetForSession(sessionKey) : null;
    const displayPetId = displayPet?.petId;
    const displayPetName = displayPetId ? getPetDisplayName(displayPetId) : undefined;
    const displayPetOrigin = displayPet?.origin;

    const windowKey = lease.terminalOwnerPid ? windowKeyForIdentity(lease.terminalWindowId, lease.terminalOwnerPid) : undefined;

    return { ...snap, unresolvedNotifications, confinementState, petVisible, petDismissed, canFocus, healthPct, displayPetId, displayPetName, displayPetOrigin, windowKey };
  });

  const boundPets = new Set(windowPetRegistry.boundPetIds());

  const poolOrder = state.preferences.petPoolOrder;
  let pool: { used: number; total: number } | null = null;
  if (poolOrder && poolOrder.length > 0) {
    const eligibleSet = new Set(getEligiblePoolPetIds(state.pets.installed, builtInPet.id, state.preferences.defaultPetId));
    const totalSlots = poolOrder.filter(id => eligibleSet.has(id)).length;
    const usedSlots = poolOrder.filter((id) => eligibleSet.has(id) && (boundPets.has(id) || leaseManager.countExplicitLeases(id) > 0)).length;
    pool = { used: usedSlots, total: totalSlots };
  }

  const assignableEligible = getEligiblePoolPetIds(state.pets.installed, builtInPet.id, state.preferences.defaultPetId);
  const assignablePets = assignableEligible.map((id) => ({ id, displayName: getPetDisplayName(id), inUse: boundPets.has(id) }));

  return { sessions, recentlyDisconnected: [...recentlyDisconnected], pool, assignablePets, serverTime: now };
}

export function releaseSessionFromUi(leaseId: string): boolean {
  const raw = leaseManager.getRawLease(leaseId);
  if (!raw) return false;
  if (raw.sessionNonce && raw.clientPid) {
    blockedSessions.set(raw.sessionNonce, raw.clientPid);
    info("ipc", "session blocked from re-acquire", { leaseId, sessionNonce: raw.sessionNonce, clientPid: raw.clientPid });
  }
  recordDisconnection(raw, "released");
  const petId = raw.actualPetId;
  if (raw.targetKind === "explicit") {
    releaseExplicitLease(leaseId);
    if (leaseManager.countExplicitLeases(petId) === 0) {
      clearAgentPetLeaseState(petId);
      clearConfinementState(petId);
    }
  } else {
    const sessionKey = sessionKeyForLease(raw);
    leaseManager.release(leaseId);
    if (sessionKey) {
      if (!sessionHasOtherLiveLease(sessionKey, leaseId)) projectMemoryWrites.delete(sessionKey);
      windowPetRegistry.onSessionGone(sessionKey);
      sessionLiveStatus.remove(sessionKey);
    }
  }
  return true;
}

export function revealTabForLease(leaseId: string | undefined): void {
  if (!leaseId) return;
  const chain = leaseManager.getRawLease(leaseId)?.clientAncestorPids;
  if (!chain || chain.length === 0) return;
  requestTabReveal(chain);
}

export async function focusSessionTerminal(leaseId: string): Promise<boolean> {
  const raw = leaseManager.getRawLease(leaseId);
  if (!raw) return false;
  const sessionKey = sessionKeyForLease(raw);
  const target = sessionKey ? windowPetRegistry.sessionFocusTarget(sessionKey) : null;
  if (!target) return false;
  const focused = await focusTerminalWindow(target.terminalOwnerPid, target.terminalWindowId);
  revealTabForLease(target.leaseId ?? leaseId);
  return focused;
}

export function toggleSessionPetVisibility(leaseId: string): boolean {
  const raw = leaseManager.getRawLease(leaseId);
  if (!raw || raw.targetKind !== "explicit") return false;
  const petId = raw.actualPetId;
  if (isAgentPetDismissed(petId)) {
    clearAgentPetDismissal(petId);
    showAgentPet(petId);
  } else if (isAgentPetHidden(petId)) {
    unhideAgentPet(petId);
  } else {
    hideAgentPet(petId);
  }
  return true;
}

/** Control-Center: assign petId to a window's binding (null = return to default).
 *  Writes/clears project memory for every distinct cwd among the window's sessions. */
export function assignWindowPet(windowKey: string, petId: string | null): boolean {
  if (petId !== null) {
    const state = getAppStateSnapshot();
    const eligible = getEligiblePoolPetIds(state.pets.installed, builtInPet.id, getCurrentDefaultPet().id);
    if (!eligible.includes(petId)) return false;
  }
  if (!windowPetRegistry.assignPetToWindow(windowKey, petId)) return false;
  for (const lease of leaseManager.getAllRawLeases()) {
    if (!lease.terminalOwnerPid) continue;
    if (windowKeyForIdentity(lease.terminalWindowId, lease.terminalOwnerPid) !== windowKey) continue;
    // A default-coverage session has no confinement poller yet (only pool-drawn
    // and explicit-lease pets get one at identity time) — without this the
    // assigned pet spawns but never follows the window. Double-subscribe is
    // guarded per-lease inside resolveAndSubscribe.
    if (petId !== null && lease.clientPid) {
      void subscribePoolConfinement(lease.leaseId, lease.clientPid, petId);
    }
    if (!lease.cwd) continue;
    const sessionKey = sessionKeyForLease(lease);
    if (petId === null) {
      forgetProjectPet(lease.cwd);
    } else {
      rememberProjectPet(lease.cwd, petId);
      // Mark as written so a later --pet re-acquire can't overwrite this choice.
      if (sessionKey) {
        let seen = projectMemoryWrites.get(sessionKey);
        if (!seen) {
          seen = new Set();
          projectMemoryWrites.set(sessionKey, seen);
        }
        seen.add(petId);
      }
    }
  }
  info("ipc", "window pet assigned from ui", { windowKey, petId });
  return true;
}
