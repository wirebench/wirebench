/**
 * This machine's stdio approvals for MCP servers (#79): which command lines may run, and the prompt
 * that asks about one that may not yet.
 *
 * The command line lives in the project, so a `git pull` can change what *Send* runs. The engine asks
 * the send's host before it spawns anything (`SendHost.approveCommand`); the desktop answers from
 * `userData/mcp-approvals.json`, kept per machine and never in a project, or asks the person. The
 * prompt is a round trip to the window: main sends `mcp.approval`, the window shows the dialog and
 * answers with `app.mcpApprove`. *Run once* lets this send through and keeps nothing; *Always allow*
 * keeps the fingerprint; *Cancel*, a window that goes away and a prompt nobody answers refuse it.
 *
 * Within one run (a sequence, the Runner) a fingerprint is asked about at most once: the run's
 * memo keeps the answer for its later sends, whichever it was.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { nodeFs, writeFileAtomic } from '@wirebench/engine';
import type { CommandApprovalRequest } from '@wirebench/engine';
import { z } from 'zod';
import {
  mcpApprovalWireSchema,
  type McpApprovalAnswerWire,
  type McpApprovalPromptEvent,
  type McpApprovalWire,
} from '../shared/kinds/mcp/wire.js';

export const MCP_APPROVALS_FILE = 'mcp-approvals.json';

/** How long a prompt waits for its answer before it counts as *Cancel*. */
export const MCP_APPROVAL_TIMEOUT_MS = 5 * 60_000;

const approvalsFileSchema = z.object({ version: z.literal(1), approvals: z.array(mcpApprovalWireSchema) });

/** What the engine's send asks: may this command line run? */
export type CommandApprover = (request: CommandApprovalRequest) => Promise<boolean>;

/** A run's memo: each fingerprint's answer, asked once for the whole run. */
export type McpRunApprovals = Map<string, Promise<boolean>>;

/**
 * The approvals kept in `userData/mcp-approvals.json`. Writes are atomic and go one at a time, each
 * reading the file afresh. A missing file is no approvals; a malformed one lists none, is reported
 * once, and is replaced by the next write.
 */
export class McpApprovalStore {
  private queue: Promise<unknown> = Promise.resolve();
  private reported = false;

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  /** Every approval, newest first. */
  list(): Promise<McpApprovalWire[]> {
    return this.enqueue(async () => newestFirst(await this.read()));
  }

  has(fingerprint: string): Promise<boolean> {
    return this.enqueue(async () => (await this.read()).some((approval) => approval.fingerprint === fingerprint));
  }

  /** Keeps `approval`, replacing one with the same fingerprint. */
  add(approval: McpApprovalWire): Promise<void> {
    return this.change((approvals) => [
      ...approvals.filter((kept) => kept.fingerprint !== approval.fingerprint),
      approval,
    ]).then(() => undefined);
  }

  /** Forgets one approval and answers with the rest, newest first; an unknown fingerprint changes nothing. */
  revoke(fingerprint: string): Promise<McpApprovalWire[]> {
    return this.change((approvals) => approvals.filter((kept) => kept.fingerprint !== fingerprint)).then(newestFirst);
  }

  private change(edit: (approvals: McpApprovalWire[]) => McpApprovalWire[]): Promise<McpApprovalWire[]> {
    return this.enqueue(async () => {
      const approvals = edit(await this.read());
      await mkdir(dirname(this.file), { recursive: true });
      await writeFileAtomic(nodeFs, this.file, `${JSON.stringify({ version: 1, approvals }, null, 2)}\n`);
      return approvals;
    });
  }

