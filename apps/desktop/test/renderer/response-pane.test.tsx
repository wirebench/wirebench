import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResponsePane } from '../../src/renderer/features/request-editor/response-pane.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useSnapshotsStore } from '../../src/renderer/state/snapshots.js';
import { b64, makeExchange } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

describe('ResponsePane', () => {
  afterEach(() => {
    cleanup();
  });

  it('invites a first send when nothing has been sent', () => {
    render(<ResponsePane state={undefined} requestId="r1" />);
    expect(screen.getByText('No response yet')).toBeDefined();
  });

  it('shows the cancellable spinner while sending', () => {
    render(<ResponsePane state={{ status: 'sending', sendId: 's' }} requestId="r2" />);
    expect(screen.getByRole('status').textContent).toContain('Sending… (Esc to cancel)');
  });

  it('renders the status line and the formatted envelope for a 200', () => {
    render(<ResponsePane state={{ status: 'done', exchange: makeExchange() }} requestId="r3" />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('200 OK');
    expect(status.textContent).toContain('143 ms');
    expect(status.textContent).toContain('B');

    const editor = screen.getByLabelText<HTMLTextAreaElement>('Response envelope XML');
    expect(editor.readOnly).toBe(true);
    expect(editor.value.split('\n').length).toBeGreaterThan(1);
    expect(editor.value).toContain('<AddResult>7</AddResult>');
  });

  it('flags a SOAP fault in red', () => {
    const faulted = makeExchange({
      http: { ...makeExchange().http, status: 500, statusText: 'Internal Server Error' },
      response: {
        envelopeXml: '<Envelope><Body><Fault/></Body></Envelope>',
        isSoap: true,
        attachments: [],
        version: '1.1',
        fault: { version: '1.1', code: 'soap:Server', subcodes: [], reason: 'boom' },
      },
    });
    render(<ResponsePane state={{ status: 'done', exchange: faulted }} requestId="r4" />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('SOAP Fault: soap:Server');
    expect(status.innerHTML).toContain('text-status-danger');
  });

  it('shows the error code and message when the send itself failed', () => {
    render(
      <ResponsePane
        state={{ status: 'error', error: { code: 'network-error', message: 'ECONNREFUSED' } }}
        requestId="r5"
      />,
    );

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('network-error');
    expect(status.textContent).toContain('ECONNREFUSED');
    expect(status.className).toContain('text-status-danger');
  });

  it('shows the raw body as text when the response is not SOAP', () => {
    const base = makeExchange();
    const nonSoap = makeExchange({
      http: { ...base.http, status: 404, statusText: 'Not Found', bodyBase64: b64('no such endpoint') },
      response: { envelopeXml: '', isSoap: false, attachments: [] },
    });
    render(<ResponsePane state={{ status: 'done', exchange: nonSoap }} requestId="r6" />);

    expect(screen.getByText('no such endpoint')).toBeDefined();
    expect(screen.queryByLabelText('Response envelope XML')).toBeNull();
  });

  describe('Snapshot tab', () => {
    /** Opens the Snapshot tab for `requestId` with no golden saved yet; returns the write spy. */
    function openSnapshotTab(requestId: string) {
      useSnapshotsStore.setState({ entries: {}, failed: {} });
      useEditorsStore.getState().setResponseView(requestId, 'snapshot');
      const write = vi.fn().mockResolvedValue({ ok: true, value: { savedAt: '2026-09-22T11:00:00.000Z' } });
      installWirebenchApi({
        snapshot: { read: vi.fn().mockResolvedValue({ ok: true, value: { status: 'none' } }), write },
      });
      return write;
    }

    it('saves the unpacked envelope of a multipart reply, typed by its SOAP version', async () => {
      const write = openSnapshotTab('r7');
      const envelope = '<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><Ok/></Body></Envelope>';
      const base = makeExchange();
      const mtom = makeExchange({
        http: {
          ...base.http,
          headers: { 'content-type': 'multipart/related; type="application/xop+xml"; boundary=b' },
          bodyBase64: b64(`--b\r\nContent-Type: application/xop+xml\r\n\r\n${envelope}\r\n--b--`),
        },
        response: { envelopeXml: envelope, version: '1.2', isSoap: true, attachments: [] },
      });
      render(<ResponsePane state={{ status: 'done', exchange: mtom }} requestId="r7" />);
      await userEvent.click(await screen.findByRole('button', { name: 'Save as snapshot' }));
      expect(write).toHaveBeenCalledWith({
        requestId: 'r7',
        body: envelope,
        contentType: 'application/soap+xml',
        ignore: [],
      });
    });

    it('saves the decoded HTTP body when there is no SOAP envelope', async () => {
      const write = openSnapshotTab('r8');
      const base = makeExchange();
      const plain = makeExchange({
        http: { ...base.http, headers: { 'content-type': 'text/plain' }, bodyBase64: b64('no such endpoint') },
        response: { envelopeXml: '', isSoap: false, attachments: [] },
      });
      render(<ResponsePane state={{ status: 'done', exchange: plain }} requestId="r8" />);
      await userEvent.click(await screen.findByRole('button', { name: 'Save as snapshot' }));
      expect(write).toHaveBeenCalledWith({
        requestId: 'r8',
        body: 'no such endpoint',
        contentType: 'text/plain',
        ignore: [],
      });
    });

    it('offers no save for a reply with no text body', async () => {
      const write = openSnapshotTab('r9');
      const base = makeExchange();
      const empty = makeExchange({ http: { ...base.http, status: 202, bodyBase64: '' } });
      delete (empty as { response?: unknown }).response;
      render(<ResponsePane state={{ status: 'done', exchange: empty }} requestId="r9" />);
      expect(await screen.findByText('This response has no text body to compare.')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Save as snapshot' })).toBeNull();
      expect(write).not.toHaveBeenCalled();
    });
  });
});
