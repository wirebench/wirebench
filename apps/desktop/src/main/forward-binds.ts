import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { nodeFs, writeFileAtomic } from '@wirebench/engine';

/** One network bind the user confirmed on this machine; a changed `bind` asks again. */
export interface BindKey {
  readonly workspaceId: string;
  readonly hostId: string;
  readonly ruleId: string;
  readonly bind: string;
}

/**
 * `userData/ssh-forward-binds.json`: the network binds confirmed on this machine (spec R3). Per machine like
 * the trusted host keys, never in the workspace tree, so a shared `hosts.yaml` cannot carry a confirmation.
 */
export interface ForwardBinds {
  isConfirmed(key: BindKey): Promise<boolean>;
  confirm(key: BindKey): Promise<void>;
}

const fileSchema = z.object({
  binds: z.array(z.object({ workspaceId: z.string(), hostId: z.string(), ruleId: z.string(), bind: z.string() })),
});

const same = (a: BindKey, b: BindKey): boolean =>
  a.workspaceId === b.workspaceId && a.hostId === b.hostId && a.ruleId === b.ruleId && a.bind === b.bind;

/**
 * A missing file confirms nothing. A malformed one confirms nothing either, is reported, and is left as it is
 * until the next confirm writes a fresh file.
 */
export function createForwardBinds(
  file: string,
  options: { readonly report?: (message: string) => void } = {},
): ForwardBinds {
  /** Confirms read, change and write the file one at a time, so none is lost. */
  let queue: Promise<void> = Promise.resolve();

  const read = async (): Promise<{ binds: BindKey[]; malformed: boolean }> => {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { binds: [], malformed: false };
      throw error;
    }
    try {
      return { binds: fileSchema.parse(JSON.parse(text)).binds, malformed: false };
    } catch {
      return { binds: [], malformed: true };
    }
  };

  return {
    async isConfirmed(key) {
      const { binds, malformed } = await read();
      if (malformed) options.report?.(`The confirmed network binds file is malformed and was ignored: ${file}`);
      return binds.some((b) => same(b, key));
    },
    confirm(key) {
      const run = queue.then(async () => {
        const { binds } = await read();
        if (binds.some((b) => same(b, key))) return;
        const entry: BindKey = { workspaceId: key.workspaceId, hostId: key.hostId, ruleId: key.ruleId, bind: key.bind };
        await writeFileAtomic(nodeFs, file, `${JSON.stringify({ binds: [...binds, entry] }, null, 2)}\n`);
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
