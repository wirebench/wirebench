import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResponsePane } from '../../src/renderer/features/request-editor/response-pane.js';
import { b64, makeExchange } from '../mocks/exchange-fixtures.js';

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
      response: { envelopeXml: '', isSoap: false },
    });
    render(<ResponsePane state={{ status: 'done', exchange: nonSoap }} requestId="r6" />);

    expect(screen.getByText('no such endpoint')).toBeDefined();
    expect(screen.queryByLabelText('Response envelope XML')).toBeNull();
  });
});
