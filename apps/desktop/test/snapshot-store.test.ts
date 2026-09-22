// @vitest-environment node
import {
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  mkdirSync,
  lstatSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInterface, createProject, createRequest, saveProject } from '@wirebench/engine';
import type { Interface, Project } from '@wirebench/engine';
import { SnapshotStore } from '../src/main/snapshot-store.js';

// Passes through to the real `writeFile` unless a test overrides one call.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

/** Whether this platform lets the test create a symlink (Windows without the privilege does not). */
const canSymlink = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'wirebench-symlink-probe-'));
  try {
    symlinkSync(join(probe, 'target'), join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const BINDING = '{http://tempuri.org/}CalculatorSoap';
const SIDECAR = ['interfaces', 'Calculator', 'operations', 'Add', 'Request-1.golden.yaml'];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-snapshot-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function build(slug = 'Request-1'): Project {
  const iface: Interface = createInterface('Calculator', {
    id: 'iface-1',
    slug: 'Calculator',
    definitionUrl: 'http://example.test/service.wsdl',
    endpoints: [{ id: 'ep-1', name: 'Primary', url: 'http://a.test/soap', authMode: 'complement' }],
    operations: [
      {
        name: 'Add',
        bindingName: BINDING,
        slug: 'Add',
        order: 0,
        requests: [
          {
            ...createRequest('Request 1', {
              id: 'req-1',
              envelopeXml: '<Add/>',
              soapVersion: '1.1',
              endpointId: 'ep-1',
            }),
            slug,
          },
        ],
      },
    ],
  });
  return { ...createProject('Demo', { id: 'proj-1' }), interfaces: [iface] };
}

async function savedStore(project = build()): Promise<SnapshotStore> {
  await saveProject(project, root);
  return new SnapshotStore(() => ({ project, dir: root }));
}

describe('SnapshotStore', () => {
  it('round-trips a write through read', async () => {
    const store = await savedStore();
    const { savedAt } = await store.write({
      requestId: 'req-1',
      body: '{"id": 1}\n',
      contentType: 'application/json',
      ignore: ['/meta/timestamp'],
    });
    const read = await store.read({ requestId: 'req-1' });
    expect(read).toEqual({
      status: 'present',
      snapshot: { contentType: 'application/json', savedAt, ignore: ['/meta/timestamp'], body: '{"id": 1}\n' },
    });
  });

  it('writes the body as a YAML block scalar and leaves no temp file', async () => {
    const store = await savedStore();
    await store.write({ requestId: 'req-1', body: '<a>1</a>', ignore: [] });
    const text = readFileSync(join(root, ...SIDECAR), 'utf8');
    expect(text).toMatch(/^body: \|/m);
    expect(text).toContain('  <a>1</a>');
    const read = await store.read({ requestId: 'req-1' });
    expect(read.status === 'present' && read.snapshot.body).toBe('<a>1</a>');
    expect(readdirSync(join(root, ...SIDECAR.slice(0, -1))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('setIgnore keeps the body', async () => {
    const store = await savedStore();
    const written = await store.write({ requestId: 'req-1', body: 'hello\n', ignore: [] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await store.setIgnore({ requestId: 'req-1', ignore: ['//requestId'] });
    expect(updated.savedAt).toBe(written.savedAt);
    const read = await store.read({ requestId: 'req-1' });
    expect(read.status === 'present' && read.snapshot).toMatchObject({
      body: 'hello\n',
      ignore: ['//requestId'],
      savedAt: written.savedAt,
    });
  });

  it('setIgnore without a snapshot fails', async () => {
    const store = await savedStore();
    await expect(store.setIgnore({ requestId: 'req-1', ignore: [] })).rejects.toThrow();
  });

  it('removes a snapshot', async () => {
    const store = await savedStore();
    await store.write({ requestId: 'req-1', body: 'x', ignore: [] });
    expect(await store.remove({ requestId: 'req-1' })).toEqual({ removed: true });
    expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'none' });
    expect(await store.remove({ requestId: 'req-1' })).toEqual({ removed: false });
  });

  it('reads none when no snapshot was saved', async () => {
    const store = await savedStore();
    expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'none' });
  });

  it('reads unsaved when no saved project holds the request', async () => {
    const store = new SnapshotStore(() => undefined);
    expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'unsaved' });
    await expect(store.write({ requestId: 'req-1', body: 'x', ignore: [] })).rejects.toThrow();
  });

  it('reads unsaved when the request YAML is not on disk yet', async () => {
    const store = new SnapshotStore(() => ({ project: build(), dir: root }));
    expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'unsaved' });
    await expect(store.write({ requestId: 'req-1', body: 'x', ignore: [] })).rejects.toThrow();
  });

  it('reads unsaved for an unknown request', async () => {
    const store = await savedStore();
    expect(await store.read({ requestId: 'nope' })).toEqual({ status: 'unsaved' });
  });

  it('reads a malformed sidecar as none and warns', async () => {
    const store = await savedStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(join(root, ...SIDECAR), 'body: [unclosed\n');
    expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'none' });
    writeFileSync(join(root, ...SIDECAR), 'savedAt: 1\nbody: 2\n');
    expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'none' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('refuses a path that leaves the project folder', async () => {
    // The project sits one level down in its own temp folder, so the escaping slug lands beside
    // it there rather than in the shared system temp folder.
    const base = mkdtempSync(join(tmpdir(), 'wirebench-escape-'));
    try {
      const dir = join(base, 'project');
      mkdirSync(dir);
      const project = build('../../../../../escape');
      const store = new SnapshotStore(() => ({ project, dir }));
      writeFileSync(join(base, 'escape.request.yaml'), 'x');
      expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'unsaved' });
      await expect(store.write({ requestId: 'req-1', body: 'x', ignore: [] })).rejects.toThrow();
      expect(existsSync(join(base, 'escape.golden.yaml'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses a folder symlinked out of the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wirebench-outside-'));
    try {
      mkdirSync(join(root, 'interfaces', 'Calculator'), { recursive: true });
      mkdirSync(join(outside, 'Add'));
      writeFileSync(join(outside, 'Add', 'Request-1.request.yaml'), 'x');
      symlinkSync(join(outside), join(root, 'interfaces', 'Calculator', 'operations'));
      const store = new SnapshotStore(() => ({ project: build(), dir: root }));
      await expect(store.write({ requestId: 'req-1', body: 'x', ignore: [] })).rejects.toThrow();
      expect(existsSync(join(outside, 'Add', 'Request-1.golden.yaml'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('round-trips bodies a block scalar cannot hold as they are', async () => {
    const store = await savedStore();
    const bodies = ['', ' ', '\n', '\n\n', '  \n', '  \n\t', 'a\n', 'a', 'a  ', 'a  \nb  \n', ' a\n', '\n a', 'a\n '];
    for (const body of bodies) {
      await store.write({ requestId: 'req-1', body, ignore: [] });
      const read = await store.read({ requestId: 'req-1' });
      expect(read.status === 'present' && read.snapshot.body, JSON.stringify(body)).toBe(body);
    }
  });

  it('cleans up the temp file when writing it fails, and names each one uniquely', async () => {
    const store = await savedStore();
    const writeFile = vi.mocked(fsPromises.writeFile);
    const temps: string[] = [];
    writeFile.mockImplementationOnce((path, data) => {
      // A partial temp file is left behind by the failed write, as a full disk would.
      writeFileSync(path as string, (data as string).slice(0, 3));
      temps.push(path as string);
      return Promise.reject(new Error('disk full'));
    });
    await expect(store.write({ requestId: 'req-1', body: 'x', ignore: [] })).rejects.toThrow('disk full');
    expect(readdirSync(join(root, ...SIDECAR.slice(0, -1))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'none' });

    await store.write({ requestId: 'req-1', body: 'x', ignore: [] });
    temps.push(writeFile.mock.calls.at(-1)?.[0] as string);
    expect(temps[0]).not.toBe(temps[1]);
    expect(temps[0]).not.toContain(`.${String(process.pid)}.tmp`);
  });

  it.skipIf(!canSymlink)('does not follow a sidecar symlinked at another file in the project', async () => {
    const store = await savedStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const target = join(root, 'interfaces', 'Calculator', 'operations', 'Add', 'Request-1.request.yaml');
    const before = readFileSync(target, 'utf8');
    symlinkSync(target, join(root, ...SIDECAR));

    expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'none' });
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(store.write({ requestId: 'req-1', body: 'x', ignore: [] })).rejects.toMatchObject({
      code: 'snapshot-not-a-file',
    });
    await expect(store.setIgnore({ requestId: 'req-1', ignore: ['/a'] })).rejects.toMatchObject({
      code: 'snapshot-not-a-file',
    });
    await expect(store.remove({ requestId: 'req-1' })).rejects.toMatchObject({ code: 'snapshot-not-a-file' });

    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(lstatSync(join(root, ...SIDECAR)).isSymbolicLink()).toBe(true);
  });

  it('refuses a sidecar path that is a folder', async () => {
    const store = await savedStore();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mkdirSync(join(root, ...SIDECAR));
    expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'none' });
    await expect(store.write({ requestId: 'req-1', body: 'x', ignore: [] })).rejects.toMatchObject({
      code: 'snapshot-not-a-file',
    });
    await expect(store.remove({ requestId: 'req-1' })).rejects.toMatchObject({ code: 'snapshot-not-a-file' });
  });

  it('applies mutations for one request in the order they were issued', async () => {
    const store = await savedStore();
    const results = await Promise.allSettled([
      store.write({ requestId: 'req-1', body: 'one', ignore: [] }),
      store.setIgnore({ requestId: 'req-1', ignore: ['/a'] }),
      store.write({ requestId: 'req-1', body: 'two', ignore: ['/b'] }),
      store.setIgnore({ requestId: 'req-1', ignore: ['/c'] }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    const read = await store.read({ requestId: 'req-1' });
    expect(read.status === 'present' && read.snapshot).toMatchObject({ body: 'two', ignore: ['/c'] });

    const [, removed] = await Promise.all([
      store.write({ requestId: 'req-1', body: 'three', ignore: [] }),
      store.remove({ requestId: 'req-1' }),
    ]);
    expect(removed).toEqual({ removed: true });
    expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'none' });
  });

  it('keeps going after a failed mutation', async () => {
    const store = await savedStore();
    const [failed, written] = await Promise.allSettled([
      store.setIgnore({ requestId: 'req-1', ignore: ['/a'] }),
      store.write({ requestId: 'req-1', body: 'x', ignore: [] }),
    ]);
    expect(failed?.status).toBe('rejected');
    expect(written?.status).toBe('fulfilled');
  });
});
