import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WssPolicyPanel } from '../../src/renderer/features/request-editor/inspectors/wss-policy-panel.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';
import type { WssEntryWire, WssPolicyStatusResponse, WssPolicyWire } from '../../src/shared/wire-types.js';

const BINDING = '{http://tempuri.org/}CalculatorSoap';

const TRANSPORT: WssPolicyWire = {
  version: '1.2',
  soapVersion: '1.1',
  binding: 'transport',
  requiresTls: true,
  includeTimestamp: true,
  encryptBeforeSigning: false,
  algorithmSuite: 'Basic128',
  tokens: [{ kind: 'username', role: 'signed-supporting', password: 'digest' }],
  signedParts: [],
  encryptedParts: [],
  unsupported: [],
  notes: [],
};

const PROPOSAL: WssEntryWire[] = [
  { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
  { kind: 'username-token', username: '', passwordType: 'digest', addNonce: true, addCreated: true },
];

const UNMET: NonNullable<WssPolicyStatusResponse['status']> = {
  lines: [
    { label: 'Tokens', value: 'Username token (digest password)' },
    { label: 'Algorithm suite', value: 'Basic128' },
    { label: 'TLS', value: 'Required' },
  ],
  satisfied: false,
  results: [
    { requirement: 'HTTPS endpoint', met: true },
    { requirement: 'Timestamp', met: false, reason: 'No timestamp entry.' },
    { requirement: 'Username token (digest password)', met: false, reason: 'No username token entry.' },
  ],
  proposal: PROPOSAL,
  notes: ['The policy offers 2 alternatives; the first one is used.'],
};

const SATISFIED: NonNullable<WssPolicyStatusResponse['status']> = {
  ...UNMET,
  satisfied: true,
  results: UNMET.results.map(({ requirement }) => ({ requirement, met: true })),
  notes: [],
};

const policyStatus = vi.fn();
const addWssOutgoing = vi.fn();
const updateWssOutgoing = vi.fn();
const updateRequest = vi.fn();

function install(options: {
  readonly policy?: WssPolicyWire;
  readonly wssOutgoingRef?: string;
  readonly configs?: readonly { id: string; name: string; entries: WssEntryWire[] }[];
}): void {
  useProjectStore.setState({
    requests: {
      'req-1': makeDraft(options.wssOutgoingRef !== undefined ? { wssOutgoingRef: options.wssOutgoingRef } : {}),
    },
    interfaces: {
      'if-1': {
        operations: [
          {
            name: 'Add',
            binding: BINDING,
            inputMimeParts: [],
            ...(options.policy !== undefined ? { wssPolicy: options.policy } : {}),
          },
        ],
        endpoints: [],
      },
    },
    projectOf: { 'req-1': 'p-1', 'if-1': 'p-1' },
    wssOutgoing: (options.configs ?? []).map((config) => ({ ...config, mustUnderstand: false, projectId: 'p-1' })),
    addWssOutgoing,
    updateWssOutgoing,
    updateRequest,
  } as never);
}

describe('WssPolicyPanel', () => {
  beforeEach(() => {
    policyStatus.mockReset().mockResolvedValue({ ok: true, value: { status: UNMET } });
    addWssOutgoing.mockReset().mockResolvedValue('cfg-new');
    updateWssOutgoing.mockReset().mockResolvedValue(undefined);
    updateRequest.mockReset();
    installWirebenchApi({ wss: { policyStatus } });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing, and asks main nothing, when the operation has no policy', () => {
    install({});
    render(<WssPolicyPanel requestId="req-1" />);
    expect(screen.queryByTestId('wss-policy-panel')).toBeNull();
    expect(policyStatus).not.toHaveBeenCalled();
  });

  it('summarises the policy and lists what the request does not yet meet', async () => {
    install({ policy: TRANSPORT });
    render(<WssPolicyPanel requestId="req-1" />);

    const badge = await screen.findByTestId('wss-policy-badge');
    expect(policyStatus).toHaveBeenCalledWith({ requestId: 'req-1' });
    expect(badge.dataset['satisfied']).toBe('false');
    expect(badge.textContent).toBe('Policy: 2 unmet');
    expect(screen.getByText('Username token (digest password)', { selector: 'dd' })).toBeDefined();
    expect(screen.getByText('Required')).toBeDefined();
    expect(screen.getByTestId('wss-policy-unmet').textContent).toContain('No username token entry.');
    expect(screen.getByText('The policy offers 2 alternatives; the first one is used.')).toBeDefined();
  });

  it('shows the policy satisfied, and asks again when the selected configuration changes', async () => {
    install({ policy: TRANSPORT });
    render(<WssPolicyPanel requestId="req-1" />);
    await screen.findByTestId('wss-policy-badge');

    policyStatus.mockResolvedValue({ ok: true, value: { status: SATISFIED } });
    install({
      policy: TRANSPORT,
      wssOutgoingRef: 'cfg-1',
      configs: [{ id: 'cfg-1', name: 'Mine', entries: PROPOSAL }],
    });

    await waitFor(() => {
      expect(screen.getByTestId('wss-policy-badge').textContent).toBe('Satisfies policy');
    });
    expect(screen.queryByTestId('wss-policy-unmet')).toBeNull();
  });

  it('applies the proposal as a new configuration and selects it', async () => {
    install({ policy: TRANSPORT, wssOutgoingRef: 'cfg-1', configs: [{ id: 'cfg-1', name: 'Mine', entries: [] }] });
    render(<WssPolicyPanel requestId="req-1" />);

    await userEvent.click(await screen.findByTestId('wss-policy-apply'));

    await waitFor(() => {
      expect(updateRequest).toHaveBeenCalledWith('req-1', { wssOutgoingRef: 'cfg-new' });
    });
    expect(addWssOutgoing).toHaveBeenCalledWith('p-1', { name: 'Add policy' });
    expect(updateWssOutgoing).toHaveBeenCalledWith('cfg-new', { entries: PROPOSAL });
  });

  it('refreshes the configuration an earlier apply created, keeping the username', async () => {
    install({
      policy: TRANSPORT,
      wssOutgoingRef: 'cfg-2',
      configs: [
        {
          id: 'cfg-2',
          name: 'Add policy',
          entries: [
            {
              kind: 'username-token',
              username: 'bob',
              passwordRef: 'ref-1',
              passwordType: 'text',
              addNonce: false,
              addCreated: false,
            },
          ],
        },
      ],
    });
    render(<WssPolicyPanel requestId="req-1" />);

    await userEvent.click(await screen.findByTestId('wss-policy-apply'));

    await waitFor(() => {
      expect(updateWssOutgoing).toHaveBeenCalledWith('cfg-2', {
        entries: [
          { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
          {
            kind: 'username-token',
            username: 'bob',
            passwordRef: 'ref-1',
            passwordType: 'digest',
            addNonce: true,
            addCreated: true,
          },
        ],
      });
    });
    expect(addWssOutgoing).not.toHaveBeenCalled();
    expect(updateRequest).not.toHaveBeenCalled();
  });
});
