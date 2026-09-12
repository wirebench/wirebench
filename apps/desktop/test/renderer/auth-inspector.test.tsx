import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthInspector } from '../../src/renderer/features/request-editor/inspectors/auth-inspector.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';
import type { EndpointAuthWire, RequestAuthSourceWire } from '../../src/shared/wire-types.js';

const updateRequestAuth = vi.fn();

function install(auth: EndpointAuthWire | undefined, source: RequestAuthSourceWire): void {
  useProjectStore.setState({
    requests: { 'req-1': makeDraft(auth !== undefined ? { auth } : {}) },
    updateRequestAuth,
  } as never);
  installWirebenchApi({
    request: {
      preflight: vi
        .fn()
        .mockResolvedValue({ ok: true, value: { endpointSource: 'interface-default', unresolved: [], auth: source } }),
    },
    secrets: { set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-new' } }) },
  });
}

describe('AuthInspector', () => {
  beforeEach(() => {
    updateRequestAuth.mockClear();
    install(undefined, {
      source: 'endpoint',
      type: 'basic',
      username: 'end',
      endpointName: 'Primary',
      authMode: 'override',
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('inherits by default and names where the effective credentials come from', async () => {
    render(<AuthInspector requestId="req-1" />);

    expect(screen.getByTestId('auth-inherit')).toHaveProperty('checked', true);
    expect(screen.queryByLabelText('Authentication type')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('auth-effective').textContent).toBe("Using endpoint 'Primary' credentials (override)");
    });
  });

  it('unchecking inherit gives the request its own Basic, preemptive credentials', async () => {
    render(<AuthInspector requestId="req-1" />);

    await userEvent.click(screen.getByTestId('auth-inherit'));

    expect(updateRequestAuth).toHaveBeenCalledWith('req-1', { type: 'basic', preemptive: true });
  });

  it('checking inherit clears the request credentials', async () => {
    install({ type: 'basic', username: 'ada' }, { source: 'request', type: 'basic', username: 'ada' });
    render(<AuthInspector requestId="req-1" />);

    await userEvent.click(screen.getByTestId('auth-inherit'));

    expect(updateRequestAuth).toHaveBeenCalledWith('req-1', null);
  });

  it('commits a typed username once, after the debounce', async () => {
    install({ type: 'basic' }, { source: 'request', type: 'basic' });
    render(<AuthInspector requestId="req-1" />);

    await userEvent.type(screen.getByLabelText('Username'), 'ada');

    await waitFor(() => {
      expect(updateRequestAuth).toHaveBeenCalledWith('req-1', { type: 'basic', username: 'ada' });
    });
    // Debounced: three keystrokes are one mutation, not three.
    expect(updateRequestAuth).toHaveBeenCalledTimes(1);
  });

  it('toggles preemptive, which Basic defaults to on', async () => {
    install({ type: 'basic', username: 'ada' }, { source: 'request', type: 'basic', username: 'ada' });
    render(<AuthInspector requestId="req-1" />);

    expect(screen.getByTestId('auth-preemptive')).toHaveProperty('checked', true);
    await userEvent.click(screen.getByTestId('auth-preemptive'));

    expect(updateRequestAuth).toHaveBeenCalledWith('req-1', { type: 'basic', username: 'ada', preemptive: false });
  });

  it('shows the NTLM domain field only for NTLM, and no password field for None', async () => {
    install({ type: 'basic', username: 'ada' }, { source: 'request', type: 'basic', username: 'ada' });
    render(<AuthInspector requestId="req-1" />);
    expect(screen.queryByLabelText('Domain')).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Authentication type'), 'ntlm');
    expect(updateRequestAuth).toHaveBeenCalledWith('req-1', { type: 'ntlm', username: 'ada' });

    cleanup();
    install({ type: 'ntlm', username: 'ada' }, { source: 'request', type: 'ntlm', username: 'ada' });
    render(<AuthInspector requestId="req-1" />);
    expect(screen.getByLabelText('Domain')).toBeDefined();
    expect(screen.queryByTestId('auth-preemptive')).toBeNull();

    cleanup();
    install({ type: 'none' }, { source: 'none', type: 'none' });
    render(<AuthInspector requestId="req-1" />);
    expect(screen.queryByLabelText('Username')).toBeNull();
  });

  it('stores a typed password through the secret store and keeps only the ref', async () => {
    install({ type: 'basic', username: 'ada' }, { source: 'request', type: 'basic', username: 'ada' });
    render(<AuthInspector requestId="req-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateRequestAuth).toHaveBeenCalledWith('req-1', {
        type: 'basic',
        username: 'ada',
        passwordRef: 'ref-new',
      });
    });
    expect(JSON.stringify(updateRequestAuth.mock.calls)).not.toContain('hunter2');
  });

  it('flushes a still-debounced username edit on unmount instead of dropping it', async () => {
    install({ type: 'basic', username: 'ada' }, { source: 'request', type: 'basic', username: 'ada' });
    const { unmount } = render(<AuthInspector requestId="req-1" />);

    await userEvent.type(screen.getByLabelText('Username'), 'x');
    // Unmount well within the 300ms debounce window: nothing has committed yet.
    expect(updateRequestAuth).not.toHaveBeenCalled();
    unmount();

    expect(updateRequestAuth).toHaveBeenCalledWith('req-1', { type: 'basic', username: 'adax' });
  });

  it('flushes an unsaved-but-typed password through SecretField on unmount', async () => {
    install({ type: 'basic', username: 'ada' }, { source: 'request', type: 'basic', username: 'ada' });
    installWirebenchApi({
      request: {
        preflight: vi.fn().mockResolvedValue({
          ok: true,
          value: { endpointSource: 'interface-default', unresolved: [], auth: { source: 'request', type: 'basic' } },
        }),
      },
      secrets: { set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-flushed' } }) },
    });
    const { unmount } = render(<AuthInspector requestId="req-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    // No Save click: the value is still only a local draft when the inspector unmounts.
    unmount();

    await waitFor(() => {
      expect(updateRequestAuth).toHaveBeenCalledWith('req-1', {
        type: 'basic',
        username: 'ada',
        passwordRef: 'ref-flushed',
      });
    });
  });

  it('clearing the password drops passwordRef entirely rather than setting it to undefined', async () => {
    install(
      { type: 'basic', username: 'ada', passwordRef: 'ref-old' },
      { source: 'request', type: 'basic', username: 'ada' },
    );
    render(<AuthInspector requestId="req-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(updateRequestAuth).toHaveBeenCalledTimes(1);
    const sent = updateRequestAuth.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('passwordRef' in sent).toBe(false);
    expect(sent).toEqual({ type: 'basic', username: 'ada' });
  });
});

describe('AuthInspector WS-Security selectors', () => {
  afterEach(() => {
    cleanup();
    useProjectStore.setState({ wssOutgoing: [], wssIncoming: [] } as never);
  });

  it('selects an outgoing configuration and clears it again', async () => {
    const editRequest = vi.fn();
    install(undefined, { source: 'none', type: 'none' });
    useProjectStore.setState({
      requests: { 'req-1': makeDraft({}) },
      wssOutgoing: [{ id: 'w1', name: 'Gateway', mustUnderstand: false, entries: [] }],
      editRequest,
    } as never);
    render(<AuthInspector requestId="req-1" />);

    await userEvent.selectOptions(screen.getByLabelText('Outgoing WSS'), 'w1');
    expect(editRequest).toHaveBeenCalledWith('req-1', { wssOutgoingRef: 'w1' });

    useProjectStore.setState({
      requests: { 'req-1': makeDraft({ wssOutgoingRef: 'w1' }) },
    } as never);
    await userEvent.selectOptions(screen.getByLabelText('Outgoing WSS'), '');
    expect(editRequest).toHaveBeenLastCalledWith('req-1', { wssOutgoingRef: null });
  });

  it('keeps a ref the project no longer has selectable', () => {
    install(undefined, { source: 'none', type: 'none' });
    useProjectStore.setState({
      requests: { 'req-1': makeDraft({ wssOutgoingRef: 'gone' }) },
      wssOutgoing: [],
      wssIncoming: [],
    } as never);
    render(<AuthInspector requestId="req-1" />);
    expect(screen.getByText('gone (missing)')).toBeTruthy();
    expect(screen.getByLabelText('Incoming WSS')).toBeTruthy();
  });
});
