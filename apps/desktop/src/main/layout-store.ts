import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WirebenchError, nodeFs, writeFileAtomic } from '@wirebench/engine';
import { layoutNodeWireSchema, layoutsFileSchema } from '@wirebench/wire/layout-wire';
import type { LayoutNodeWire, LayoutWire } from '@wirebench/wire/layout-wire';

export const LAYOUTS_FILE = 'ssh-layouts.json';

interface LayoutsFile {
  version: 1;
  workspaces: Record<string, LayoutWire[]>;
}

const empty = (): LayoutsFile => ({ version: 1, workspaces: {} });

/**
 * The saved terminal layouts of this machine (`userData/ssh-layouts.json`), one list per workspace. They never
 * reach the workspace tree, sync or a team. Writes are atomic and go one at a time, each reading the file
 * afresh, so two saves both land. A missing file is an empty store; a malformed one lists empty, is reported
 * once, and is left on disk until the next save replaces it.
 */
export class LayoutStore {
  private queue: Promise<unknown> = Promise.resolve();
  private reported = false;

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  list(workspaceId: string): Promise<LayoutWire[]> {
    return this.enqueue(async () => (await this.read()).workspaces[workspaceId] ?? []);
  }

  /**
   * Creates a layout (no `id`) or replaces the named one's name and tree.
   * @throws WirebenchError `ssh-layout-invalid`, `ssh-layout-name-taken`, `ssh-layout-unknown`
   */
  async save(workspaceId: string, input: { id?: string; name: string; root: LayoutNodeWire }): Promise<LayoutWire> {
    const name = checkName(input.name);
    const parsed = layoutNodeWireSchema.safeParse(input.root);
    if (!parsed.success) {
      const problem = parsed.error.issues[0];
      throw new WirebenchError('ssh-layout-invalid', `The layout is not valid: ${problem?.message ?? 'malformed'}`, {
        details: { path: problem?.path.join('.') ?? '' },
      });
    }
    const { id } = input;
    const layout: LayoutWire = { id: id ?? randomUUID(), name, root: parsed.data };
    await this.change(workspaceId, (layouts) =>
      id === undefined ? [...layouts, layout] : replace(layouts, id, () => layout),
    );
    return layout;
  }

  /** @throws WirebenchError `ssh-layout-invalid`, `ssh-layout-name-taken`, `ssh-layout-unknown` */
  async rename(workspaceId: string, id: string, name: string): Promise<void> {
    const checked = checkName(name);
    await this.change(workspaceId, (layouts) => replace(layouts, id, (old) => ({ ...old, name: checked })));
  }

  /** Deleting a layout that is already gone does nothing. */
  async delete(workspaceId: string, id: string): Promise<void> {
    await this.change(workspaceId, (layouts) => layouts.filter((layout) => layout.id !== id));
  }

  /** Reads, edits the workspace's list, checks its names are unique and writes, all inside the queue. */
  private change(workspaceId: string, edit: (layouts: LayoutWire[]) => LayoutWire[]): Promise<void> {
    return this.enqueue(async () => {
      const data = await this.read();
      const layouts = edit(data.workspaces[workspaceId] ?? []);
      const seen = new Set<string>();
      for (const layout of layouts) {
        const key = layout.name.toLowerCase();
        if (seen.has(key)) {
          throw new WirebenchError('ssh-layout-name-taken', `A layout named "${layout.name}" already exists`, {
            details: { name: layout.name },
          });
        }
        seen.add(key);
      }
      const workspaces = { ...data.workspaces };
      if (layouts.length === 0) delete workspaces[workspaceId];
      else workspaces[workspaceId] = layouts;
      await mkdir(dirname(this.file), { recursive: true });
      await writeFileAtomic(nodeFs, this.file, `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`);
    });
  }

  private async read(): Promise<LayoutsFile> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      return empty();
    }
    try {
      return layoutsFileSchema.parse(JSON.parse(text));
    } catch {
      if (!this.reported) {
        this.reported = true;
        this.log(`[wirebench] ${this.file} is malformed; no layouts are listed until the next save replaces it.`);
      }
      return empty();
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(op);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new WirebenchError('ssh-layout-invalid', 'A layout needs a name');
  return trimmed;
}

/** `layouts` with the one of `id` swapped for `next(old)`. @throws WirebenchError `ssh-layout-unknown` */
function replace(layouts: LayoutWire[], id: string, next: (old: LayoutWire) => LayoutWire): LayoutWire[] {
  if (!layouts.some((layout) => layout.id === id)) {
    throw new WirebenchError('ssh-layout-unknown', 'That layout no longer exists', { details: { id } });
  }
  return layouts.map((layout) => (layout.id === id ? next(layout) : layout));
}
