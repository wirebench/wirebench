// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyChanges,
  diffTreeFiles,
  readTreeFiles,
  SERVER_STATE_DIR,
  ServerState,
  treeFileBytes,
  writeTreeFiles,
  type MergeRecord,
  type TreeFile,
} from '../../src/main/sync/server-state.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const AT = '2026-09-25T10:00:00.000Z';
const text = (content: string): TreeFile => ({ encoding: 'utf8', content });

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-server-state-'));
  dir = join(root, SERVER_STATE_DIR);
});
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

/** Writes `data` at the `/`-separated `path` under the temp root, creating folders. */
async function put(path: string, data: string | Buffer): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}

describe('readTreeFiles', () => {
  it('reads the tree items only, with forward-slash keys, and lets UTF-8 validity pick the encoding', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    await put('tree/workspace.yaml', 'name: W\n');
    await put('tree/environments/qa.yaml', 'name: QA\n');
    await put('tree/projects/p/wirebench.yaml', 'id: p\n');
    await put('tree/projects/p/attachments/logo.bin', Buffer.from([0xff, 0x00, 0xfe]));
    await put('tree/projects/p/attachments/bom.txt', bom);
    await put('tree/.gitattributes', '* text=auto\n');
    await put('tree/.git/config', '[core]\n');
    await put('tree/projects/p/.git/HEAD', 'ref: refs/heads/main\n');
    await put('tree/notes.txt', 'not a tree item\n');
    await put('tree/share.yaml', 'kind: server\n');

    const files = await readTreeFiles(join(root, 'tree'));

    expect([...files.keys()].sort()).toEqual([
      '.gitattributes',
      'environments/qa.yaml',
      'projects/p/attachments/bom.txt',
      'projects/p/attachments/logo.bin',
      'projects/p/wirebench.yaml',
      'workspace.yaml',
    ]);
    expect(files.get('projects/p/attachments/logo.bin')).toEqual({ encoding: 'base64', content: '/wD+' });
    expect(files.get('projects/p/attachments/bom.txt')).toEqual(text('\ufeffhi'));
    expect(treeFileBytes(files.get('projects/p/attachments/bom.txt') ?? text(''))).toEqual(bom);
  });

  it('reads a missing tree as empty', async () => {
    expect((await readTreeFiles(join(root, 'nothing-here'))).size).toBe(0);
  });
});

describe('writeTreeFiles', () => {
  it('writes bytes exactly, deletes, prunes emptied folders below the tree items, and refuses a bad path before writing', async () => {
    const tree = join(root, 'tree');
    await writeTreeFiles(
      tree,
      new Map<string, TreeFile | null>([
        ['projects/p/wirebench.yaml', text('id: p\n')],
        ['projects/p/attachments/logo.bin', { encoding: 'base64', content: '/wD+' }],
        ['environments/qa.yaml', text('a\r\nb')],
      ]),
    );
    expect(await readFile(join(tree, 'projects', 'p', 'attachments', 'logo.bin'))).toEqual(
      Buffer.from([0xff, 0x00, 0xfe]),
    );
    expect(await readFile(join(tree, 'environments', 'qa.yaml'), 'utf8')).toBe('a\r\nb');

    await writeTreeFiles(
      tree,
      new Map<string, TreeFile | null>([
        ['projects/p/wirebench.yaml', null],
        ['projects/p/attachments/logo.bin', null],
      ]),
    );
    // p/ and p/attachments/ are gone; projects/ itself stays.
    expect(await readdir(join(tree, 'projects'))).toEqual([]);

    for (const bad of ['../outside.yaml', 'share.yaml', 'projects/p/.git/config']) {
      await expect(
        writeTreeFiles(
          tree,
          new Map([
            ['environments/ok.yaml', text('x')],
            [bad, text('x')],
          ]),
        ),
      ).rejects.toMatchObject({ code: 'sync-path-refused' });
    }
    expect(await readdir(join(tree, 'environments'))).toEqual(['qa.yaml']);
  });
});

