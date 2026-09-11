import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WsaInspector } from '../../src/renderer/features/request-editor/inspectors/wsa-inspector.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';
import type { WsaConfigWire } from '../../src/shared/wire-types.js';

const updateRequestWsa = vi.fn();

function install(
  own: WsaConfigWire | undefined,
  interfaceWsa: WsaConfigWire,
  options?: { readonly wsaOptional?: boolean; readonly effectiveEnabled?: boolean },
): void {
  useProjectStore.setState({
    requests: { 'req-1': makeDraft(own !== undefined ? { wsa: own } : {}) },
    interfaces: {
      'if-1': {
        id: 'if-1',
        wsaConfig: interfaceWsa,
        ...(options?.wsaOptional === true ? { wsa: { enabled: false, optional: true, version: '2005/08' } } : {}),
      },
    },
    updateRequestWsa,
  } as never);
  const effectiveEnabled = options?.effectiveEnabled ?? true;
  installWirebenchApi({
    request: {
      preflight: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          endpointSource: 'interface-default',
          unresolved: [],
          auth: { source: 'none', type: 'none' },
          wsa: effectiveEnabled
            ? { enabled: true, action: 'urn:a', to: 'http://e', messageId: 'auto' }
            : { enabled: false },
        },
      }),
    },
  });
}

describe('WsaInspector', () => {
  beforeEach(() => {
    updateRequestWsa.mockClear();
    install(undefined, { enabled: true, action: 'urn:iface' });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('inherits by default, showing the interface values greyed out', () => {
    render(<WsaInspector requestId="req-1" />);

    expect(screen.getByTestId('wsa-inherit')).toHaveProperty('checked', true);
    expect(screen.getByTestId('wsa-enabled')).toHaveProperty('checked', true);
    expect(screen.getByTestId('wsa-enabled')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('wsa-action')).toHaveProperty('value', 'urn:iface');
  });

  it('reports the headers a send would actually carry', async () => {
    render(<WsaInspector requestId="req-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('wsa-effective').textContent).toContain('urn:a');
    });
  });

  it('notes when the WSDL only offers optional WS-Addressing and it is off', async () => {
    install(undefined, { enabled: false }, { wsaOptional: true, effectiveEnabled: false });
    render(<WsaInspector requestId="req-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('wsa-offers-optional').textContent).toContain('WSDL offers WS-Addressing (optional)');
    });
  });

  it('does not show the optional note once addressing is actually enabled', async () => {
    install(undefined, { enabled: true, action: 'urn:iface' }, { wsaOptional: true, effectiveEnabled: true });
    render(<WsaInspector requestId="req-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('wsa-effective').textContent).toContain('urn:a');
    });
    expect(screen.queryByTestId('wsa-offers-optional')).toBeNull();
  });

  it('unchecking inherit copies the interface configuration onto the request', async () => {
    render(<WsaInspector requestId="req-1" />);

    await userEvent.click(screen.getByTestId('wsa-inherit'));

    expect(updateRequestWsa).toHaveBeenCalledWith('req-1', { enabled: true, action: 'urn:iface' });
  });

  it('edits the request’s own configuration field by field', async () => {
    install({ enabled: true, action: 'urn:own' }, { enabled: false });
    render(<WsaInspector requestId="req-1" />);

    expect(screen.getByTestId('wsa-inherit')).toHaveProperty('checked', false);
    await userEvent.click(screen.getByTestId('wsa-must-understand'));
    await userEvent.selectOptions(screen.getByTestId('wsa-must-understand'), 'true');

    expect(updateRequestWsa).toHaveBeenCalledWith('req-1', {
      enabled: true,
      action: 'urn:own',
      mustUnderstand: 'true',
    });
  });

  it('disables the MessageID field while it is auto, and enables it once fixed', async () => {
    install({ enabled: true }, { enabled: false });
    render(<WsaInspector requestId="req-1" />);

    expect(screen.getByTestId('wsa-message-id')).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByTestId('wsa-message-id-auto'));

    expect(updateRequestWsa).toHaveBeenCalledWith('req-1', { enabled: true, messageId: '' });
  });
});