  private async read(): Promise<McpApprovalWire[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    try {
      return approvalsFileSchema.parse(JSON.parse(text)).approvals;
    } catch {
      if (!this.reported) {
        this.reported = true;
        this.log(
          `[wirebench] ${this.file} is malformed; no MCP command is approved until the next approval replaces it.`,
        );
      }
      return [];
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(op);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function newestFirst(approvals: readonly McpApprovalWire[]): McpApprovalWire[] {
  return [...approvals].sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
}

/** The window a prompt is shown in. */
export interface McpPromptWindow {
  /** Sends the prompt; false when the window is gone and nothing can answer. */
  prompt(event: McpApprovalPromptEvent): boolean;
  /** Calls `gone` once if the window goes away; answers the unsubscribe. */
  onGone(gone: () => void): () => void;
}

/** What {@link McpApprovals} is built with. */
export interface McpApprovalsOptions {
  readonly store: McpApprovalStore;
  /** The window a send with none of its own asks in: the focused one. Absent or undefined: refused. */
  readonly defaultWindow?: () => McpPromptWindow | undefined;
  readonly timeoutMs?: number;
  readonly newId?: () => string;
  readonly now?: () => Date;
}

/** The approval gate: the store, the prompts waiting on their answer, and the approvers sends are lent. */
export class McpApprovals {
  private readonly pending = new Map<string, (answer: McpApprovalAnswerWire) => void>();

  constructor(private readonly options: McpApprovalsOptions) {}

  list(): Promise<McpApprovalWire[]> {
    return this.options.store.list();
  }

  revoke(fingerprint: string): Promise<McpApprovalWire[]> {
    return this.options.store.revoke(fingerprint);
  }

  /** Answers the prompt `promptId`; an unknown or already answered one is ignored. */
  answer(promptId: string, answer: McpApprovalAnswerWire): void {
    this.pending.get(promptId)?.(answer);
  }

  /**
   * What a send lends the engine as `approveCommand`: an approved fingerprint passes, anything else
   * is asked in `window` (else the default one). With `run`, each fingerprint is asked once for the
   * whole run and its answer kept in the memo.
   */
  approver(window?: McpPromptWindow, run?: McpRunApprovals): CommandApprover {
    return async (request) => {
      if (await this.options.store.has(request.fingerprint)) return true;
      if (run === undefined) return this.ask(window, request);
      const known = run.get(request.fingerprint);
      if (known !== undefined) return known;
      const asking = this.ask(window, request);
      run.set(request.fingerprint, asking);
      return asking;
    };
  }

  /** An approver for one run: a fresh memo, asked in the default window. */
  forRun(window?: McpPromptWindow): CommandApprover {
    return this.approver(window, new Map());
  }

  private ask(window: McpPromptWindow | undefined, request: CommandApprovalRequest): Promise<boolean> {
    const target = window ?? this.options.defaultWindow?.();
    if (target === undefined) return Promise.resolve(false);
    const promptId = (this.options.newId ?? randomUUID)();
    return new Promise<boolean>((resolve) => {
      let unsubscribe = (): void => undefined;
      const timer = setTimeout(() => {
        settle('cancel');
      }, this.options.timeoutMs ?? MCP_APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      const settle = (answer: McpApprovalAnswerWire): void => {
        if (!this.pending.has(promptId)) return;
        this.pending.delete(promptId);
        clearTimeout(timer);
        unsubscribe();
        if (answer !== 'always') {
          resolve(answer === 'once');
          return;
        }
        // Approved either way: a store that cannot be written only means the next send asks again.
        this.options.store
          .add({
            fingerprint: request.fingerprint,
            display: request.display,
            serverName: request.serverName,
            approvedAt: (this.options.now ?? (() => new Date()))().toISOString(),
          })
          .catch((error: unknown) => {
            console.warn(
              `[mcp] the approval could not be kept: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            resolve(true);
          });
      };
      this.pending.set(promptId, settle);
      unsubscribe = target.onGone(() => {
        settle('cancel');
      });
      const shown = target.prompt({
        promptId,
        serverName: request.serverName,
        fingerprint: request.fingerprint,
        display: request.display,
        cwd: request.cwd,
        envNames: [...request.envNames],
      });
      if (!shown) settle('cancel');
    });
  }
}
