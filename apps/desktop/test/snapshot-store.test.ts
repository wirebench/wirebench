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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInterface, createProject, createRequest, saveProject } from '@wirebench/engine';
import type { Interface, Project } from '@wirebench/engine';
import { SnapshotStore } from '../src/main/snapshot-store.js';

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
    await store.write({ requestId: 'req-1', body: 'hello\n', ignore: [] });
    await store.setIgnore({ requestId: 'req-1', ignore: ['//requestId'] });
    const read = await store.read({ requestId: 'req-1' });
    expect(read.status === 'present' && read.snapshot).toMatchObject({ body: 'hello\n', ignore: ['//requestId'] });
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
    const project = build('../../../../../escape');
    const store = new SnapshotStore(() => ({ project, dir: root }));
    writeFileSync(join(root, '..', 'escape.request.yaml'), 'x');
    try {
      expect(await store.read({ requestId: 'req-1' })).toEqual({ status: 'unsaved' });
      await expect(store.write({ requestId: 'req-1', body: 'x', ignore: [] })).rejects.toThrow();
    } finally {
      rmSync(join(root, '..', 'escape.request.yaml'), { force: true });
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
});
