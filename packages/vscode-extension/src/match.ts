/**
 * Pure session→terminal matching. A session's agent/MCP process is a
 * descendant of the shell VS Code spawned for its tab, so the terminal's
 * shell PID appears in the session's ancestor PID chain. No VS Code imports —
 * unit-testable with plain promises.
 */

export interface MatchableTerminal {
  /** vscode.Terminal.processId — resolves to the shell PID or undefined. */
  readonly processId: Thenable<number | undefined>;
}

export async function pickTerminalForChain(
  terminals: readonly MatchableTerminal[],
  sessionAncestorPids: readonly number[],
  capMs: number
): Promise<number | null> {
  if (terminals.length === 0 || sessionAncestorPids.length === 0) return null;
  const chain = new Set(sessionAncestorPids);

  const pids = await Promise.all(
    terminals.map((terminal) =>
      Promise.race([
        Promise.resolve(terminal.processId).catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), capMs)),
      ])
    )
  );

  for (let index = 0; index < pids.length; index += 1) {
    const pid = pids[index];
    if (pid !== undefined && chain.has(pid)) return index;
  }
  return null;
}
