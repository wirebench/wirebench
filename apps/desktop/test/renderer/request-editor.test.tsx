import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestEditor } from '../../src/renderer/features/request-editor/request-editor.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { makeDraft, makeExchange, makeInterface } from '../mocks/exchange-fixtures.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const send = vi.fn();
const cancel = vi.fn();

function stubWirebench(): void {
  Object.defineProperty(window, 'wirebench', {
    configurable: true,
    value: { request: { send, cancel } },
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

  it('shows the response once the send resolves', async () => {
    render(<RequestEditor requestId="req-1" />);

    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('200 OK');
    });
    expect(useExchangesStore.getState().log).toHaveLength(1);
  });
});
