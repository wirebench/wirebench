// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importWsdl } from '@wirebench/engine';
import { registerWssChannels } from '../src/main/ipc/wss.js';
import { toInterfaceSummary } from '../src/main/engine-wire.js';
import { fixturePath } from './helpers/fixtures.js';
import type { WssEntry } from '@wirebench/engine';
import type { WssPolicyWire } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

/** The policies the crafted fixture attaches, by binding local name, as the wire carries them. */
async function policies(): Promise<Map<string, WssPolicyWire>> {
  const location = fixturePath('wsdl/crafted/ws-security-policy/service.wsdl');
  const result = await importWsdl({ kind: 'text', text: readFileSync(location, 'utf-8'), location });
  const summary = toInterfaceSummary(result, 'iface', location);
  const byBinding = new Map<string, WssPolicyWire>();
  for (const operation of summary.operations) {
    if (operation.name === 'Echo' && operation.wssPolicy !== undefined) {
      byBinding.set(operation.bindingLocal, operation.wssPolicy);
    }
  }
  return byBinding;
}

const wssPolicyInputs = vi.fn();
const project = {
  previewOutgoingWss: vi.fn(),
  insertWssEntry: vi.fn(),
  removeOutgoingWssFrom: vi.fn(),
  wssPolicyInputs,
};

describe('wss.policyStatus', () => {
  beforeEach(() => {
    handlers.clear();
    wssPolicyInputs.mockReset();
    registerWssChannels({ project });
  });

  it('answers with no status when the operation carries no policy', async () => {
    wssPolicyInputs.mockReturnValue(undefined);
    expect(await invoke('wss.policyStatus', { requestId: 'r1' })).toEqual({ ok: true, value: {} });
    expect(wssPolicyInputs).toHaveBeenCalledWith('r1');
  });

  it('judges the selected entries and the endpoint, and proposes what the policy needs', async () => {
    const policy = (await policies()).get('TransportUtBinding');
    wssPolicyInputs.mockReturnValue({ policy, entries: [], endpoint: 'http://svc.example.invalid/' });

    const result = (await invoke('wss.policyStatus', { requestId: 'r1' })) as {
      value: { status: { satisfied: boolean; results: unknown[]; proposal: unknown[]; lines: unknown[] } };
    };

    expect(result.value.status.satisfied).toBe(false);
    expect(result.value.status.results).toEqual([
      { requirement: 'HTTPS endpoint', met: false, reason: 'The endpoint does not use https://.' },
      { requirement: 'Timestamp', met: false, reason: 'No timestamp entry.' },
      { requirement: 'Username token (digest password)', met: false, reason: 'No username token entry.' },
    ]);
    expect(result.value.status.proposal).toEqual([
      { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
      { kind: 'username-token', username: '', passwordType: 'digest', addNonce: true, addCreated: true },
    ]);
    expect(result.value.status.lines).toContainEqual({ label: 'TLS', value: 'Required' });
  });

  it('is satisfied once the proposal is filled in and the endpoint uses https', async () => {
    const policy = (await policies()).get('TransportUtBinding');
    const entries: WssEntry[] = [
      { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
      { kind: 'username-token', username: 'alice', passwordType: 'digest', addNonce: true, addCreated: true },
    ];
    wssPolicyInputs.mockReturnValue({ policy, entries, endpoint: 'https://svc.example.invalid/' });

    const result = (await invoke('wss.policyStatus', { requestId: 'r1' })) as {
      value: { status: { satisfied: boolean } };
    };
    expect(result.value.status.satisfied).toBe(true);
  });

  it('passes on the policy’s notes and never reports a symmetric policy satisfied', async () => {
    const all = await policies();
    wssPolicyInputs.mockReturnValue({ policy: all.get('AlternativesBinding'), entries: [] });
    const alternatives = (await invoke('wss.policyStatus', { requestId: 'r1' })) as {
      value: { status: { notes: string[] } };
    };
    expect(alternatives.value.status.notes).toContain('The policy offers 2 alternatives; the first one is used.');

    wssPolicyInputs.mockReturnValue({ policy: all.get('SymmetricBinding'), entries: [] });
    const symmetric = (await invoke('wss.policyStatus', { requestId: 'r1' })) as {
      value: { status: { satisfied: boolean; notes: string[] } };
    };
    expect(symmetric.value.status.satisfied).toBe(false);
    // What cannot be expressed is reported once, as unmet, not repeated among the notes.
    expect(symmetric.value.status.notes.some((note) => note.startsWith('The symmetric binding'))).toBe(false);
  });
});
