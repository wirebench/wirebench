// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANIFEST_PATH } from '@wirebench/engine';
import { mergeUnsaved, overlayFs, UnsavedStore } from '../src/main/unsaved-store.js';

const files = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

describe('mergeUnsaved', () => {
  it('keeps the unsaved version of a file only the unsaved side changed', () => {
    const merged = mergeUnsaved(files({ a: '1' }), files({ a: '1' }), files({ a: '2' }));
    expect(Object.fromEntries(merged.files)).toEqual({ a: '2' });
    expect(merged).toMatchObject({ conflicts: [], dropped: [], changed: true });
  });

  it('takes the disk version of a file only disk changed', () => {
    const merged = mergeUnsaved(files({ a: '1' }), files({ a: 'disk' }), files({ a: '1' }));
    expect(Object.fromEntries(merged.files)).toEqual({ a: 'disk' });
    expect(merged.changed).toBe(false);
  });

  it('restores the unsaved version on top when both sides changed, and flags it', () => {
    const merged = mergeUnsaved(files({ a: '1' }), files({ a: 'disk' }), files({ a: 'mine' }));
    expect(merged.files.get('a')).toBe('mine');
    expect(merged.conflicts).toEqual(['a']);
  });

  it('does not flag the same change made on both sides', () => {
    const merged = mergeUnsaved(files({ a: '1' }), files({ a: '2' }), files({ a: '2' }));
    expect(merged).toMatchObject({ conflicts: [], changed: false });
  });

  it('drops an unsaved change to a file that was deleted on disk', () => {
    const merged = mergeUnsaved(files({ a: '1', b: '1' }), files({ b: '1' }), files({ a: 'mine', b: '1' }));
    expect(merged.files.has('a')).toBe(false);
    expect(merged.dropped).toEqual(['a']);
  });

  it('applies an unsaved deletion, but keeps a file that also changed on disk', () => {
    const untouched = mergeUnsaved(files({ a: '1' }), files({ a: '1' }), files({}));
    expect(untouched.files.has('a')).toBe(false);
    const changedOnDisk = mergeUnsaved(files({ a: '1' }), files({ a: 'disk' }), files({}));
    expect(changedOnDisk.files.get('a')).toBe('disk');
    expect(changedOnDisk.conflicts).toEqual(['a']);
  });

  it('keeps files added on either side', () => {
    const merged = mergeUnsaved(files({}), files({ fromDisk: 'd' }), files({ mine: 'u' }));
    expect(Object.fromEntries(merged.files)).toEqual({ fromDisk: 'd', mine: 'u' });
    expect(merged.conflicts).toEqual([]);
  });

  it("ignores the manifest's writtenBy line, which every save rewrites", () => {
    const manifest = (writer: string, name: string): string =>
      `formatVersion: 2\nname: ${name}\nwrittenBy: ${writer}\n`;
    const onlySaved = mergeUnsaved(
      files({ [MANIFEST_PATH]: manifest('wirebench (open)', 'P') }),
      files({ [MANIFEST_PATH]: manifest('wirebench (manual)', 'P') }),
      files({ [MANIFEST_PATH]: manifest('wirebench (open)', 'P') }),
    );
    expect(onlySaved).toMatchObject({ conflicts: [], changed: false });

    const renamed = mergeUnsaved(
      files({ [MANIFEST_PATH]: manifest('wirebench (open)', 'P') }),
      files({ [MANIFEST_PATH]: manifest('wirebench (manual)', 'P') }),
      files({ [MANIFEST_PATH]: manifest('wirebench (open)', 'Renamed') }),
    );
    expect(renamed).toMatchObject({ conflicts: [], changed: true });
    expect(renamed.files.get(MANIFEST_PATH)).toContain('name: Renamed');
  });
});

