import type { Caller } from './host/platform.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { WirebenchError } from '@wirebench/engine';
import { events } from '@wirebench/wire/ipc';
import type { IpcEvent } from '@wirebench/wire/ipc';
import type {
  LocalTerminalCloseRequest,
  LocalTerminalOpenRequest,
  LocalTerminalOpenResponse,
  LocalTerminalResizeRequest,
  LocalTerminalWriteRequest,
} from '@wirebench/wire/local-terminal-wire';
import type { LocalShell } from './local-shell.js';

/** The part of a pseudo-terminal this service uses; `@lydell/node-pty`'s `IPty` has it. */
export interface LocalPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

/** `@lydell/node-pty`'s `spawn`, narrowed to the options this service passes. */
export type LocalPtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => LocalPty;

export interface LocalTerminalDeps {
  /** Loads the native pty binding; a rejection is a missing or broken binary, reported, never a crash. */
  readonly load: () => Promise<LocalPtySpawn>;
  readonly emit: (target: Caller, event: IpcEvent<z.ZodType>, payload: unknown) => void;
  /** The shell to run, read per open so a changed preference applies to the next tab. */
  readonly shell: () => LocalShell;
  /** Where the window's shell starts: its workspace's own folder, or home. */
  readonly cwd: (sender: Caller) => string;
  readonly env: () => Record<string, string>;
  /** Tests inject ids. */
  readonly newId?: () => string;
}

interface Live {
  readonly pty: LocalPty;
  readonly sender: Caller;
  readonly stop: () => void;
}

/**
 * The local terminal tabs' shells (#410), each in a pseudo-terminal and owned by the window that opened it:
 * only that window writes to it, resizes it, closes it, or hears from it, as with an SSH session.
 */
export class LocalTerminalService {
  private readonly live = new Map<string, Live>();
  private readonly watched = new Set<number>();
  private spawn: Promise<LocalPtySpawn> | undefined;

  constructor(private readonly deps: LocalTerminalDeps) {}

  /**
   * @throws WirebenchError `local-terminal-unavailable` when the pty binding does not load on this machine;
   * `local-terminal-failed` when the shell does not start.
   */
  async open(sender: Caller, request: LocalTerminalOpenRequest): Promise<LocalTerminalOpenResponse> {
    const spawn = await this.binding();
    const shell = this.deps.shell();
    let pty: LocalPty;
    try {
      pty = spawn(shell.file, [...shell.args], {
        name: 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: this.deps.cwd(sender),
        env: this.deps.env(),
      });
    } catch (error) {
      throw new WirebenchError('local-terminal-failed', `Could not start ${shell.file}: ${messageOf(error)}`);
    }
    const sessionId = (this.deps.newId ?? randomUUID)();
    const data = pty.onData((text) => {
      if (sender.isClosed()) return;
      this.deps.emit(sender, events.localTerminal.data, {
        sessionId,
        data: Buffer.from(text, 'utf8').toString('base64'),
      });
    });
    const exit = pty.onExit(({ exitCode }) => {
      if (!this.live.has(sessionId)) return;
      this.drop(sessionId);
      if (!sender.isClosed()) this.deps.emit(sender, events.localTerminal.exit, { sessionId, code: exitCode });
    });
    this.live.set(sessionId, {
      pty,
      sender,
      stop: () => {
        data.dispose();
        exit.dispose();
      },
    });
    this.watch(sender);
    return { sessionId, shell: shell.name };
  }

  /** @throws WirebenchError `local-terminal-unknown` for a foreign or ended session. */
  write(sender: Caller, request: LocalTerminalWriteRequest): void {
    this.owned(sender, request.sessionId).pty.write(Buffer.from(request.data, 'base64').toString('utf8'));
  }

  /** @throws WirebenchError `local-terminal-unknown` for a foreign or ended session. */
  resize(sender: Caller, request: LocalTerminalResizeRequest): void {
    this.owned(sender, request.sessionId).pty.resize(request.cols, request.rows);
  }

  /** Idempotent: a session already gone, or another window's, is left as it is. The shell is killed quietly. */
  close(sender: Caller, request: LocalTerminalCloseRequest): void {
    const live = this.live.get(request.sessionId);
    if (!live || live.sender.id !== sender.id) return;
    this.drop(request.sessionId);
    kill(live.pty);
  }

  /** Ends the shells one window owns: it went away, reloaded, or switched workspace. */
  disposeFor(sender: Caller): void {
    for (const [sessionId, live] of [...this.live]) {
      if (live.sender.id !== sender.id) continue;
      this.drop(sessionId);
      kill(live.pty);
    }
  }

  /** Loads the binding once; a failed load is tried again on the next open. */
  private async binding(): Promise<LocalPtySpawn> {
    this.spawn ??= this.deps.load();
    try {
      return await this.spawn;
    } catch (error) {
      this.spawn = undefined;
      throw new WirebenchError(
        'local-terminal-unavailable',
        `The local terminal is not available on this machine: ${messageOf(error)}`,
      );
    }
  }

  private watch(sender: Caller): void {
    if (this.watched.has(sender.id)) return;
    this.watched.add(sender.id);
    // A reload or a crash starts a renderer that knows nothing of the old shells; they go too.
    sender.onReset(() => {
      this.disposeFor(sender);
    });
    sender.onClosed(() => {
      this.watched.delete(sender.id);
      this.disposeFor(sender);
    });
  }

  private owned(sender: Caller, sessionId: string): Live {
    const live = this.live.get(sessionId);
    if (!live || live.sender.id !== sender.id) {
      throw new WirebenchError('local-terminal-unknown', 'No such local terminal');
    }
    return live;
  }

  private drop(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.stop();
    this.live.delete(sessionId);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A shell that already ended can throw on kill; there is nothing left to stop. */
function kill(pty: LocalPty): void {
  try {
    pty.kill();
  } catch {
    // already gone
  }
}