describe('diffTreeFiles and applyChanges', () => {
  it('applying the diff gives the after side; a deletion carries null; base64 of valid UTF-8 reads as text', () => {
    const before = new Map<string, TreeFile>([
      ['workspace.yaml', text('name: W\n')],
      ['environments/qa.yaml', text('name: QA\n')],
      ['environments/old.yaml', text('x')],
    ]);
    const after = new Map<string, TreeFile>([
      ['workspace.yaml', text('name: W\n')],
      ['environments/qa.yaml', text('name: QA\nurl: u\n')],
      ['environments/new.bin', { encoding: 'base64', content: '/wD+' }],
    ]);

    const changes = diffTreeFiles(before, after);

    expect(changes).toEqual([
      { path: 'environments/new.bin', encoding: 'base64', content: '/wD+' },
      { path: 'environments/old.yaml', encoding: 'utf8', content: null },
      { path: 'environments/qa.yaml', encoding: 'utf8', content: 'name: QA\nurl: u\n' },
    ]);
    expect(applyChanges(before, changes)).toEqual(after);
    expect(diffTreeFiles(after, after)).toEqual([]);
    expect(
      applyChanges(new Map(), [
        { path: 'workspace.yaml', encoding: 'base64', content: Buffer.from('name: W\n').toString('base64') },
      ]),
    ).toEqual(new Map([['workspace.yaml', text('name: W\n')]]));
    expect(() => applyChanges(before, [{ path: '../x', encoding: 'utf8', content: 'x' }])).toThrow(
      expect.objectContaining({ code: 'sync-path-refused' }),
    );
  });
});

