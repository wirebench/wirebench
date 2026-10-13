// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LayoutStore } from '../src/main/layout-store.js';
import { registerLayoutChannels } from '../src/main/areas/layout-channels.js';
import type { LayoutNodeWire } from '../src/shared/layout-wire.js';

const handlers = vi.hoisted(() => new Map<string, (event: unknown, request: unknown) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, request: unknown) => unknown) => {
      handlers.set(name, handler);
    },
  },
}));

const fileIn = () => join(mkdtempSync(join(tmpdir(), 'wb-layouts-')), 'ssh-layouts.json');

const pane = (host: string): LayoutNodeWire => ({ kind: 'pane', host });
const TWO: LayoutNodeWire = { kind: 'split', dir: 'row', ratio: 0.5, a: pane('db-1'), b: pane('db-2') };

/** A right-leaning chain of `count` panes. */
function chain(count: number): LayoutNodeWire {
  let node: LayoutNodeWire = pane(`h${String(count)}`);
  for (let i = count - 1; i >= 1; i--)
    node = { kind: 'split', dir: 'column', ratio: 0.5, a: pane(`h${String(i)}`), b: node };
  return node;
}

describe('LayoutStore', () => {
  it('a missing file lists empty', async () => {
    expect(await new LayoutStore(fileIn()).list('ws')).toEqual([]);
  });

  it('creates, lists, updates by id, renames and deletes', async () => {
    const store = new LayoutStore(fileIn());
    const created = await store.save('ws', { name: 'Prod databases', root: TWO });
    expect(created).toMatchObject({ name: 'Prod databases', root: TWO });
    expect(typeof created.id).toBe('string');
    expect(await store.list('ws')).toEqual([created]);

    const updated = await store.save('ws', { id: created.id, name: 'Prod databases', root: pane('bastion') });
    expect(updated).toEqual({ id: created.id, name: 'Prod databases', root: pane('bastion') });
    expect(await store.list('ws')).toEqual([updated]);

    await store.rename('ws', created.id, 'Bastion');
    expect((await store.list('ws')).map((layout) => layout.name)).toEqual(['Bastion']);

    await store.delete('ws', created.id);
    expect(await store.list('ws')).toEqual([]);
  });

  it('writes the file in the documented shape', async () => {
    const file = fileIn();
    const created = await new LayoutStore(file).save('ws', { name: 'Two', root: TWO });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, workspaces: { ws: [created] } });
  });

  it('refuses a second layout of the same name, ignoring case', async () => {
    const store = new LayoutStore(fileIn());
    const first = await store.save('ws', { name: 'Prod', root: TWO });
    await expect(store.save('ws', { name: 'prod', root: TWO })).rejects.toMatchObject({
      code: 'ssh-layout-name-taken',
    });
    const other = await store.save('ws', { name: 'Stage', root: TWO });
    await expect(store.rename('ws', other.id, 'PROD')).rejects.toMatchObject({ code: 'ssh-layout-name-taken' });
    // Its own name, case changed, is not a clash.
    await store.rename('ws', first.id, 'PROD');
    expect((await store.list('ws')).map((layout) => layout.name)).toEqual(['PROD', 'Stage']);
  });

  it.each([
    ['13 panes', chain(13)],
    ['a ratio of 0.95', { ...TWO, ratio: 0.95 }],
    ['an unknown key', { ...pane('db-1'), extra: true }],
    ['an empty host', pane('')],
  ] as [string, unknown][])('refuses %s as ssh-layout-invalid', async (_label, root) => {
    await expect(
      new LayoutStore(fileIn()).save('ws', { name: 'Bad', root: root as LayoutNodeWire }),
    ).rejects.toMatchObject({ code: 'ssh-layout-invalid' });
  });

  it('accepts 12 panes', async () => {
    await expect(new LayoutStore(fileIn()).save('ws', { name: 'Twelve', root: chain(12) })).resolves.toBeDefined();
  });

  it('refuses a blank name and an id it does not hold', async () => {
    const store = new LayoutStore(fileIn());
    await expect(store.save('ws', { name: '  ', root: TWO })).rejects.toMatchObject({ code: 'ssh-layout-invalid' });
    await expect(store.save('ws', { id: 'gone', name: 'X', root: TWO })).rejects.toMatchObject({
      code: 'ssh-layout-unknown',
    });
    await expect(store.rename('ws', 'gone', 'X')).rejects.toMatchObject({ code: 'ssh-layout-unknown' });
  });

  it('keeps each workspace its own list', async () => {
    const store = new LayoutStore(fileIn());
    await store.save('a', { name: 'Prod', root: TWO });
    await store.save('b', { name: 'Prod', root: pane('x') });
    expect((await store.list('a')).map((layout) => layout.root)).toEqual([TWO]);
    expect((await store.list('b')).map((layout) => layout.root)).toEqual([pane('x')]);
  });

  it('a malformed file lists empty, is reported once and left alone until the next save', async () => {
    const file = fileIn();
    writeFileSync(file, '{ not json');
    const log = vi.fn();
    const store = new LayoutStore(file, log);
    expect(await store.list('ws')).toEqual([]);
    expect(await store.list('ws')).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    expect(readFileSync(file, 'utf8')).toBe('{ not json');

    const saved = await store.save('ws', { name: 'Fresh', root: TWO });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, workspaces: { ws: [saved] } });
  });

  it('a file of the wrong shape is malformed too', async () => {
    const file = fileIn();
    writeFileSync(
      file,
      JSON.stringify({ version: 1, workspaces: { ws: [{ id: 'x', name: 'X', root: { kind: 'tab' } }] } }),
    );
    const log = vi.fn();
    expect(await new LayoutStore(file, log).list('ws')).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
  });

  it('serialises writes so two saves both land', async () => {
    const file = fileIn();
    const store = new LayoutStore(file);
    await Promise.all([store.save('ws', { name: 'One', root: TWO }), store.save('ws', { name: 'Two', root: TWO })]);
    expect((await new LayoutStore(file).list('ws')).map((layout) => layout.name).sort()).toEqual(['One', 'Two']);
  });
});

describe('layout channels', () => {
  it('act on the calling window’s open workspace only', async () => {
    handlers.clear();
    const store = new LayoutStore(fileIn());
    await store.save('other', { name: 'Elsewhere', root: TWO });
    let open: string | undefined = 'mine';
    registerLayoutChannels({ layouts: store, workspaceId: () => open });
    /** The handler's answer out of its `{ ok, value } | { ok, error }` envelope. */
    const call = async (name: string, request: unknown): Promise<unknown> => {
      const answer = (await handlers.get(name)?.({}, request)) as { ok: boolean; value?: unknown; error?: unknown };
      if (!answer.ok) throw answer.error;
      return answer.value;
    };

    const { layout } = (await call('layout.save', { name: 'Mine', root: TWO })) as { layout: { id: string } };
    expect(await call('layout.list', {})).toEqual({ layouts: [{ id: layout.id, name: 'Mine', root: TWO }] });
    await call('layout.rename', { id: layout.id, name: 'Renamed' });
    expect(await store.list('mine')).toEqual([{ id: layout.id, name: 'Renamed', root: TWO }]);
    await call('layout.delete', { id: layout.id });
    expect(await store.list('mine')).toEqual([]);
    expect((await store.list('other')).map((each) => each.name)).toEqual(['Elsewhere']);

    open = undefined;
    await expect(call('layout.list', {})).rejects.toMatchObject({ code: 'workspace-not-open' });
  });
});
