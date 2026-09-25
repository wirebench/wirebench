import { describe, expect, it } from 'vitest';
import {
  assertTreePath,
  describeTreePath,
  isTreePath,
  MACHINE_LOCAL_PATHS,
  MAX_TREE_PATH_LENGTH,
  TREE_ITEMS,
  WirebenchError,
} from '../../../src/index.js';

/** `projects/` plus enough of a name to make the whole path `length` characters. */
const pathOfLength = (length: number): string => `projects/${'p'.repeat(length - 'projects/'.length)}`;

describe('tree paths (server-sync §3.2)', () => {
  it('names the tree items and the machine-local names', () => {
    expect([...TREE_ITEMS]).toEqual(['workspace.yaml', 'environments', 'projects', '.gitattributes']);
    expect([...MACHINE_LOCAL_PATHS]).toEqual(['share.yaml', 'local.yaml', 'unsaved']);
    expect(MAX_TREE_PATH_LENGTH).toBe(512);
  });

  it.each([
    ['the manifest', 'workspace.yaml'],
    ['the attributes file', '.gitattributes'],
    ['an environment', 'environments/qa.yaml'],
    ['a project manifest', 'projects/billing/wirebench.yaml'],
    ['a request', 'projects/w/interfaces/i/operations/o/GetWeather.request.yaml'],
    ['an attachment', 'projects/w/attachments/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
    ['a dot file that is not .git', 'projects/w/.gitkeep'],
    ['a non-ASCII name with a space', 'projects/w/Ünïcode name.yaml'],
    ['a path of exactly 512 characters', pathOfLength(MAX_TREE_PATH_LENGTH)],
  ])('accepts %s and returns it unchanged', (_name, path) => {
    expect(assertTreePath(path)).toBe(path);
    expect(isTreePath(path)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    [pathOfLength(MAX_TREE_PATH_LENGTH + 1), 'too-long'],
    ['projects/p/a\nb.yaml', 'control-character'],
    ['projects/p/a\0b.yaml', 'control-character'],
    ['projects\\p\\wirebench.yaml', 'backslash'],
    ['/workspace.yaml', 'absolute'],
    ['C:/projects/p/wirebench.yaml', 'absolute'],
    ['projects//wirebench.yaml', 'empty-segment'],
    ['projects/p/', 'empty-segment'],
    ['./workspace.yaml', 'dot-segment'],
    ['projects/p/../../share.yaml', 'dot-segment'],
    ['../outside.yaml', 'dot-segment'],
    ['.git/config', 'git-segment'],
    ['projects/p/.git/hooks/post-update', 'git-segment'],
    ['projects/p/.GIT/config', 'git-segment'],
    ['projects/p/.git. /config', 'git-segment'],
    ['projects/p/git~1/config', 'git-segment'],
    ['projects/p/.git::$INDEX_ALLOCATION/config', 'git-segment'],
    ['projects/p/.git:/config', 'git-segment'],
    ['projects/p/git~1:x/config', 'git-segment'],
    ['share.yaml', 'machine-local'],
    ['local.yaml', 'machine-local'],
    ['unsaved/01J8ZC5Q0V7R3T9XK2M4N6P8QA.json', 'machine-local'],
    ['tree/workspace.yaml', 'not-in-tree'],
    ['README.md', 'not-in-tree'],
    ['Projects/p/wirebench.yaml', 'not-in-tree'],
    ['workspace.yaml/x', 'not-a-file'],
    ['.gitattributes/x', 'not-a-file'],
    ['projects', 'not-a-file'],
    ['environments', 'not-a-file'],
  ])('refuses %j (%s) with sync-path-refused', (path, reason) => {
    let caught: unknown;
    try {
      assertTreePath(path);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WirebenchError);
    expect(caught).toMatchObject({ code: 'sync-path-refused', details: { reason } });
    expect(isTreePath(path)).toBe(false);
  });

  it('keeps a refused path in details, cut to the length limit', () => {
    const long = pathOfLength(4000);
    expect(() => assertTreePath(long)).toThrow(WirebenchError);
    try {
      assertTreePath(long);
    } catch (error) {
      const path = (error as WirebenchError).details?.['path'];
      expect(path).toBe(long.slice(0, MAX_TREE_PATH_LENGTH));
    }
  });

  it('accepts every path a commit message describes as a workspace entity', () => {
    for (const path of [
      'workspace.yaml',
      'environments/qa.yaml',
      'projects/billing/wirebench.yaml',
      'projects/w/interfaces/i/interface.yaml',
      'projects/w/interfaces/i/operations/o/GetWeather.request.yaml',
    ]) {
      expect(describeTreePath(path).kind).not.toBe('other');
      expect(isTreePath(path)).toBe(true);
    }
  });
});