describe('ServerState (§4.2)', () => {
  it('initialize writes the base and a state at head, replacing what was there; update merges a patch', async () => {
    const files = new Map([['workspace.yaml', text('name: W\n')]]);
    const state = await ServerState.initialize(dir, HEAD_A, files);
    expect(await state.read()).toEqual({ version: 1, base: { head: HEAD_A } });
    expect(await state.baseFiles()).toEqual(files);
    expect(await state.pending()).toEqual([]);
    expect(await state.readMerge()).toBeUndefined();

    const next = await state.update({ knownHead: HEAD_B, behind: 2, role: 'viewer', lastSyncAt: AT });
    expect(next).toEqual({
      version: 1,
      base: { head: HEAD_A },
      knownHead: HEAD_B,
      behind: 2,
      role: 'viewer',
      lastSyncAt: AT,
    });
    expect(await new ServerState(dir).read()).toEqual(next);

    const empty = await ServerState.initialize(dir, null, new Map());
    expect(await empty.read()).toEqual({ version: 1, base: { head: null } });
    expect((await empty.baseFiles()).size).toBe(0);
  });

  it('pending commits are NNNN.yaml in order, round-trip any text exactly, and replay over the base', async () => {
    const state = await ServerState.initialize(dir, HEAD_A, new Map([['workspace.yaml', text('name: W\n')]]));
    const nasty = [
      'a\r\nb\r\n',
      '  leading\n\ttab\n',
      'trailing   \n',
      'no newline',
      '',
      '---\n...\n',
      'null',
      '# not a comment',
      'ünïcödé 🚀\n',
      'nul\u0000byte',
      'key: value\n',
    ];
    const first = await state.appendPending({
      subject: 'Add environments',
      at: AT,
      changes: nasty.map((content, index) => ({
        path: `environments/e${String(index)}.yaml`,
        encoding: 'utf8' as const,
        content,
      })),
    });
    const second = await state.appendPending({
      subject: 'Remove e0',
      at: AT,
      changes: [{ path: 'environments/e0.yaml', encoding: 'utf8', content: null }],
    });

    expect(first.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await readdir(join(dir, 'pending'))).sort()).toEqual(['0001.yaml', '0002.yaml']);
    expect(await new ServerState(dir).pending()).toEqual([first, second]);
    const committed = await state.committedFiles();
    expect(committed.has('environments/e0.yaml')).toBe(false);
    nasty.forEach((content, index) => {
      if (index > 0) expect(committed.get(`environments/e${String(index)}.yaml`)).toEqual(text(content));
    });
    expect(committed.get('workspace.yaml')).toEqual(text('name: W\n'));
    await expect(
      state.appendPending({ subject: 'x', at: AT, changes: [{ path: 'share.yaml', encoding: 'utf8', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'sync-path-refused' });
  });

  it('advanceBase replaces base/, moves the base and known heads, and clears pending only when asked', async () => {
    const state = await ServerState.initialize(
      dir,
      HEAD_A,
      new Map([
        ['workspace.yaml', text('v1')],
        ['environments/old.yaml', text('x')],
      ]),
    );
    await state.update({ knownHead: HEAD_B, behind: 1 });
    await state.appendPending({
      subject: 'Local',
      at: AT,
      changes: [{ path: 'environments/qa.yaml', encoding: 'utf8', content: 'QA' }],
    });

    await state.advanceBase(HEAD_B, new Map([['workspace.yaml', text('v2')]]), { clearPending: false });
    expect(await state.read()).toMatchObject({ base: { head: HEAD_B }, knownHead: HEAD_B, behind: 0 });
    expect(await state.baseFiles()).toEqual(new Map([['workspace.yaml', text('v2')]]));
    expect(await state.pending()).toHaveLength(1);
    expect((await state.committedFiles()).get('environments/qa.yaml')).toEqual(text('QA'));

    await state.advanceBase(HEAD_C, await state.committedFiles(), { clearPending: true });
    expect(await state.read()).toMatchObject({ base: { head: HEAD_C }, knownHead: HEAD_C, behind: 0 });
    expect(await state.pending()).toEqual([]);
    expect((await state.baseFiles()).get('environments/qa.yaml')).toEqual(text('QA'));
    expect((await readdir(dir)).sort()).toEqual(['base', 'state.yaml']);
  });

  it('an advance interrupted after its journal is finished on the next use; one interrupted before it is discarded', async () => {
    await ServerState.initialize(dir, HEAD_A, new Map([['workspace.yaml', text('v1')]]));
    await new ServerState(dir).appendPending({
      subject: 'Local',
      at: AT,
      changes: [{ path: 'environments/qa.yaml', encoding: 'utf8', content: 'QA' }],
    });
    // What advanceBase leaves when the process dies right after writing the journal:
    await put(`${SERVER_STATE_DIR}/base.next/workspace.yaml`, 'v2');
    await writeFile(join(dir, 'advance.yaml'), `head: ${HEAD_B}\nclearPending: true\n`);

    const reopened = new ServerState(dir);
    expect(await reopened.read()).toMatchObject({ base: { head: HEAD_B }, knownHead: HEAD_B, behind: 0 });
    expect(await reopened.baseFiles()).toEqual(new Map([['workspace.yaml', text('v2')]]));
    expect(await reopened.pending()).toEqual([]);

    // …and what it leaves when the process dies while base.next/ is still being written:
    await put(`${SERVER_STATE_DIR}/base.next/workspace.yaml`, 'half');
    const again = new ServerState(dir);
    expect(await again.read()).toMatchObject({ base: { head: HEAD_B } });
    expect(await again.baseFiles()).toEqual(new Map([['workspace.yaml', text('v2')]]));
    expect((await readdir(dir)).sort()).toEqual(['base', 'state.yaml']);
  });

  it('the merge record round-trips and clears', async () => {
    const state = await ServerState.initialize(dir, HEAD_A, new Map());
    const record: MergeRecord = {
      conflicts: ['environments/qa.yaml'],
      mine: { 'environments/qa.yaml': text('mine') },
      theirs: { 'environments/qa.yaml': text('theirs'), 'workspace.yaml': text('W') },
      preMerge: { 'environments/qa.yaml': text('mine') },
      mergePaths: ['environments/qa.yaml', 'workspace.yaml'],
    };
    await state.writeMerge(record);
    expect(await new ServerState(dir).readMerge()).toEqual(record);
    await state.clearMerge();
    expect(await state.readMerge()).toBeUndefined();
  });

  it('reports sync-state-corrupt for a missing, unparsable or invalid state file', async () => {
    const cases: readonly (readonly [string, string | undefined, (s: ServerState) => Promise<unknown>])[] = [
      ['state.yaml', 'version: [', (s) => s.read()],
      ['state.yaml', 'version: 2\nbase:\n  head: null\n', (s) => s.read()],
      ['state.yaml', "version: 1\nbase:\n  head: '--upload-pack=x'\n", (s) => s.read()],
      ['state.yaml', undefined, (s) => s.read()],
      ['pending/0001.yaml', 'id: x\nsubject: s\n', (s) => s.pending()],
      ['merge.yaml', 'conflicts: nope\n', (s) => s.readMerge()],
      ['advance.yaml', 'head: 42\n', (s) => s.baseFiles()],
    ];
    for (const [file, content, use] of cases) {
      await ServerState.initialize(dir, HEAD_A, new Map());
      if (content === undefined) await rm(join(dir, file));
      else await put(`${SERVER_STATE_DIR}/${file}`, content);
      await expect(use(new ServerState(dir))).rejects.toMatchObject({ code: 'sync-state-corrupt', details: { file } });
    }
  });
});
