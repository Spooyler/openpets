/**
 * OpenPets VS Code extension — terminal-tab focus.
 *
 * Keeps one `vscode.wait-focus` request parked at the OpenPets desktop app
 * (long-poll over the local IPC). When the user asks the pet to focus a
 * session, the desktop completes the parked request with the session's
 * ancestor PID chain; if one of THIS window's integrated terminals owns a
 * PID in that chain, reveal it. Fire-and-forget posture: every failure is
 * swallowed into the output channel and retried with backoff — the editor
 * is never disrupted. PIDs are the only data exchanged.
 */

import * as vscode from "vscode";

import { readDiscoveryFile, sendRequest, type VsCodeFocusCommand } from "@open-pets/client";

import { pickTerminalForChain } from "./match.js";

const waitResponseTimeoutMs = 70_000; // > desktop keepalive (60s)
const processIdCapMs = 2_000;
const minBackoffMs = 1_000;
const maxBackoffMs = 30_000;

let running = false;
let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("OpenPets");
  context.subscriptions.push(output);
  running = true;
  void waitLoop();
}

export function deactivate(): void {
  running = false;
}

async function waitLoop(): Promise<void> {
  let backoffMs = minBackoffMs;
  while (running) {
    try {
      const discovery = readDiscoveryFile();
      const command = await sendRequest<VsCodeFocusCommand>(discovery, "vscode.wait-focus", {}, {
        responseTimeoutMs: waitResponseTimeoutMs,
      });
      backoffMs = minBackoffMs;
      if (command.command === "reveal-terminal") {
        await revealMatchingTerminal(command.sessionAncestorPids);
      } else if (command.retryAfterMs) {
        await delay(command.retryAfterMs);
      }
      // command === null keepalive: re-arm immediately.
    } catch (error) {
      log(`wait-focus idle: ${error instanceof Error ? error.message : String(error)}`);
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }
}

async function revealMatchingTerminal(sessionAncestorPids: readonly number[]): Promise<void> {
  try {
    const terminals = vscode.window.terminals;
    const index = await pickTerminalForChain(terminals, sessionAncestorPids, processIdCapMs);
    if (index === null) return; // another window owns this session
    terminals[index]?.show(false);
    log(`revealed terminal #${index}`);
  } catch (error) {
    log(`reveal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function log(message: string): void {
  output?.appendLine(`[openpets] ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
