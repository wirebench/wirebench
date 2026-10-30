/**
 * `<agent home>/agent.json`, `{ pid, port }`, written while `wirebench agent` runs, so `wirebench agent pair`
 * in another terminal tells the server the port the running agent listens on, and `status` can say whether
 * one runs. A file whose process is gone is a crashed agent's: it counts as not running.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const AGENT_STATUS_FILE = 'agent.json';

export interface AgentRunStatus {
  readonly pid: number;
  readonly port: number;
}

/**
 * Whether process `pid` is a running agent. `EPERM` (a live process of another account) counts as not: the
 * folder is `0700`, so only this account writes pids into it, and such a pid is a reused one.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The running agent's pid and port, or `undefined` when none runs (no file, an unreadable one, or a dead pid). */
export async function readRunStatus(home: string): Promise<AgentRunStatus | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(home, AGENT_STATUS_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { pid, port } = parsed as { pid?: unknown; port?: unknown };
  if (!Number.isInteger(pid) || !Number.isInteger(port)) return undefined;
  return alive(pid as number) ? { pid: pid as number, port: port as number } : undefined;
}

export async function writeRunStatus(home: string, status: AgentRunStatus): Promise<void> {
  await writeFile(join(home, AGENT_STATUS_FILE), `${JSON.stringify(status)}\n`, { mode: 0o600 });
}

/** Removes the file if it is still this process's (another agent may have started since). */
export async function clearRunStatus(home: string, pid: number = process.pid): Promise<void> {
  const now = await readRunStatus(home);
  if (now === undefined || now.pid === pid) await rm(join(home, AGENT_STATUS_FILE), { force: true });
}
