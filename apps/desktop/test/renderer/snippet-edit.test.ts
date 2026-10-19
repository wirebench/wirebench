import { describe, expect, it } from 'vitest';
import {
  addPackage,
  declareVariable,
  duplicateSnippet,
  freeSnippetId,
  moveSnippet,
  removePackage,
  removeSnippet,
  renamePackage,
  scriptOf,
  scriptTokens,
  undeclaredTokens,
  upsertSnippet,
} from '../../src/renderer/features/ssh/snippets/snippet-edit.js';
import type { SnippetWire, SnippetsFileWire } from '../../src/shared/snippets-wire.js';

const s = (id: string, over: Partial<SnippetWire> = {}): SnippetWire => ({
  id,
  name: id,
  tags: [],
  variables: [],
  script: 'ls',
  enter: true,
  confirm: false,
  ...over,
});

const FILE: SnippetsFileWire = {
  version: 1,
  packages: [
    { id: 'deploy', name: 'Deploy', snippets: [s('a'), s('b')] },
    { id: 'logs', name: 'Logs', snippets: [] },
  ],
  snippets: [s('c')],
};
const ids = (file: SnippetsFileWire) => ({
  deploy: file.packages.find((p) => p.id === 'deploy')?.snippets.map((x) => x.id),
  logs: file.packages.find((p) => p.id === 'logs')?.snippets.map((x) => x.id),
  root: file.snippets.map((x) => x.id),
});

describe('upsertSnippet', () => {
  it('replaces a snippet in place when it stays in its package', () => {
    const next = upsertSnippet(FILE, 'deploy', s('a', { name: 'A2' }));
    expect(ids(next).deploy).toEqual(['a', 'b']);
    expect(next.packages[0]?.snippets[0]?.name).toBe('A2');
    expect(FILE.packages[0]?.snippets[0]?.name).toBe('a'); // the input is left alone
  });
  it('appends a new snippet to the package, or to no package', () => {
    expect(ids(upsertSnippet(FILE, 'logs', s('d'))).logs).toEqual(['d']);
    expect(ids(upsertSnippet(FILE, undefined, s('d'))).root).toEqual(['c', 'd']);
  });
  it('moves an existing snippet when its package changes', () => {
    const next = upsertSnippet(FILE, undefined, s('a', { name: 'moved' }));
    expect(ids(next)).toEqual({ deploy: ['b'], logs: [], root: ['c', 'a'] });
  });
});

describe('moveSnippet and removeSnippet', () => {
  it('moves to the end of another package, and is a no-op for an unknown id', () => {
    expect(ids(moveSnippet(FILE, 'c', 'logs'))).toEqual({ deploy: ['a', 'b'], logs: ['c'], root: [] });
    expect(moveSnippet(FILE, 'nope', 'logs')).toEqual(FILE);
  });
  it('removes wherever it is', () => {
    expect(ids(removeSnippet(FILE, 'b'))).toEqual({ deploy: ['a'], logs: [], root: ['c'] });
    expect(ids(removeSnippet(FILE, 'c')).root).toEqual([]);
  });
});

describe('duplicateSnippet', () => {
  it('places x-copy after the original, then x-copy-2', () => {
    const first = duplicateSnippet(FILE, 'a');
    expect(first.id).toBe('a-copy');
    expect(ids(first.file).deploy).toEqual(['a', 'a-copy', 'b']);
    expect(first.file.packages[0]?.snippets[1]?.name).toBe('a copy');
    const second = duplicateSnippet(first.file, 'a');
    expect(second.id).toBe('a-copy-2');
    expect(ids(second.file).deploy).toEqual(['a', 'a-copy-2', 'a-copy', 'b']);
  });
});

describe('packages', () => {
  it('addPackage slugs the name and keeps the id unique across packages and snippets', () => {
    const added = addPackage(FILE, '  Ops & Tools! ');
    expect(added.id).toBe('ops-tools');
    expect(added.file.packages.at(-1)).toEqual({ id: 'ops-tools', name: 'Ops & Tools!', snippets: [] });
    expect(addPackage(FILE, 'Deploy').id).toBe('deploy-2');
    expect(addPackage(FILE, 'A').id).toBe('a-2'); // a snippet holds `a`
    expect(addPackage(FILE, '!!!').id).toBe('package');
  });
  it('renamePackage changes the name only', () => {
    expect(renamePackage(FILE, 'logs', 'Journal').packages[1]).toEqual({ id: 'logs', name: 'Journal', snippets: [] });
  });
  it('removePackage removes an empty package and refuses one that holds snippets', () => {
    expect(removePackage(FILE, 'logs').packages.map((p) => p.id)).toEqual(['deploy']);
    expect(() => removePackage(FILE, 'deploy')).toThrow('package is not empty');
  });
  it('freeSnippetId slugs a name into an id no package or snippet uses', () => {
    expect(freeSnippetId(FILE, 'Restart API')).toBe('restart-api');
    expect(freeSnippetId(FILE, 'Deploy')).toBe('deploy-2');
    expect(freeSnippetId(FILE, '')).toBe('snippet');
  });
});

describe('script tokens', () => {
  it('undeclaredTokens lists ${name} tokens neither declared nor secret, once each, in order', () => {
    expect(
      undeclaredTokens('echo ${service} ${HOME} ${secret:tok} ${service} ${lines} $USER ${1bad}', [{ name: 'lines' }]),
    ).toEqual(['service', 'HOME']);
  });
  it('scriptTokens tells declared variables, secrets and other ${…} apart', () => {
    expect(scriptTokens('a ${x} ${secret:k} ${y} ${a:-b}', [{ name: 'x' }])).toEqual([
      { start: 2, end: 6, kind: 'variable' },
      { start: 7, end: 18, kind: 'secret' },
      { start: 19, end: 23, kind: 'shell' },
      { start: 24, end: 31, kind: 'shell' },
    ]);
  });
});

describe('declareVariable and scriptOf (#717)', () => {
  it('adds the name after the variables a snippet has, in a package or not', () => {
    const next = declareVariable(declareVariable(FILE, 'b', 'dir'), 'c', 'host');
    expect(next.packages[0]?.snippets[1]?.variables).toEqual([{ name: 'dir' }]);
    expect(next.snippets[0]?.variables).toEqual([{ name: 'host' }]);
    expect(FILE.packages[0]?.snippets[1]?.variables).toEqual([]);
  });

  it('leaves the file alone for a declared name or an unknown snippet', () => {
    const once = declareVariable(FILE, 'a', 'dir');
    expect(declareVariable(once, 'a', 'dir')).toBe(once);
    expect(declareVariable(FILE, 'nope', 'dir')).toBe(FILE);
  });

  it('reads a snippet script by id', () => {
    expect(scriptOf(FILE, 'c')).toBe('ls');
    expect(scriptOf(FILE, 'nope')).toBeUndefined();
  });
});
