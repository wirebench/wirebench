// @vitest-environment node
/**
 * The per-project secret scan session in main: what a scan hands the renderer (a preview, never the
 * value), what Move stores and where, what Keep hides and for how long, and the wire schema that
 * keeps a value from ever crossing IPC.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi, createProject, createRestRequest, entry } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { SecretStore, type CryptoBackend } from '../src/main/secrets.js';
import { SecretScanSessions, type SecretScanHost, type SecretScanStore } from '../src/main/secret-scan-session.js';
import { secretFindingWireSchema, secretScanScanResponseSchema } from '../src/shared/wire-types.js';

/** Obviously fake: three base64url segments decoding to `{"fake":1}`, `{"fake":1}` and `fake`. */
const FAKE_JWT = 'eyJmYWtlIjoxfQ.eyJmYWtlIjoxfQ.ZmFrZQ';
const OTHER_JWT = 'eyJmYWtlIjoyfQ.eyJmYWtlIjoyfQ.ZmFrZTI';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirebench-secret-scan-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeCrypto(): CryptoBackend {
  return {
    available: true,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  };
}

function seeded(authorization = `Bearer ${FAKE_JWT}`): Project {
  return {
    ...createProject('Billing', { id: 'p1' }),
    apis: [
      createApi('Billing API', {
        id: 'api-1',
        requests: [createRestRequest('Invoices', { id: 'r1', headers: [entry('Authorization', authorization)] })],
      }),
    ],
  };
}

/** A host holding `project` in memory, applying updates the way `ProjectHost.applyModelUpdate` does. */
function memoryHost(project: Project): SecretScanHost & { current: () => Project; updates: number } {
  let model = project;
  const host = {
    updates: 0,
    current: () => model,
    model: () => model,
    applyModelUpdate: (update: (project: Project) => Project) => {
      const next = update(model);
      if (next === model) return false;
      model = next;
      host.updates += 1;
      return true;
    },
  };
  return host;
}

function sessions(host: SecretScanHost, store = new SecretStore(dir, fakeCrypto())) {
  return { store, registry: new SecretScanSessions({ host: () => host, store }) };
}

describe('SecretScanSession.scan', () => {
  it('lists a finding with a preview and no value', () => {
    const { registry } = sessions(memoryHost(seeded()));

    const findings = registry.session('p1').scan();

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: 'jwt',
      label: expect.stringContaining('Authorization') as string,
      location: { kind: 'rest-header', requestId: 'r1', name: 'Authorization', index: 0 },
    });
    expect(Object.keys(findings[0]!).sort()).toEqual(['id', 'label', 'location', 'preview', 'rule']);
    expect(JSON.stringify(findings)).not.toContain(FAKE_JWT);
    expect(() => secretFindingWireSchema.parse(findings[0])).not.toThrow();
  });
});

describe('secretFindingWireSchema', () => {
  it('rejects a finding that carries its value', () => {
    const { registry } = sessions(memoryHost(seeded()));
    const [finding] = registry.session('p1').scan();

    expect(secretFindingWireSchema.safeParse({ ...finding, value: FAKE_JWT }).success).toBe(false);
    expect(
      secretScanScanResponseSchema.safeParse({
        findings: [{ ...finding, value: FAKE_JWT }],
        proposedNames: {},
        storedNames: [],
      }).success,
    ).toBe(false);
  });
});

