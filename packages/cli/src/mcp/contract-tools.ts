/**
 * The contract tools of one `wirebench mcp` process (#33 spec §6): derived at start (refused above
 * the cap), rebuilt when the project folder changes, and announced to every session when the names,
 * descriptions or schemas differ. Every session reads the same set. Every note and warning goes
 * through `OpsBase.warn` (stderr), never stdout.
 */
import { watch } from 'node:fs';
import type { OpsBase } from '../ops/context.js';
import { capMessage, deriveContractTools } from '../ops/contract-tools.js';
import type { ContractToolSet } from '../ops/contract-tools.js';
import { OpsError, toOpsError } from '../ops/errors.js';
import { openProject } from '../ops/project.js';

export interface ProjectWatch {
  close(): void;
}

/** `onError` hears a watch that has stopped: no `onChange` follows it. */
export type WatchProject = (dir: string, onChange: () => void, onError: (error: Error) => void) => ProjectWatch;

/** Every change under the project folder, `.git` left out. */
export const watchProjectDir: WatchProject = (dir, onChange, onError) => {
  const watcher = watch(dir, { recursive: true }, (_event, file) => {
    const name = typeof file === 'string' ? file : '';
    if (name.split(/[\\/]/)[0] !== '.git') {
      onChange();
    }
  });
  // A watch error (the folder removed, a handle limit) must not end the process; the last set stays.
  watcher.on('error', onError);
  return { close: () => watcher.close() };
};

export interface ContractToolsHost {
  current(): ContractToolSet;
  /** Called after a rebuild that changed what `tools/list` shows; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Resolves once no rebuild is waiting or running. */
  whenSettled(): Promise<void>;
  close(): void;
}

export interface StartContractToolsOptions {
  /** `--tools`: absent for all, empty for none. */
  readonly containers?: readonly string[];
  readonly watch?: WatchProject;
  readonly debounceMs?: number;
}

export const WATCH_DEBOUNCE_MS = 500;

const EMPTY: ContractToolSet = { tools: [], counts: {}, total: 0, overCap: false, notes: [] };

/** What `tools/list` shows of the set: a change here, and only here, is announced. */
function signatureOf(set: ContractToolSet): string {
  return JSON.stringify(set.tools.map((tool) => [tool.name, tool.description, tool.inputSchema]));
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * @throws OpsError `too-many-tools` above the cap, `container-not-found` for an unknown `--tools` name,
 *   and `openProject`'s codes
 */
export async function startContractTools(
  base: OpsBase,
  options: StartContractToolsOptions = {},
): Promise<ContractToolsHost> {
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const derive = async (): Promise<ContractToolSet> => {
    const { project } = await openProject(base);
    const derived = await deriveContractTools(project, {
      projectDir: base.projectDir,
      gates: base.gates,
      ...(options.containers !== undefined ? { containers: options.containers } : {}),
    });
    for (const note of derived.notes) {
      base.warn(note);
    }
    return derived;
  };

  let set = await derive();
  if (set.overCap) {
    throw new OpsError('too-many-tools', capMessage(set), { counts: set.counts });
  }
  let signature = signatureOf(set);
  const listeners = new Set<() => void>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  /** Resolved when the rebuild the pending timer will start has finished. */
  let pending: Deferred | undefined;
  let running: Promise<void> = Promise.resolve();

  const announce = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        // One broken session must not keep the others, or the next rebuild, from hearing of a change.
        base.warn(`contract tools: a change listener failed: ${toOpsError(error).message}`);
      }
    }
  };

  const rebuild = async (): Promise<void> => {
    if (closed) {
      return;
    }
    try {
      const next = await derive();
      if (next.overCap) {
        base.warn(`${capMessage(next)}. The contract tools are withdrawn until the count is under the cap.`);
      }
      set = next;
    } catch (error) {
      const failure = toOpsError(error);
      if (failure.code !== 'container-not-found') {
        // A project half-written: keep serving the last good set.
        base.warn(`contract tools not rebuilt: ${failure.code}: ${failure.message}`);
        return;
      }
      base.warn(`${failure.message}; no contract tools are served`);
      set = EMPTY;
    }
    const next = signatureOf(set);
    if (next !== signature && !closed) {
      signature = next;
      announce();
    }
  };

  const schedule = (): void => {
    if (closed) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    pending ??= deferred();
    timer = setTimeout(() => {
      timer = undefined;
      const done = pending;
      pending = undefined;
      running = running
        .then(rebuild)
        // `rebuild` catches its own failures; only a throwing `warn` lands here, and must not stop the chain.
        .catch(() => undefined)
        .finally(() => done?.resolve());
    }, debounceMs);
  };
  let watchFailed = false;
  const watchFailure = (error: Error): void => {
    if (watchFailed || closed) {
      return;
    }
    watchFailed = true;
    // Spec §6 keeps the list current; when it no longer can, say so once and keep serving the last set.
    base.warn(`wirebench mcp: contract tools no longer follow project changes: ${error.message}`);
  };
  const watcher = (options.watch ?? watchProjectDir)(base.projectDir, schedule, watchFailure);

  return {
    current: () => set,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    whenSettled: async () => {
      for (;;) {
        const seen = running;
        await (pending?.promise ?? seen);
        await running;
        if (pending === undefined && running === seen) {
          return;
        }
      }
    },
    close: () => {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending?.resolve();
      pending = undefined;
      watcher.close();
      listeners.clear();
    },
  };
}
