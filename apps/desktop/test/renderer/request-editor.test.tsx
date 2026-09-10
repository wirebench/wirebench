import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestEditor } from '../../src/renderer/features/request-editor/request-editor.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { makeDraft, makeExchange, makeInterface } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { getActiveRequestPaneHandle } from '../../src/renderer/editor/active-request-editor.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const send = vi.fn();
const cancel = vi.fn();

function stubWirebench(): void {
  installWirebenchApi({
    request: { send, cancel },
    // Envelope edits are mutations now; the reply echoes back what the store already applied
    // optimistically, so these tests can keep asserting on the store alone.
    project: {
      mutate: vi.fn().mockResolvedValue({ ok: false, error: { code: 'ignored', message: 'not asserted here' } }),
    },
  });
}

describe('RequestEditor', () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue({ ok: true, value: makeExchange() });
    cancel.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
    stubWirebench();
    useProjectStore.setState({
      interfaces: { 'if-1': makeInterface() },
      requests: { 'req-1': makeDraft() },
      order: ['if-1'],
    });
    useExchangesStore.setState({ byRequest: {}, log: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('writes the edited envelope back to the draft after the debounce', async () => {
    render(<RequestEditor requestId="req-1" />);

    const editor = screen.getByLabelText('Request envelope XML');
    editor.focus();
    // `skipClick`: the resizable-panel group swallows the synthetic pointer sequence, which is
    // a jsdom artefact — real Monaco is not a textarea and takes focus on click perfectly well.
    await userEvent.type(editor, '<!-- edited -->', { skipClick: true });

    await waitFor(() => {
      expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toContain('<!-- edited -->');
    });
  });

  it('sends on Mod+Enter from inside the editor', async () => {
    render(<RequestEditor requestId="req-1" />);

    const editor = screen.getByLabelText('Request envelope XML');
    editor.focus();
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

    await waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    const payload = send.mock.calls[0]?.[0] as { input: { endpoint: string } } | undefined;
    expect(payload?.input.endpoint).toBe('https://example.test/calc.asmx');
  });

  it('flushes a pending debounced edit before sending on Mod+Enter', async () => {
    render(<RequestEditor requestId="req-1" />);

    const editor = screen.getByLabelText('Request envelope XML');
    editor.focus();
    await userEvent.type(editor, '<!-- fresh -->', { skipClick: true });
    // Trigger the send immediately — well inside the 120ms debounce window — so the store still
    // holds the old text unless the send path flushes the pending edit itself.
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

    await waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toContain('<!-- fresh -->');
  });

  it('flushes a pending debounced edit before sending via the toolbar button', async () => {
    render(<RequestEditor requestId="req-1" />);

    const editor = screen.getByLabelText('Request envelope XML');
    editor.focus();
    await userEvent.type(editor, '<!-- fresh -->', { skipClick: true });
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toContain('<!-- fresh -->');
  });

  it('flushes a pending debounced edit to the store on unmount', async () => {
    const { unmount } = render(<RequestEditor requestId="req-1" />);

    const editor = screen.getByLabelText('Request envelope XML');
    editor.focus();
    await userEvent.type(editor, '<!-- unmounted -->', { skipClick: true });
    unmount();

    expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toContain('<!-- unmounted -->');
  });

  it('cancels on Escape while a send is in flight', async () => {
    useExchangesStore.setState({ byRequest: { 'req-1': { status: 'sending', sendId: 'send-1' } }, log: [] });
    render(<RequestEditor requestId="req-1" />);

    screen.getByLabelText('Request envelope XML').focus();
    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledWith({ sendId: 'send-1' });
    });
  });

  it('ignores Escape when nothing is in flight', async () => {
    render(<RequestEditor requestId="req-1" />);

    screen.getByLabelText('Request envelope XML').focus();
    await userEvent.keyboard('{Escape}');

    expect(cancel).not.toHaveBeenCalled();
  });

  it('commits formatted text immediately via formatAndCommit, not after debounce', () => {
    // This test verifies the fix: formatAndCommit() commits the formatted text synchronously
    // to the store, so a Send fired immediately after Format gets the correct text.
    const unformattedXml = '<soapenv:Envelope><soapenv:Body><test/></soapenv:Body></soapenv:Envelope>';
    useProjectStore.setState({
      interfaces: { 'if-1': makeInterface() },
      requests: { 'req-1': makeDraft({ envelopeXml: unformattedXml }) },
      order: ['if-1'],
    });
    render(<RequestEditor requestId="req-1" />);

    const editor = screen.getByLabelText('Request envelope XML');
    editor.focus();

    // Trigger the Format keybinding via the registered handler (the mock editor's onKeyDown
    // may not fire the handler reliably with userEvent.keyboard, so we access it directly).
    const handle = getActiveRequestPaneHandle();
    if (handle !== undefined) {
      handle.formatAndCommit();
    }

    // The store should have the formatted text immediately (synchronously committed by formatAndCommit),
    // not waiting for the 120ms onChange debounce timer.
    const storeValue = useProjectStore.getState().requests['req-1']?.envelopeXml;
    // The key assertion: the formatted text contains indented Body element
    expect(storeValue).toContain('   <soapenv:Body>');
  });

  it('runs editor.formatXml palette command and commits formatted text synchronously', async () => {
    const unformattedXml = '<soapenv:Envelope><soapenv:Body><test/></soapenv:Body></soapenv:Envelope>';
    useProjectStore.setState({
      interfaces: { 'if-1': makeInterface() },
      requests: { 'req-1': makeDraft({ envelopeXml: unformattedXml }) },
      order: ['if-1'],
    });

    // Set up the editors store with an active request tab so the command's `when` condition passes.
    useEditorsStore.setState({
      tabs: [{ id: 'tab-1', kind: 'request' as const, requestId: 'req-1', title: 'Request 1' }],
      activeId: 'tab-1',
    });

    render(<RequestEditor requestId="req-1" />);

    // Register shell commands and set up the context.
    resetCommands();
    registerShellCommands(vi.fn());

    const context: CommandContext = {
      platform: 'mac',
      ui: {
        sidebar: { visible: true, view: 'explorer', size: 20 },
        console: { visible: true, activeTab: 'http-log', size: 25 },
        details: { visible: true, size: 20 },
        theme: 'dark',
        editorLineNumbers: true,
      },
      selection: undefined,
    };

    // Run the palette command.
    const result = await runCommand('editor.formatXml', context);
    expect(result).toBe(true);

    // The store should have the formatted text immediately, synchronously committed.
    const storeValue = useProjectStore.getState().requests['req-1']?.envelopeXml;
    expect(storeValue).toContain('   <soapenv:Body>');
  });

  it('overflow-menu Format path calls formatAndCommit and commits formatted text synchronously', () => {
    // This test verifies that the overflow menu's Format action (via getActiveRequestPaneHandle)
    // commits formatted text to the store immediately.
    const unformattedXml = '<soapenv:Envelope><soapenv:Body><test/></soapenv:Body></soapenv:Envelope>';
    useProjectStore.setState({
      interfaces: { 'if-1': makeInterface() },
      requests: { 'req-1': makeDraft({ envelopeXml: unformattedXml }) },
      order: ['if-1'],
    });
    render(<RequestEditor requestId="req-1" />);

    // Simulate what the overflow menu does: call formatAndCommit() via the active request pane handle.
    const handle = getActiveRequestPaneHandle();
    expect(handle).toBeDefined();
    if (handle !== undefined) {
      handle.formatAndCommit();
    }

    // The store should have the formatted text immediately, synchronously committed.
    const storeValue = useProjectStore.getState().requests['req-1']?.envelopeXml;
    expect(storeValue).toContain('   <soapenv:Body>');
  });

  it('shows the response once the send resolves', async () => {
    render(<RequestEditor requestId="req-1" />);

    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('200 OK');
    });
    expect(useExchangesStore.getState().log).toHaveLength(1);
  });

  it('editing a value in the request Outline writes the change back through the store', async () => {
    useProjectStore.setState({
      interfaces: { 'if-1': makeInterface() },
      requests: {
        'req-1': makeDraft({ envelopeXml: '<soap:Envelope><soap:Body><Add>1</Add></soap:Body></soap:Envelope>' }),
      },
      order: ['if-1'],
    });
    render(<RequestEditor requestId="req-1" />);

    const outlineTabs = screen.getAllByRole('tab', { name: 'Outline' });
    // The first Outline tab belongs to the request pane.
    await userEvent.click(outlineTabs[0] as HTMLElement);
    // The resizable-panel layout settles (measures itself and re-renders) shortly after mount;
    // wait for that to finish before locating the row, so the element isn't stale mid-edit.
    await waitFor(() => {
      expect(document.querySelector('[data-row-id="0/0/0"]')).not.toBeNull();
    });
    const row = document.querySelector('[data-row-id="0/0/0"]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: '1' }));
    const input = within(row).getByDisplayValue('1');
    // `fireEvent` (unlike `userEvent.type`) fires no events between characters, so the whole
    // edit completes in one tick — immune to the same layout re-render mid-sequence.
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toContain('<Add>9</Add>');
    });
  });

  it('the response Outline renders no editable inputs', async () => {
    render(<RequestEditor requestId="req-1" />);
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('200 OK');
    });

    const outlineTabs = screen.getAllByRole('tab', { name: 'Outline' });
    // The second Outline tab belongs to the response pane.
    await userEvent.click(outlineTabs[1] as HTMLElement);

    expect(screen.getByRole('tree', { name: 'Response outline' })).toBeDefined();
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });
});
