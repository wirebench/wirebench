import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { IncomingConfigEditor } from '../../src/renderer/features/wss/incoming-config-editor.js';
import { WssInspector, wssTabLabel } from '../../src/renderer/features/request-editor/inspectors/wss-inspector.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { ExchangeSummary, KeystoreWire, ProjectWire, WssIncomingWire } from '../../src/shared/wire-types.js';

const project = { id: 'p1', name: 'Demo', dir: '/tmp/demo' } as unknown as ProjectWire;

const keystore = { id: 'k1', name: 'client', path: '/tmp/client.p12', type: 'pkcs12' } as KeystoreWire;

const config: WssIncomingWire = {
  id: 'i1',
  name: 'Gateway in',
  requireSignature: false,
  requireTimestamp: false,
  timestampSkewSeconds: 300,
  verifyChain: true,
};

function setUp(configs: readonly WssIncomingWire[] = [config]) {
  installWirebenchApi({});
  const actions = {
    addWssIncoming: vi.fn().mockResolvedValue('i2'),
    updateWssIncoming: vi.fn().mockResolvedValue(undefined),
    removeWssIncoming: vi.fn().mockResolvedValue(undefined),
  };
  useProjectStore.setState({
    projects: { p1: project },
    keystores: [{ ...keystore, projectId: 'p1' }],
    wssIncoming: configs.map((entry) => ({ ...entry, projectId: 'p1' })),
    ...actions,
  });
  render(
    <TooltipPrimitive.Provider>
      <IncomingConfigEditor />
    </TooltipPrimitive.Provider>,
  );
  return actions;
}

afterEach(() => {
  cleanup();
  useProjectStore.getState().reset();
});

describe('IncomingConfigEditor', () => {
  it('lists configurations and adds one', () => {
    const { addWssIncoming } = setUp();
    expect(screen.getAllByTestId('wss-incoming-row')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('wss-incoming-add'));
    expect(addWssIncoming).toHaveBeenCalledWith('p1');
  });

  it('says so when there is nothing yet', () => {
    setUp([]);
    expect(screen.getByText('No incoming configurations yet.')).toBeTruthy();
  });

  it('edits every field of a configuration', () => {
    const { updateWssIncoming } = setUp();
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    // Choosing a keystore also drops any alias chosen inside the previous one.
    fireEvent.change(screen.getByLabelText('Decryption keystore'), { target: { value: 'k1' } });
    expect(updateWssIncoming).toHaveBeenLastCalledWith('i1', { decryptKeystoreRef: 'k1', decryptAlias: null });

    fireEvent.change(screen.getByLabelText('Signature truststore'), { target: { value: 'k1' } });
    expect(updateWssIncoming).toHaveBeenLastCalledWith('i1', { signatureKeystoreRef: 'k1' });

    fireEvent.click(screen.getByLabelText('Require signature'));
    expect(updateWssIncoming).toHaveBeenLastCalledWith('i1', { requireSignature: true });

    fireEvent.click(screen.getByLabelText('Require timestamp'));
    expect(updateWssIncoming).toHaveBeenLastCalledWith('i1', { requireTimestamp: true });

    fireEvent.change(screen.getByLabelText('Timestamp skew (seconds)'), { target: { value: '60' } });
    expect(updateWssIncoming).toHaveBeenLastCalledWith('i1', { timestampSkewSeconds: 60 });

    fireEvent.click(screen.getByLabelText('Verify certificate chain'));
    expect(updateWssIncoming).toHaveBeenLastCalledWith('i1', { verifyChain: false });

    const name = screen.getByLabelText('Incoming configuration name');
    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.blur(name);
    expect(updateWssIncoming).toHaveBeenLastCalledWith('i1', { name: 'Renamed' });
  });

  it('offers the alias select only once a keystore is chosen', () => {
    expect(screen.queryByLabelText('Decryption alias')).toBeNull();
    setUp([{ ...config, decryptKeystoreRef: 'k1' }]);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByLabelText('Decryption alias')).toBeTruthy();
  });
});

/** An exchange carrying the given WS-Security actions. */
function exchangeWith(actions: NonNullable<ExchangeSummary['wss']>['incoming']): ExchangeSummary {
  return { sendId: 's1', wss: { incoming: actions } } as unknown as ExchangeSummary;
}

