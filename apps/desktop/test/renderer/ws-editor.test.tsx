/**
 * The WebSocket request editor and the commands that drive it.
 *
 * What a user would notice going wrong: the strip naming the wrong URL, Connect not opening a
 * session with the unsaved draft, an edit to a saved message written at once instead of staged
 * (or `Mod+S` not writing it), a per-message Send live on a closed session, an illegal
 * subprotocol accepted, `Mod+Enter` doing the wrong thing for the session's state, Escape not
 * cancelling a handshake, and the Code panel not describing the WebSocket request in front of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { WsEditor } from '../../src/renderer/features/ws-editor/ws-editor.js';
import { uniqueMessageSlug } from '../../src/renderer/features/ws-editor/messages-tab.js';
import { useWsSelectionStore } from '../../src/renderer/features/ws-editor/ws-session-actions.js';
import { registerProjectCommands } from '../../src/renderer/commands/register-project-commands.js';
import { registerRequestCommands } from '../../src/renderer/commands/register-request-commands.js';
import { resetCommands, runCommand, type CommandContext } from '../../src/renderer/lib/commands.js';
import { CodePanel } from '../../src/renderer/shell/code-panel.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import type { WsRequestWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { wsApiWire, wsRequestWire } from '../helpers/wire-defaults.js';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast, ToastViewport: () => null }));
vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const context = { platform: 'mac', ui: () => DEFAULT_UI_STATE, selection: undefined } as unknown as CommandContext;

const openWs = vi.fn();
const wsSend = vi.fn();
const wsClose = vi.fn();
const cancel = vi.fn();
const preflightWs = vi.fn();
const curl = vi.fn();

const GREETING = { id: 'm1', name: 'Greeting', slug: 'greeting', format: 'text' as const, content: '{"hi":1}' };
const PING = { id: 'm2', name: 'Ping', slug: 'ping', format: 'text' as const, content: 'ping' };

function seed(request: WsRequestWire = wsRequestWire({ messages: [GREETING, PING] })): void {
  const api = wsApiWire({ url: 'wss://chat.test' });
  useProjectStore.setState({
    wsApis: { [api.id]: api },
    wsRequests: { [request.id]: request },
    folders: {},
    projects: {},
    projectOf: { [api.id]: 'p1', [request.id]: 'p1' },
  });
}

function mount(): void {
  render(
    <TooltipPrimitive.Provider>
      <WsEditor requestId="ws-1" />
    </TooltipPrimitive.Provider>,
  );
}

function staged(): Record<string, unknown> | undefined {
  return useDraftsStore.getState().peekWsRequest('ws-1');
}

function setSession(status: 'open' | 'connecting' | 'closed'): void {
  useExchangesStore.setState({
    wsByRequest: { 'ws-1': { status, sendId: 's1', live: { frames: [], open: status === 'open' } } },
  });
}

beforeEach(() => {
  openWs.mockReset().mockReturnValue(new Promise(() => undefined));
  wsSend.mockReset().mockResolvedValue({
    ok: true,
    value: { index: 0, direction: 'sent', opcode: 'text', at: 1, size: 4, text: 'ping' },
  });
  wsClose.mockReset().mockResolvedValue({ ok: true, value: { closed: true } });
  cancel.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
  preflightWs.mockReset().mockResolvedValue({
    ok: true,
    value: {
      endpoint: 'wss://chat.test/lobby',
      endpointSource: 'environment',
      unresolved: [],
      auth: { type: 'none', source: 'none' },
      wsa: { enabled: false },
    },
  });
  curl.mockReset().mockResolvedValue({ ok: true, value: { command: "websocat 'wss://chat.test/lobby'" } });
  installWirebenchApi({ request: { openWs, wsSend, wsClose, cancel, preflightWs, curl } });
  useDraftsStore.getState().reset();
  useEditorsStore.getState().reset();
  useExchangesStore.setState({ byRequest: {}, restByRequest: {}, grpcByRequest: {}, wsByRequest: {}, log: [] });
  useWsSelectionStore.setState({ selected: {} });
  useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
  seed();
});

afterEach(() => {
  cleanup();
  resetCommands();
});

describe('WsEditor', () => {
  it('shows the path and the URL main resolved, with where it came from', async () => {
    mount();
    expect(screen.getByTestId('ws-editor')).toBeTruthy();
    expect(screen.getByTestId('ws-badge')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('ws-url').textContent).toBe('wss://chat.test/lobby');
    });
    expect(screen.getByTestId('ws-url-source').textContent).toBe('environment');
    expect(preflightWs).toHaveBeenCalledWith({ requestId: 'ws-1' });
  });

  it('connects with the unsaved draft', async () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Subprotocols' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New subprotocol' }), { target: { value: 'chat.v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByTestId('ws-connect'));
    await waitFor(() => {
      expect(openWs).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'ws-1', draft: { subprotocols: ['chat.v2'] } }),
      );
    });
    expect(screen.getByTestId('ws-connect').textContent).toContain('Cancel');
  });

  it('refuses a subprotocol with a space inline', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Subprotocols' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New subprotocol' }), { target: { value: 'chat v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toMatch(/space/);
    expect(staged()).toBeUndefined();
  });

  it('stages saved-message edits: add, rename, duplicate, reorder, delete, and content', () => {
    mount();
    const list = (): string[] =>
      within(screen.getByRole('list', { name: 'Saved messages' }))
        .getAllByTestId('ws-message-row')
        .map((row) => row.textContent);

    fireEvent.click(screen.getByTestId('ws-message-add'));
    expect(list()).toEqual(['Greeting', 'Ping', 'Message 3']);

    fireEvent.click(screen.getByRole('button', { name: 'Rename Message 3' }));
    const name = screen.getByRole('textbox', { name: 'Message name' });
    fireEvent.change(name, { target: { value: 'Bye' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(list()).toEqual(['Greeting', 'Ping', 'Bye']);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Greeting' }));
    expect(list()).toEqual(['Greeting', 'Greeting copy', 'Ping', 'Bye']);

    fireEvent.click(screen.getByRole('button', { name: 'Move Bye up' }));
    expect(list()).toEqual(['Greeting', 'Greeting copy', 'Bye', 'Ping']);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Greeting copy' }));
    expect(list()).toEqual(['Greeting', 'Bye', 'Ping']);

    fireEvent.click(screen.getByRole('button', { name: 'Greeting' }));
    fireEvent.change(screen.getByLabelText('Saved message'), { target: { value: '{"hi":2}' } });
    const messages = staged()?.['messages'] as { name: string; content: string; slug: string }[];
    expect(messages.map((message) => message.name)).toEqual(['Greeting', 'Bye', 'Ping']);
    expect(messages[0]!.content).toBe('{"hi":2}');
    expect(messages[1]!.slug).toBe('message-3');
  });

  it('enables a saved message’s Send only while open, and sends it', async () => {
    mount();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send Ping' }).disabled).toBe(true);
    setSession('open');
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send Ping' }).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Ping' }));
    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith({
        sendId: 's1',
        requestId: 'ws-1',
        format: 'text',
        content: 'ping',
        expand: true,
      });
    });
  });

  it('shows the trust-invalid badge once the setting is on', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.queryByTestId('ws-trust-invalid-badge')).toBeNull();
    fireEvent.click(screen.getByTestId('ws-setting-trust-invalid'));
    expect(screen.getByTestId('ws-trust-invalid-badge')).toBeTruthy();
    expect(staged()).toEqual({ settings: { trustInvalid: true } });
  });

  it('makes a new message’s slug file-safe and unique', () => {
    expect(uniqueMessageSlug('Hello World!', [])).toBe('hello-world');
    expect(uniqueMessageSlug('Ping', ['ping', 'ping-2'])).toBe('ping-3');
    expect(uniqueMessageSlug('***', [])).toBe('message');
  });
});

describe('the WebSocket commands', () => {
  beforeEach(() => {
    registerRequestCommands();
    registerProjectCommands();
    useEditorsStore.setState({
      tabs: [{ id: 'ws:ws-1', kind: 'ws-request', title: 'Lobby', wsRequestId: 'ws-1' }],
      activeId: 'ws:ws-1',
    });
  });

  it('Mod+Enter connects a closed session', async () => {
    await runCommand('ws.connect', context);
    await waitFor(() => {
      expect(openWs).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'ws-1' }));
    });
  });

  it('Mod+Enter sends the selected saved message on an open session', async () => {
    setSession('open');
    useWsSelectionStore.getState().select('ws-1', 'm2');
    await runCommand('ws.connect', context);
    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({ content: 'ping' }));
    });
    expect(openWs).not.toHaveBeenCalled();
  });

  it('toasts a failed send from Mod+Enter and from ws.sendMessage', async () => {
    showToast.mockReset();
    wsSend.mockResolvedValue({ ok: false, error: { code: 'ws-session-closed', message: 'the connection is closed' } });
    setSession('open');
    await runCommand('ws.connect', context);
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('ws-session-closed: the connection is closed');
    });
    showToast.mockReset();
    // A second failure with the same error is still a new failure.
    useExchangesStore.setState({
      wsByRequest: { 'ws-1': { status: 'open', sendId: 's1', live: { frames: [], open: true } } },
    });
    await runCommand('ws.sendMessage', context);
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('ws-session-closed: the connection is closed');
    });
  });

  it('Escape cancels a handshake in progress, and only then', async () => {
    setSession('open');
    await expect(runCommand('request.cancel', context)).resolves.toBe(false);
    setSession('connecting');
    await expect(runCommand('request.cancel', context)).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledWith({ sendId: 's1' });
  });

  it('cancelWs does nothing once the session is open', async () => {
    setSession('open');
    await useExchangesStore.getState().cancelWs('ws-1');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('disconnects with a normal close', async () => {
    setSession('open');
    await runCommand('ws.disconnect', context);
    expect(wsClose).toHaveBeenCalledWith({ sendId: 's1', code: 1000 });
  });

  it('Mod+S saves the WebSocket tab’s staged edits', async () => {
    const saveWsRequest = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ saveWsRequest });
    await runCommand('item.save', context);
    expect(saveWsRequest).toHaveBeenCalledWith('ws-1', { manual: true });
  });

  it('copies the command line, the draft included', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useProjectStore.getState().editWsRequest('ws-1', { subprotocols: ['chat.v2'] });
    await runCommand('ws.copyAsCommand', context);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("websocat 'wss://chat.test/lobby'");
    });
    expect(curl).toHaveBeenCalledWith({ requestId: 'ws-1', shell: 'posix', wsDraft: { subprotocols: ['chat.v2'] } });
  });

  it('the Code panel shows the WebSocket request’s command', async () => {
    render(<CodePanel />);
    await waitFor(() => {
      expect(screen.getByTestId('code-panel-preview').textContent).toContain('websocat');
    });
    expect(curl).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'ws-1' }));
  });
});