describe('SecretScanSession.move', () => {
  it('stores the value under the project label and rewrites the model in one update', async () => {
    const host = memoryHost(seeded());
    const { registry, store } = sessions(host);
    const session = registry.session('p1');
    const [finding] = session.scan();

    const result = await session.move([{ id: finding!.id, name: 'billing_token' }]);

    expect(result).toEqual({ moved: [finding!.id], stale: [], nameTaken: [] });
    const ref = await store.findByLabel('wirebench-secret:p1:billing_token');
    expect(ref).toBeDefined();
    expect(await store.get(ref!)).toBe(FAKE_JWT);
    expect(host.updates).toBe(1);
    expect(host.current().apis[0]!.requests[0]!.headers[0]!.value).toBe('Bearer ${secret:billing_token}');
    expect(session.scan()).toEqual([]);
  });

  it('reports an existing name as taken without storing or rewriting anything', async () => {
    const host = memoryHost(seeded());
    const { registry, store } = sessions(host);
    const ref = await store.set('fake-token-not-real-0000', { label: 'wirebench-secret:p1:billing_token' });
    const session = registry.session('p1');
    const [finding] = session.scan();

    const result = await session.move([{ id: finding!.id, name: 'billing_token' }]);

    expect(result).toEqual({ moved: [], stale: [], nameTaken: [finding!.id] });
    expect(await store.get(ref)).toBe('fake-token-not-real-0000');
    expect(host.updates).toBe(0);
    expect(session.scan()).toHaveLength(1);
  });

  it('replaces the stored value of an existing name when asked to', async () => {
    const host = memoryHost(seeded());
    const { registry, store } = sessions(host);
    const ref = await store.set('fake-token-not-real-0000', { label: 'wirebench-secret:p1:billing_token' });
    const session = registry.session('p1');
    const [finding] = session.scan();

    const result = await session.move([{ id: finding!.id, name: 'billing_token', replace: true }]);

    expect(result.moved).toEqual([finding!.id]);
    expect(await store.get(ref)).toBe(FAKE_JWT);
    expect((await store.list()).filter((e) => e.label === 'wirebench-secret:p1:billing_token')).toHaveLength(1);
  });

  it('reports an id no longer found as stale', async () => {
    const host = memoryHost(seeded());
    const { registry } = sessions(host);

    const result = await registry.session('p1').move([{ id: '0000000000000000', name: 'x' }]);

    expect(result).toEqual({ moved: [], stale: ['0000000000000000'], nameTaken: [] });
    expect(host.updates).toBe(0);
  });

  it('deletes the entry it just stored when the finding goes stale during the write', async () => {
    const host = memoryHost(seeded());
    const store = new SecretStore(dir, fakeCrypto());
    const racing: SecretScanStore = {
      findByLabel: (label) => store.findByLabel(label),
      list: () => store.list(),
      replace: (ref, value) => store.replace(ref, value),
      delete: (ref) => store.delete(ref),
      // The user edits the header while the keychain write is in flight.
      set: async (value, options) => {
        const ref = await store.set(value, options);
        host.applyModelUpdate(() => seeded('Bearer edited-by-the-user'));
        return ref;
      },
    };
    const registry = new SecretScanSessions({ host: () => host, store: racing });
    const session = registry.session('p1');
    const [finding] = session.scan();

    const result = await session.move([{ id: finding!.id, name: 'billing_token' }]);

    expect(result).toEqual({ moved: [], stale: [finding!.id], nameTaken: [] });
    expect(await store.findByLabel('wirebench-secret:p1:billing_token')).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(host.current().apis[0]!.requests[0]!.headers[0]!.value).toBe('Bearer edited-by-the-user');
  });

  it('does not replace an existing value for a finding that went stale before the write', async () => {
    const host = memoryHost(seeded());
    const store = new SecretStore(dir, fakeCrypto());
    const ref = await store.set('fake-token-not-real-0000', { label: 'wirebench-secret:p1:billing_token' });
    const replace = vi.fn((r: string, value: string) => store.replace(r, value));
    const racing: SecretScanStore = {
      list: () => store.list(),
      set: (value, options) => store.set(value, options),
      delete: (r) => store.delete(r),
      replace,
      // The user edits the header while the name is being looked up.
      findByLabel: async (label) => {
        const found = await store.findByLabel(label);
        host.applyModelUpdate(() => seeded('Bearer edited-by-the-user'));
        return found;
      },
    };
    const registry = new SecretScanSessions({ host: () => host, store: racing });
    const session = registry.session('p1');
    const [finding] = session.scan();

    const result = await session.move([{ id: finding!.id, name: 'billing_token', replace: true }]);

    expect(result).toEqual({ moved: [], stale: [finding!.id], nameTaken: [] });
    expect(replace).not.toHaveBeenCalled();
    expect(await store.get(ref)).toBe('fake-token-not-real-0000');
  });

  it('keeps an entry one of two findings sharing its name still uses', async () => {
    const project: Project = {
      ...createProject('Billing', { id: 'p1' }),
      apis: [
        createApi('Billing API', {
          id: 'api-1',
          requests: [
            createRestRequest('A', { id: 'r1', headers: [entry('Authorization', `Bearer ${FAKE_JWT}`)] }),
            createRestRequest('B', { id: 'r2', headers: [entry('Authorization', `Bearer ${FAKE_JWT}`)] }),
          ],
        }),
      ],
    };
    const host = memoryHost(project);
    const { registry, store } = sessions(host);
    const session = registry.session('p1');
    const findings = session.scan();
    expect(findings).toHaveLength(2);

    const result = await session.move([
      { id: findings[0]!.id, name: 'billing_token' },
      { id: findings[1]!.id, name: 'billing_token' },
    ]);

    expect(result.moved.sort()).toEqual([findings[0]!.id, findings[1]!.id].sort());
    const ref = await store.findByLabel('wirebench-secret:p1:billing_token');
    expect(await store.get(ref!)).toBe(FAKE_JWT);
  });

  it('rewrites a real host model as one dirty, announced change', async () => {
    const changed = vi.fn();
    const host = new ProjectHost(new EngineService(), { onChanged: changed });
    await host.create({ dir: join(dir, 'Billing'), name: 'Billing' });
    host.applyModelUpdate((project) => ({ ...project, apis: seeded().apis }));
    const projectId = host.model()!.id;
    const { registry } = sessions(host);
    const session = registry.session(projectId);
    const [finding] = session.scan();
    changed.mockClear();

    await session.move([{ id: finding!.id, name: 'billing_token' }]);

    expect(host.model()!.apis[0]!.requests[0]!.headers[0]!.value).toBe('Bearer ${secret:billing_token}');
    expect(host.snapshot()?.dirty).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    await host.close();
  });
});