describe('WssInspector', () => {
  it('says so when the response was not processed', () => {
    render(<WssInspector exchange={undefined} requestId="r1" />);
    expect(screen.getByText('No WS-Security processing for this response')).toBeTruthy();
    expect(wssTabLabel(undefined)).toBe('WSS');
  });

  it('lists one row per action, with the signer and the timestamp', () => {
    const exchange = exchangeWith({
      actions: [
        { kind: 'decrypt', ok: true, detail: 'Decrypted 1 block.' },
        {
          kind: 'signature',
          ok: false,
          detail: 'Signature valid, but the signer is not trusted.',
          signerSubject: 'CN=rogue',
          trusted: false,
        },
        { kind: 'timestamp', ok: true, detail: 'Timestamp fresh.', created: 'T0', expires: 'T1' },
      ],
      errors: ['Signature valid, but the signer is not trusted.'],
    });
    render(<WssInspector exchange={exchange} requestId="r1" />);
    expect(screen.getAllByTestId('wss-action-row')).toHaveLength(3);
    expect(screen.getByText('CN=rogue')).toBeTruthy();
    expect(screen.getByText('untrusted')).toBeTruthy();
    expect(screen.getByText('T0 → T1')).toBeTruthy();
    expect(wssTabLabel(exchange)).toBe('WSS ✗');
  });

  it('switches between the decrypted and the raw view', () => {
    const exchange = exchangeWith({
      actions: [{ kind: 'decrypt', ok: true, detail: 'Decrypted 1 block.' }],
      errors: [],
    });
    render(<WssInspector exchange={exchange} requestId="r1" />);
    expect(wssTabLabel(exchange)).toBe('WSS ✓');
    fireEvent.click(screen.getByRole('button', { name: 'Show raw' }));
    expect(useEditorsStore.getState().responseViewFor('r1')).toBe('raw');
    fireEvent.click(screen.getByRole('button', { name: 'Show decrypted' }));
    expect(useEditorsStore.getState().responseViewFor('r1')).toBe('xml');
  });

  it('lists every reference of a failed signature with its digests (#57)', () => {
    render(
      <WssInspector
        exchange={exchangeWith({
          actions: [
            {
              kind: 'signature',
              ok: false,
              detail: 'Reference #Id-1 (Body) does not match.',
              check: {
                canonicalization: 'exc-c14n',
                signatureMethod: 'rsa-sha256',
                signatureValueOk: true,
                references: [
                  {
                    uri: 'Id-1',
                    element: 'Body',
                    ok: false,
                    transforms: ['exc-c14n'],
                    inclusivePrefixes: ['soapenv'],
                    digestAlgorithm: 'sha256',
                    expectedDigest: 'EXPECTED=',
                    computedDigest: 'COMPUTED=',
                  },
                  {
                    uri: 'TS-1',
                    element: 'Timestamp',
                    ok: true,
                    transforms: ['exc-c14n'],
                    inclusivePrefixes: [],
                    digestAlgorithm: 'sha256',
                    expectedDigest: 'SAME=',
                    computedDigest: 'SAME=',
                  },
                ],
              },
            },
          ],
          errors: ['Reference #Id-1 (Body) does not match.'],
        })}
        requestId="r1"
      />,
    );
    expect(screen.getAllByTestId('wss-reference-check')).toHaveLength(2);
    expect(screen.getByText('differs')).toBeTruthy();
    expect(screen.getByText('matches')).toBeTruthy();
    expect(screen.getByText('EXPECTED=')).toBeTruthy();
    expect(screen.getByText('COMPUTED=')).toBeTruthy();
    // Only the failing reference spells out its digests.
    expect(screen.queryByText('SAME=')).toBeNull();
    expect(screen.queryByText('SignatureValue invalid')).toBeNull();
  });

  it('flags a SignatureValue that fails while every reference matches', () => {
    render(
      <WssInspector
        exchange={exchangeWith({
          actions: [
            {
              kind: 'signature',
              ok: false,
              detail: 'Every reference matches, but the SignatureValue does not verify.',
              check: {
                canonicalization: 'exc-c14n',
                signatureMethod: 'rsa-sha256',
                signatureValueOk: false,
                references: [
                  {
                    uri: 'Id-1',
                    element: 'Body',
                    ok: true,
                    transforms: ['exc-c14n'],
                    inclusivePrefixes: [],
                    digestAlgorithm: 'sha256',
                    expectedDigest: 'SAME=',
                    computedDigest: 'SAME=',
                  },
                ],
              },
            },
          ],
          errors: [],
        })}
        requestId="r1"
      />,
    );
    expect(screen.getByText('SignatureValue invalid')).toBeTruthy();
  });

  it('shows the clock skew a timestamp was judged with', () => {
    render(
      <WssInspector
        exchange={exchangeWith({
          actions: [
            {
              kind: 'timestamp',
              ok: false,
              detail: 'Created 95 s ahead.',
              created: 'T0',
              skewSeconds: -95,
              toleranceSeconds: 30,
            },
          ],
          errors: [],
        })}
        requestId="r1"
      />,
    );
    expect(screen.getByTestId('wss-clock-skew').textContent).toBe(
      'Clock: created 95 s ahead of this clock; 30 s skew tolerated',
    );
  });

  it('lists the Security header in header order', () => {
    render(
      <WssInspector
        exchange={exchangeWith({
          actions: [],
          errors: [],
          timeline: [
            { kind: 'timestamp', summary: 'Timestamp (created T0)' },
            {
              kind: 'signature',
              summary: 'Signed Body, Timestamp (rsa-sha256, exc-c14n)',
              covers: ['Body', 'Timestamp'],
            },
            { kind: 'encryption', summary: 'Encrypted Body (content)', actor: 'urn:gw' },
          ],
        })}
        requestId="r1"
      />,
    );
    expect(screen.queryByTestId('wss-actions-table')).toBeNull();
    const steps = screen.getAllByTestId('wss-timeline-step').map((step) => step.textContent);
    expect(steps).toEqual([
      'Timestamp (created T0)',
      'Signed Body, Timestamp (rsa-sha256, exc-c14n)',
      'Encrypted Body (content) (for urn:gw)',
    ]);
  });

  it('has no note to show when nothing was decrypted', () => {
    render(
      <WssInspector
        exchange={exchangeWith({
          actions: [{ kind: 'signature', ok: true, detail: 'ok', trusted: true }],
          errors: [],
        })}
        requestId="r1"
      />,
    );
    expect(screen.queryByTestId('wss-decrypted-note')).toBeNull();
  });
});
