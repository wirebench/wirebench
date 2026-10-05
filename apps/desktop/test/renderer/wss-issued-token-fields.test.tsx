import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as baseRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { IssuedTokenFields } from '../../src/renderer/features/wss/issued-token-fields.js';
import { OutgoingConfigEditor } from '../../src/renderer/features/wss/outgoing-config-editor.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { ProjectWire, WssEntryWire } from '../../src/shared/wire-types.js';

type IssuedEntry = Extract<WssEntryWire, { kind: 'issued-token' }>;

const fresh: IssuedEntry = {
  kind: 'issued-token',
  stsUrl: '',
  soapVersion: '1.2',
  trustVersion: '1.3',
  tokenType: '2.0',
  keyType: 'bearer',
  credential: { kind: 'username', username: '' },
  requestedLifetimeSeconds: 0,
};

afterEach(() => {
  cleanup();
  useProjectStore.getState().reset();
  useUiStore.setState({ selection: undefined });
});

// The icon buttons need the shell's TooltipProvider, which tests render outside.
function render(ui: ReactElement) {
  return baseRender(<TooltipPrimitive.Provider>{ui}</TooltipPrimitive.Provider>);
}

function api(overrides: Record<string, unknown> = {}) {
  const issuedTokens = {
    status: vi.fn().mockResolvedValue({ ok: true, value: { state: 'none' } }),
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      value: { state: 'valid', expiresAt: '2026-10-05T14:32:00.000Z', samlVersion: '2.0', keyType: 'bearer' },
    }),
    clear: vi.fn().mockResolvedValue({ ok: true, value: { state: 'none' } }),
    ...overrides,
  };
  installWirebenchApi({ issuedTokens });
  return issuedTokens;
}

function fields(onChange = vi.fn<(entry: IssuedEntry) => void>(), entry: IssuedEntry = fresh, requestId?: string) {
  render(
    <IssuedTokenFields
      entry={entry}
      onChange={onChange}
      projectId="p1"
      configId="w1"
      entryIndex={2}
      requestId={requestId}
    />,
  );
  return onChange;
}

describe('IssuedTokenFields', () => {
  it('changing the credential to a certificate emits a fresh certificate credential', () => {
    api();
    const onChange = fields();
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'certificate' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { kind: 'certificate', keystoreRef: '' } }),
    );
  });

  it('a public key reveals the proof keystore picker', () => {
    api();
    fields(undefined, { ...fresh, keyType: 'public-key' });
    expect(screen.getByLabelText('Proof keystore')).toBeTruthy();
  });

  it('a bearer token has no proof keystore picker', () => {
    api();
    fields();
    expect(screen.queryByLabelText('Proof keystore')).toBeNull();
  });

  it('says Kerberos needs support while it is unavailable', () => {
    api();
    fields(undefined, { ...fresh, credential: { kind: 'kerberos', spn: '' } });
    expect(screen.getByText('Needs Kerberos support (#40).')).toBeTruthy();
  });

  it('clearing an optional field drops the key', () => {
    api();
    const onChange = fields(undefined, { ...fresh, appliesTo: 'urn:x' });
    fireEvent.change(screen.getByLabelText('Applies to'), { target: { value: '' } });
    const emitted = onChange.mock.calls[0]?.[0];
    expect(emitted).toBeDefined();
    expect(emitted !== undefined && 'appliesTo' in emitted).toBe(false);
  });

  it('shows No token cached, then fetches and shows the expiry', async () => {
    const issuedTokens = api();
    fields();
    await screen.findByText('No token cached');
    expect(issuedTokens.status).toHaveBeenCalledWith({ projectId: 'p1', configId: 'w1', entryIndex: 2 });

    fireEvent.click(screen.getByRole('button', { name: 'Fetch now' }));
    await screen.findByText(/Valid until/);
    expect(issuedTokens.fetch).toHaveBeenCalledWith({ projectId: 'p1', configId: 'w1', entryIndex: 2 });
    expect(screen.getByTestId('issued-token-state').textContent).toMatch(/SAML 2\.0 · bearer/);
  });

  it('passes the request being edited to status and fetch', async () => {
    const issuedTokens = api();
    fields(undefined, fresh, 'r1');
    await waitFor(() => {
      expect(issuedTokens.status).toHaveBeenCalledWith({
        projectId: 'p1',
        configId: 'w1',
        entryIndex: 2,
        requestId: 'r1',
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fetch now' }));
    await screen.findByText(/Valid until/);
    expect(issuedTokens.fetch).toHaveBeenCalledWith({
      projectId: 'p1',
      configId: 'w1',
      entryIndex: 2,
      requestId: 'r1',
    });
  });

  it('shows the last error with a pointer to the HTTP Log, and Clear empties the status', async () => {
    const issuedTokens = api({
      status: vi.fn().mockResolvedValue({ ok: true, value: { state: 'valid', lastError: 'The STS said no.' } }),
    });
    fields();
    await screen.findByText(/The STS said no\./);
    expect(screen.getByTestId('issued-token-error').textContent).toContain('See the STS row in the HTTP Log.');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await screen.findByText('No token cached');
    expect(issuedTokens.clear).toHaveBeenCalled();
  });
});

describe('Issued token in the outgoing editor', () => {
  const project = { id: 'p1', name: 'Demo', dir: '/tmp/demo' } as unknown as ProjectWire;

  function setUp(selectedRef: string | undefined) {
    const issuedTokens = api();
    const updateWssOutgoing = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      projects: { p1: project },
      keystores: [],
      wssOutgoing: [{ id: 'w1', name: 'Gateway', mustUnderstand: false, entries: [fresh], projectId: 'p1' }],
      requests: { r1: { id: 'r1', name: 'GetQuote', wssOutgoingRef: selectedRef } },
      updateWssOutgoing,
    } as never);
    useUiStore.setState({ selection: { kind: 'request', id: 'r1', requestId: 'r1' } });
    render(<OutgoingConfigEditor />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    return { issuedTokens, updateWssOutgoing };
  }

  it('Add entry offers an issued token and adds a fresh one', () => {
    const { updateWssOutgoing } = setUp(undefined);
    fireEvent.change(screen.getByLabelText('Add entry'), { target: { value: 'issued-token' } });
    expect(updateWssOutgoing).toHaveBeenCalledWith('w1', { entries: [fresh, fresh] });
  });

  it('passes the open request when it selects this configuration', async () => {
    const { issuedTokens } = setUp('w1');
    await waitFor(() => {
      expect(issuedTokens.status).toHaveBeenCalledWith({
        projectId: 'p1',
        configId: 'w1',
        entryIndex: 0,
        requestId: 'r1',
      });
    });
  });

  it('omits the request when it selects another configuration', async () => {
    const { issuedTokens } = setUp('other');
    await waitFor(() => {
      expect(issuedTokens.status).toHaveBeenCalledWith({ projectId: 'p1', configId: 'w1', entryIndex: 0 });
    });
  });
});