describe('SecretScanSession.keep', () => {
  it('hides a kept finding until its value changes', () => {
    const host = memoryHost(seeded());
    const { registry } = sessions(host);
    const session = registry.session('p1');
    const [finding] = session.scan();

    session.keep([finding!.id]);
    expect(session.scan()).toEqual([]);

    host.applyModelUpdate(() => seeded(`Bearer ${OTHER_JWT}`));
    const [again] = session.scan();
    expect(again).toBeDefined();
    expect(again!.id).not.toBe(finding!.id);
  });

  it('tells listeners after a keep and a move', async () => {
    const { registry } = sessions(memoryHost(seeded()));
    const session = registry.session('p1');
    const listener = vi.fn();
    session.onChange(listener);
    const [finding] = session.scan();

    session.keep([finding!.id]);
    expect(listener).toHaveBeenCalledTimes(1);

    await session.move([{ id: finding!.id, name: 'billing_token' }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('SecretScanSessions', () => {
  it('forgets kept ids and listeners when the project closes', () => {
    const { registry } = sessions(memoryHost(seeded()));
    const session = registry.session('p1');
    const listener = vi.fn();
    session.onChange(listener);
    const [finding] = session.scan();
    session.keep([finding!.id]);
    listener.mockClear();

    registry.close('p1');

    const reopened = registry.session('p1');
    expect(reopened).not.toBe(session);
    expect(reopened.scan().map((f) => f.id)).toEqual([finding!.id]);
    reopened.keep([finding!.id]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('closes a session when its project is announced closed, and only then', () => {
    const { registry } = sessions(memoryHost(seeded()));
    const session = registry.session('p1');
    const [finding] = session.scan();
    session.keep([finding!.id]);

    // What main's `onProjectChanged` hook hands it: a snapshot on every edit, `null` on close.
    registry.projectChanged('p1', { id: 'p1' });
    expect(registry.session('p1')).toBe(session);

    registry.projectChanged('p1', null);
    const reopened = registry.session('p1');
    expect(reopened).not.toBe(session);
    expect(reopened.scan()).toHaveLength(1);
  });
});
