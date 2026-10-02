import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { FeatureDescriptor } from '../../../src/protocol/features.js';
import { defineProtocol } from '../../../src/protocol/module.js';
import type { ProtocolRun, RunScope, SelectedBase } from '../../../src/protocol/module.js';
import type { SentRequest } from '../../../src/run/run.js';
import { emptyStorage } from '../../helpers/empty-storage.js';

interface PingSelected extends SelectedBase {
  readonly kind: 'ping';
}

const FEATURE: FeatureDescriptor = { id: 'ping', title: 'Ping', default: true, stage: 'stable', requires: [] };

const STORAGE = emptyStorage('ping');

const SENT: SentRequest = {
  subject: { protocol: 'rest', status: 200, durationMs: 0, bodyText: '', bodyKind: 'other' },
  raw: { rawRequest: new Uint8Array(), rawResponse: new Uint8Array() },
};

function selected(kind: string): SelectedBase {
  return { kind, path: 'Group/One', group: 'Group', request: { id: 'r1', name: 'One', slug: 'one' } };
}

const ping = selected('ping') as PingSelected;

const run: ProtocolRun<PingSelected> = {
  groups: () => [{ order: 0, name: 'Group', candidates: [{ item: ping, diskPath: 'apis/group/requests/one' }] }],
  whyNotRunnable: (_project, requestId) => (requestId === 'gone' ? 'gone' : undefined),
  send: () => Promise.resolve(SENT),
  scriptTypes: () => Promise.resolve({ generated: '' }),
  secretNeeds: () => [{ ref: 'ref-1', purpose: 'ping secret' }],
};

const project = createProject('P', { id: 'p1' });
const scope = { context: { project, projectDir: '/nowhere', overrides: {} } } as RunScope;

describe('defineProtocol', () => {
  it('throws when the feature id is not the kind', () => {
    expect(() => defineProtocol({ kind: 'ping', feature: { ...FEATURE, id: 'pong' }, storage: STORAGE })).toThrow(
      'defineProtocol: the feature of "ping" must have the same id',
    );
  });

  it('leaves out the facets a module does not have', () => {
    const module = defineProtocol({ kind: 'ping', feature: FEATURE, storage: STORAGE });
    expect(module).toEqual({ kind: 'ping', feature: FEATURE, storage: STORAGE });
    expect('run' in module).toBe(false);
  });

  it('passes every call through for a request of its own kind', async () => {
    const module = defineProtocol({ kind: 'ping', feature: FEATURE, storage: STORAGE, run });
    expect(module.run?.groups(project)[0]?.candidates[0]?.item).toBe(ping);
    expect(module.run?.whyNotRunnable(project, 'gone')).toBe('gone');
    expect(await module.run?.send(ping, scope)).toBe(SENT);
    expect(await module.run?.scriptTypes(ping, scope)).toEqual({ generated: '' });
    expect(module.run?.secretNeeds(ping, project)).toEqual([{ ref: 'ref-1', purpose: 'ping secret' }]);
  });

  it('throws when handed a request of another kind', () => {
    const module = defineProtocol({ kind: 'ping', feature: FEATURE, storage: STORAGE, run });
    const other = selected('rest');
    const message = 'The "ping" protocol was handed a "rest" request';
    expect(() => module.run?.send(other, scope)).toThrow(message);
    expect(() => module.run?.scriptTypes(other, scope)).toThrow(message);
    expect(() => module.run?.secretNeeds(other, project)).toThrow(message);
  });
});
