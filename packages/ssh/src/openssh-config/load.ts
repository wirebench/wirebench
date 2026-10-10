import { posix, win32 } from 'node:path';
import { lexSshConfig } from './lex.js';
import type { SshConfigLine, SshConfigProblem } from './types.js';

/** File access for the loader; the caller guards type and size. Errors carry Node's `code`. */
export interface SshConfigIo {
  /** Expands `~` and `%d`, and anchors relative `Include` paths at `<home>/.ssh`. */
  readonly home: string;
  readFile(path: string): Promise<string>;
  /** Absolute paths matching an absolute glob pattern, in any order. */
  glob(pattern: string): Promise<readonly string[]>;
}

export interface SshConfigBlock {
  readonly kind: 'global' | 'host' | 'match';
  /** `Host` patterns; empty for `global` and `match`. */
  readonly patterns: readonly string[];
  readonly lines: readonly SshConfigLine[];
  readonly at: { readonly file: string; readonly line: number };
}

export interface SshConfigDocument {
  /** The home directory the paths were expanded against. */
  readonly home: string;
  readonly blocks: readonly SshConfigBlock[];
  /** Lines and files that could not be used (warnings). */
  readonly problems: readonly SshConfigProblem[];
  /** What the loader did that the user should know (an Include with no target). */
  readonly notes: readonly string[];
}

const GLOB = /[*?[]/;

/** Path rules follow the home directory's shape, not the host's, so a POSIX home behaves the same everywhere. */
export const pathsFor = (home: string): typeof posix => (home.startsWith('/') ? posix : win32);

/** `~/…` when the path is under the home directory; the path as is otherwise. */
export function displayPath(path: string, home: string): string {
  return path === home || path.startsWith(home + pathsFor(home).sep) ? `~${path.slice(home.length)}` : path;
}

export function expandHome(path: string, home: string): string {
  const paths = pathsFor(home);
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith(`~${paths.sep}`)) return paths.join(home, path.slice(2));
  return path;
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

type Marker = { readonly kind: 'resume'; readonly at: { file: string; line: number } };

/**
 * Reads an OpenSSH client config into blocks. `Include` is followed from `path` only (one level); a nested
 * `Include` is reported, not followed. The main file's read error propagates; an included file's is a problem.
 */
export async function loadSshConfig(path: string, io: SshConfigIo): Promise<SshConfigDocument> {
  const paths = pathsFor(io.home);
  const problems: SshConfigProblem[] = [];
  const notes: string[] = [];
  const mainFile = displayPath(path, io.home);
  const main = lexSshConfig(await io.readFile(path), mainFile);
  problems.push(...main.problems);

  const flat: Array<SshConfigLine | Marker> = [];
  for (const line of main.lines) {
    if (line.keyword !== 'include') {
      flat.push(line);
      continue;
    }
    for (const arg of line.args) {
      const target = expandHome(arg, io.home);
      const absolute = paths.isAbsolute(target) ? target : paths.join(io.home, '.ssh', target);
      const files = GLOB.test(absolute) ? [...(await io.glob(absolute))].sort() : [absolute];
      if (files.length === 0) notes.push(`Include ${arg} (${mainFile}:${line.line}) matched no file`);
      for (const file of files) {
        const shown = displayPath(file, io.home);
        let text: string;
        try {
          text = await io.readFile(file);
        } catch (error) {
          const errno = errnoOf(error);
          if (errno === 'ENOENT') notes.push(`Include ${shown} (${mainFile}:${line.line}) does not exist`);
          else problems.push({ file: shown, why: `could not be read (${errno ?? 'unknown error'})` });
          continue;
        }
        const included = lexSshConfig(text, shown);
        problems.push(...included.problems);
        for (const inner of included.lines) {
          if (inner.keyword === 'include') {
            problems.push({ file: shown, line: inner.line, why: 'Include nested more than one level: not followed' });
          } else {
            flat.push(inner);
          }
        }
      }
    }
    // `ssh` restores the block that was active before the Include once the included files end.
    flat.push({ kind: 'resume', at: { file: mainFile, line: line.line } });
  }

  const blocks: Array<{
    kind: SshConfigBlock['kind'];
    patterns: string[];
    lines: SshConfigLine[];
    at: SshConfigBlock['at'];
  }> = [];
  let current = {
    kind: 'global' as SshConfigBlock['kind'],
    patterns: [] as string[],
    lines: [] as SshConfigLine[],
    at: { file: mainFile, line: 1 },
  };
  let outer = current;
  blocks.push(current);
  for (const item of flat) {
    if ('kind' in item) {
      if (current !== outer) {
        current = { ...outer, lines: [], at: item.at };
        blocks.push(current);
      }
      continue;
    }
    if (item.keyword === 'host' || item.keyword === 'match') {
      current = {
        kind: item.keyword,
        patterns: item.keyword === 'host' ? [...item.args] : [],
        lines: [],
        at: { file: item.file, line: item.line },
      };
      blocks.push(current);
      if (item.file === mainFile) outer = current;
      continue;
    }
    current.lines.push(item);
  }
  return { home: io.home, blocks: blocks.filter((b) => b.kind !== 'global' || b.lines.length > 0), problems, notes };
}
