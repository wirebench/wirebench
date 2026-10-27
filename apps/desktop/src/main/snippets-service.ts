import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WirebenchError, WorkspaceError, nodeFs, writeFileAtomic } from '@wirebench/engine';
import {
  EMPTY_SNIPPETS_FILE,
  SNIPPETS_FILE_NAME,
  SshModelError,
  listSnippets,
  parseSnippetsFile,
  serializeSnippetsFile,
} from '@wirebench/ssh';
import type { Snippet, SnippetListItem, SnippetsFile } from '@wirebench/ssh';
import type {
  SnippetListItemWire,
  SnippetProblemWire,
  SnippetWire,
  SnippetsFileWire,
  SshListSnippetsResponse,
} from '@wirebench/wire/snippets-wire';
import { asWirebenchError } from './hosts-service.js';

export const SNIPPETS_FILE = SNIPPETS_FILE_NAME;

/**
 * Reads and writes the workspace's `snippets.yaml`, beside `hosts.yaml`. Scripts hold `${secret:NAME}` tokens
 * only. A file that does not parse is a problem on the answer, not an exception, so the view can show it.
 */
export class SnippetsService {
  private cache: { dir: string; file: SnippetsFile; problems: SnippetProblemWire[] } | undefined;

  constructor(private readonly deps: { treeDir: () => string | undefined; onChanged?: () => void }) {}

  /** Forget what was read; the next call reads the disk again (the workspace or the file changed). */
  invalidate(): void {
    this.cache = undefined;
  }

  /** The last parsed model, if one has been read for the open workspace. */
  current(): SnippetsFile | undefined {
    return this.cache?.file;
  }

  async list(): Promise<SshListSnippetsResponse> {
    const { file, problems } = await this.load();
    return { file: fileToWire(file), snippets: listSnippets(file).map(itemToWire), problems };
  }

  /**
   * Validates and writes the whole file atomically.
   * @throws WirebenchError with the model's code when the file is invalid; `workspace-not-open` without one.
   */
  async save(wire: SnippetsFileWire): Promise<SshListSnippetsResponse> {
    const dir = this.requireDir();
    let text: string;
    let file: SnippetsFile;
    try {
      text = serializeSnippetsFile(fileFromWire(wire));
      file = parseSnippetsFile(text); // the round trip is the full validation
    } catch (error) {
      throw asWirebenchError(error);
    }
    await writeFileAtomic(nodeFs, join(dir, SNIPPETS_FILE), text);
    this.cache = { dir, file, problems: [] };
    this.deps.onChanged?.();
    return this.list();
  }

  private requireDir(): string {
    const dir = this.deps.treeDir();
    if (!dir) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    return dir;
  }

  private async load(): Promise<{ dir: string; file: SnippetsFile; problems: SnippetProblemWire[] }> {
    const dir = this.requireDir();
    if (this.cache?.dir === dir) return this.cache;
    let text = '';
    try {
      text = await readFile(join(dir, SNIPPETS_FILE), 'utf8');
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno !== 'ENOENT') {
        // Raw, it would cross IPC as `internal-error`. `details.path` is a location inside the file, so not set.
        throw new WirebenchError(
          'snippets-invalid',
          `${SNIPPETS_FILE} could not be read (${errno ?? 'unknown error'})`,
          {
            details: { file: SNIPPETS_FILE, ...(errno === undefined ? {} : { errno }) },
            cause: error,
          },
        );
      }
    }
    let file = EMPTY_SNIPPETS_FILE;
    const problems: SnippetProblemWire[] = [];
    try {
      file = parseSnippetsFile(text);
    } catch (error) {
      if (!(error instanceof SshModelError)) throw error;
      const path = error.details['path'];
      problems.push({ code: error.code, message: error.message, ...(typeof path === 'string' ? { path } : {}) });
    }
    this.cache = { dir, file, problems };
    return this.cache;
  }
}

/**
 * One window's snippets file (each window holds its own workspace, so each has its own cache). `treeDir` is
 * that window's workspace's tree root; its `workspace-not-found` means none is open.
 */
export function windowSnippets(treeDir: () => string, onChanged: () => void): SnippetsService {
  return new SnippetsService({
    treeDir: () => {
      try {
        return treeDir();
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'workspace-not-found') return undefined; // none open
        throw error;
      }
    },
    onChanged,
  });
}

const snippetToWire = (s: Snippet): SnippetWire => ({
  ...s,
  tags: [...s.tags],
  variables: s.variables.map((v) => ({ ...v })),
});
const fileToWire = (f: SnippetsFile): SnippetsFileWire => ({
  version: 1,
  packages: f.packages.map((p) => ({ id: p.id, name: p.name, snippets: p.snippets.map(snippetToWire) })),
  snippets: f.snippets.map(snippetToWire),
});
const snippetFromWire = (s: SnippetWire): Snippet => ({
  id: s.id,
  name: s.name,
  ...(s.description === undefined ? {} : { description: s.description }),
  tags: s.tags,
  variables: s.variables.map((v) => ({
    name: v.name,
    ...(v.label === undefined ? {} : { label: v.label }),
    ...(v.default === undefined ? {} : { default: v.default }),
  })),
  script: s.script,
  enter: s.enter,
  confirm: s.confirm,
});
const fileFromWire = (f: SnippetsFileWire): SnippetsFile => ({
  version: 1,
  packages: f.packages.map((p) => ({ id: p.id, name: p.name, snippets: p.snippets.map(snippetFromWire) })),
  snippets: f.snippets.map(snippetFromWire),
});
const itemToWire = (item: SnippetListItem): SnippetListItemWire => ({
  ...item,
  tags: [...item.tags],
  variables: item.variables.map((v) => ({ ...v })),
  secrets: [...item.secrets],
});