describe('overlayFs', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'wirebench-overlay-'));
    await mkdir(join(root, 'interfaces', 'calc'), { recursive: true });
    await writeFile(join(root, 'wirebench.yaml'), 'disk manifest');
    await writeFile(join(root, 'interfaces', 'calc', 'old.yaml'), 'old');
    await mkdir(join(root, 'attachments'), { recursive: true });
    await writeFile(join(root, 'attachments', 'blob'), 'bytes');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('serves merged files from memory, hides dropped managed files, and passes the rest through', async () => {
    const fs = overlayFs(
      root,
      files({ 'wirebench.yaml': 'merged manifest', 'interfaces/calc/new.yaml': 'new', 'environments/dev.yaml': 'env' }),
      ['wirebench.yaml', 'interfaces/calc/old.yaml'],
    );

    expect((await fs.readFile(join(root, 'wirebench.yaml'))).toString()).toBe('merged manifest');
    await expect(fs.readFile(join(root, 'interfaces', 'calc', 'old.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readFile(join(root, 'attachments', 'blob'))).toString()).toBe('bytes');

    const calc = (await fs.readdir(join(root, 'interfaces', 'calc'))).map((entry) => entry.name);
    expect(calc).toEqual(['new.yaml']);
    const top = (await fs.readdir(root)).map((entry) => entry.name).sort();
    expect(top).toEqual(['attachments', 'environments', 'interfaces', 'wirebench.yaml']);
    expect((await fs.readdir(join(root, 'environments'))).map((entry) => entry.name)).toEqual(['dev.yaml']);
    expect(await fs.stat(join(root, 'environments'))).toMatchObject({ isDirectory: true });
    await expect(fs.writeFile(join(root, 'x'), 'y')).rejects.toThrow('read-only');
  });
});

describe('UnsavedStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-unsaved-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a project record, and deletes it', async () => {
    const store = new UnsavedStore(dir);
    await store.writeProject('p1', { baseline: files({ a: '1' }), unsaved: files({ a: '2' }) }, '2026-09-13T10:00:00Z');
    expect(await store.readProject('p1')).toEqual({
      version: 1,
      savedAt: '2026-09-13T10:00:00Z',
      baseline: { a: '1' },
      unsaved: { a: '2' },
    });
    await store.deleteProject('p1');
    expect(await store.readProject('p1')).toBeUndefined();
  });

  it('applies overlapping writes in the order they were made', async () => {
    const store = new UnsavedStore(dir);
    const first = store.writeProject('p1', { baseline: files({}), unsaved: files({ a: 'first' }) }, 't1');
    const second = store.writeProject('p1', { baseline: files({}), unsaved: files({ a: 'second' }) }, 't2');
    const gone = store.deleteProject('p1');
    const last = store.writeProject('p1', { baseline: files({}), unsaved: files({ a: 'last' }) }, 't3');
    await Promise.all([first, second, gone, last]);
    expect((await store.readProject('p1'))?.unsaved).toEqual({ a: 'last' });
  });

  it('reads a corrupt or unknown-version record as nothing to restore', async () => {
    await mkdir(join(dir, 'unsaved'), { recursive: true });
    await writeFile(join(dir, 'unsaved', 'broken.json'), '{ not json');
    await writeFile(
      join(dir, 'unsaved', 'future.json'),
      JSON.stringify({ version: 99, savedAt: 'x', baseline: {}, unsaved: {} }),
    );
    const store = new UnsavedStore(dir);
    expect(await store.readProject('broken')).toBeUndefined();
    expect(await store.readProject('future')).toBeUndefined();
  });

  it('round-trips drafts, and removes the file when none are left', async () => {
    const store = new UnsavedStore(dir);
    await store.writeDrafts({ r1: { envelopeXml: '<a/>' } });
    expect(await store.readDrafts()).toEqual({
      requests: { r1: { envelopeXml: '<a/>' } },
      restRequests: {},
      grpcRequests: {},
      wsRequests: {},
    });
    await store.writeDrafts({});
    expect(await store.readDrafts()).toEqual({ requests: {}, restRequests: {}, grpcRequests: {}, wsRequests: {} });

    // All four protocols' drafts live in one file, and any one alone is enough to keep it.
    await store.writeDrafts({}, { rest1: { url: '/pets' } });
    expect(await store.readDrafts()).toEqual({
      requests: {},
      restRequests: { rest1: { url: '/pets' } },
      grpcRequests: {},
      wsRequests: {},
    });
    await store.writeDrafts({}, {});
    expect(await store.readDrafts()).toEqual({ requests: {}, restRequests: {}, grpcRequests: {}, wsRequests: {} });
    expect(await readdir(join(dir, 'unsaved'))).toEqual([]);

    // A WebSocket draft alone also keeps the file.
    await store.writeDrafts({}, {}, {}, { ws1: { url: '/ws' } });
    expect(await store.readDrafts()).toEqual({
      requests: {},
      restRequests: {},
      grpcRequests: {},
      wsRequests: { ws1: { url: '/ws' } },
    });
    await store.writeDrafts({}, {}, {}, {});
    expect(await store.readDrafts()).toEqual({ requests: {}, restRequests: {}, grpcRequests: {}, wsRequests: {} });
    expect(await readdir(join(dir, 'unsaved'))).toEqual([]);
  });

  it('sets a record that could not be restored aside', async () => {
    const store = new UnsavedStore(dir);
    await store.writeProject('p1', { baseline: files({}), unsaved: files({ a: '1' }) }, 't');
    await store.setAsideProject('p1');
    expect(await store.readProject('p1')).toBeUndefined();
    expect(await readFile(join(dir, 'unsaved', 'p1.failed.json'), 'utf8')).toContain('"a":"1"');
  });
});
