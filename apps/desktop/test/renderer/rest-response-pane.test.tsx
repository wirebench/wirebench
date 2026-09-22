/**
 * The REST response pane and its tabs.
 *
 * The cases worth having: the status line reads by class rather than by "did it work" (a 404 is an
 * answer), each tab says something useful when it has nothing to show, a repeated `Set-Cookie` stays
 * repeated, an image preview builds and revokes its blob URL, the pretty view steps aside for a body
 * too large to reformat, and *Save response* names only the send — the bytes never cross the bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { RestResponsePane } from '../../src/renderer/features/rest-editor/response/response-pane.js';
import { hexLines } from '../../src/renderer/features/rest-editor/response/body-view.js';
import { statusToneClass } from '../../src/renderer/features/rest-editor/response/status-line.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { b64, makeRestExchange } from '../mocks/exchange-fixtures.js';
import type { RestEventStreamWire, RestExchangeSummary, SseRowWire } from '../../src/shared/wire-types.js';
import { eventStreamDocument } from '@wirebench/engine/rest';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

/** The Query view's own behaviour is tested apart; here what matters is the document it is handed. */
const queryViewProps = vi.fn();
vi.mock('../../src/renderer/features/request-editor/views/lazy-views.js', () => ({
  QueryView: (props: Record<string, unknown>) => {
    queryViewProps(props);
    return <div data-testid="query-view-stub" />;
  },
}));

const saveRestBody = vi.fn();

function mount(exchange?: RestExchangeSummary, extra: Record<string, unknown> = {}): void {
  render(
    <TooltipPrimitive.Provider>
      <RestResponsePane
        requestId="rest-1"
        state={exchange === undefined ? undefined : { status: 'done', sendId: 'send-1', exchange, ...extra }}
      />
    </TooltipPrimitive.Provider>,
  );
}

beforeEach(() => {
  saveRestBody.mockReset().mockResolvedValue({ ok: true, value: { path: '/tmp/response.json' } });
  installWirebenchApi({ exchanges: { saveRestBody } });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
});

afterEach(() => {
  cleanup();
});

describe('statusToneClass', () => {
  it('colours by class, so a 404 reads as a client error rather than a failure', () => {
    expect(statusToneClass(200)).toContain('success');
    expect(statusToneClass(302)).toContain('info');
    expect(statusToneClass(404)).toContain('warning');
    expect(statusToneClass(500)).toContain('danger');
  });
});

describe('RestResponsePane', () => {
  it('says nothing has been sent yet, with no tabs to open', () => {
    mount();

    expect(screen.getByText('Send the request to see its response.')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Body' })).toBeNull();
  });

  it('shows the status, the duration and the size', () => {
    mount(makeRestExchange());

    const status = screen.getByTestId('rest-response-status').textContent ?? '';
    expect(status).toContain('200 OK');
    expect(status).toContain('12 ms');
    expect(status).toContain('body');
  });

  it('shows a send failure instead of a status', () => {
    render(
      <TooltipPrimitive.Provider>
        <RestResponsePane
          requestId="rest-1"
          state={{ status: 'error', sendId: 's1', error: { code: 'dns', message: 'not found' } }}
        />
      </TooltipPrimitive.Provider>,
    );

    expect(screen.getByTestId('rest-response-status').textContent).toContain('dns');
  });

  it('calls out a redirect that changed the method', () => {
    mount(makeRestExchange({ methodChanged: true }));
    expect(screen.getByTestId('rest-response-status').textContent).toContain('redirected as GET');
  });

  it('shows the body pretty-printed by default', () => {
    mount(makeRestExchange({ text: '{"a":1}' }));

    expect(screen.getByTestId('rest-response-body')).toBeTruthy();
    expect(screen.getByTestId('rest-response-view-pretty-panel')).toBeTruthy();
  });

  it('disables Pretty and starts on Raw for a body too large to reformat', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES_WIRE, rest: { ...DEFAULT_PREFERENCES_WIRE.rest, prettyPrintMaxBytes: 4 } },
      loaded: true,
    });
    mount(makeRestExchange({ text: '{"a":12345}' }));

    expect(screen.getByTestId<HTMLButtonElement>('rest-response-view-pretty').disabled).toBe(true);
    expect(screen.getByTestId('rest-response-view-raw-panel')).toBeTruthy();
  });

  it('shows the raw body line by line', () => {
    mount(makeRestExchange({ text: 'line one\nline two' }));

    fireEvent.click(screen.getByTestId('rest-response-view-raw'));
    expect(screen.getByTestId('rest-response-raw')).toBeTruthy();
  });

  it('renders an image preview from the body bytes, and revokes the URL on unmount', () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const createObjectURL = vi.fn(() => {
      const url = `blob:${String(created.length)}`;
      created.push(url);
      return url;
    });
    const revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    mount(
      makeRestExchange({
        language: 'image',
        text: '',
        http: { ...makeRestExchange().http, headers: { 'content-type': 'image/png' }, bodyBase64: b64('PNGBYTES') },
      }),
    );

    expect(screen.getByTestId('rest-response-image').getAttribute('src')).toBe('blob:0');
    cleanup();
    expect(revoked).toEqual(['blob:0']);
  });

  it('shows a hex dump for a body that is neither text nor an image', () => {
    mount(
      makeRestExchange({
        language: 'binary',
        text: '',
        http: { ...makeRestExchange().http, headers: { 'content-type': 'application/octet-stream' } },
      }),
    );

    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    expect(screen.getByTestId('rest-response-hex').textContent).toContain('00000000');
  });

  it('keeps a repeated response header, in order', () => {
    mount(
      makeRestExchange({
        http: {
          ...makeRestExchange().http,
          rawHeaders: [
            ['set-cookie', 'a=1'],
            ['set-cookie', 'b=2'],
          ],
        },
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }));
    const rows = screen.getAllByTestId('rest-response-header-row');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.textContent)).toEqual(['set-cookiea=1', 'set-cookieb=2']);
  });

  it('shows the cookies a response set, with their attributes, and badges the count', () => {
    mount(
      makeRestExchange({
        cookies: [
          { name: 'session', value: 'abc', path: '/', httpOnly: true, secure: true },
          { name: 'Set-Cookie: nonsense', value: '', malformed: true },
        ],
      }),
    );

    expect(screen.getByRole('tab', { name: /Cookies/ }).textContent).toContain('2');
    fireEvent.click(screen.getByRole('tab', { name: /Cookies/ }));
    const rows = screen.getAllByTestId('rest-cookie-row');
    expect(rows[0]?.textContent).toContain('HttpOnly');
    expect(rows[1]?.textContent).toContain('could not be parsed');
  });

  it('says so when a response set no cookies and when it was not redirected', () => {
    mount(makeRestExchange());

    fireEvent.click(screen.getByRole('tab', { name: 'Cookies' }));
    expect(screen.getByText('This response set no cookies.')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Redirects' }));
    expect(screen.getByText('This request was not redirected.')).toBeTruthy();
  });

  it('lists the redirect hops and what the request finally arrived as', () => {
    mount(
      makeRestExchange({
        methodChanged: true,
        http: {
          ...makeRestExchange().http,
          redirects: [
            { status: 302, url: 'https://api.test/old' },
            { status: 301, url: 'https://api.test/older' },
          ],
        },
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: /Redirects/ }));
    const rows = screen.getAllByTestId('rest-redirect-row');
    expect(rows.map((row) => row.textContent)).toEqual(['302https://api.test/old', '301https://api.test/older']);
    expect(screen.getByTestId('rest-response-redirects').textContent).toContain('changed the method');
  });

  it('shows the timing breakdown and the connection details', () => {
    mount(makeRestExchange());

    fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    expect(screen.getByTestId('rest-response-timing')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'TLS' }));
    expect(screen.getByTestId('rest-response-tls')).toBeTruthy();
  });

  it('shows the reconstructed wire bytes on the Raw tab', () => {
    mount(makeRestExchange());

    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    expect(screen.getByTestId('rest-response-raw-exchange').textContent).toContain('GET /pet/1 HTTP/1.1');
  });

  it('names the Query tab as not built yet, rather than hiding it', () => {
    mount(makeRestExchange());

    fireEvent.click(screen.getByRole('tab', { name: 'Query' }));
    expect(screen.getByTestId('rest-response-query')).toBeTruthy();
  });

  it('saves the response by send id alone, never by path', () => {
    mount(makeRestExchange());

    fireEvent.click(screen.getByTestId('rest-response-save'));

    expect(saveRestBody).toHaveBeenCalledWith({ sendId: 'send-1' });
  });
});

describe('hexLines', () => {
  it('lays out sixteen bytes per line with an offset and the printable characters', () => {
    const bytes = new Uint8Array([0x48, 0x69, 0x00, 0xff]);
    expect(hexLines(bytes)[0]).toBe('00000000  48 69 00 ff                                      Hi..');
  });

  it('stops at the line limit, so a huge body cannot freeze the pane', () => {
    expect(hexLines(new Uint8Array(1024), 2)).toHaveLength(2);
  });
});

const SSE_ROWS: SseRowWire[] = [
  { kind: 'event', index: 0, at: 10, size: 7, event: 'tick', data: '{"n":1}', id: '1', lastEventId: '1' },
  { kind: 'comment', index: 1, at: 20, size: 3, text: 'ka' },
];

function streamExchange(stream: Partial<RestEventStreamWire> = {}): RestExchangeSummary {
  return makeRestExchange({
    text: '',
    language: 'text',
    http: {
      ...makeRestExchange().http,
      headers: { 'content-type': 'text/event-stream' },
      bodyBase64: '',
      rawResponseBase64: b64('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n'),
    },
    stream: {
      rows: SSE_ROWS,
      counts: { events: 1, comments: 1, retries: 0, bytes: 10 },
      lastEventId: '1',
      endedBy: 'server',
      droppedRows: 0,
      truncated: false,
      omittedRows: 0,
      ...stream,
    },
  });
}

describe('RestResponsePane with an event stream', () => {
  it('opens on Events, first, with no Body tab', () => {
    mount(streamExchange());
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs[0]).toContain('Events');
    expect(screen.queryByRole('tab', { name: 'Body' })).toBeNull();
    expect(screen.getAllByTestId('sse-row')).toHaveLength(2);
  });

  it('shows the live half while the stream is still open', () => {
    render(
      <TooltipPrimitive.Provider>
        <RestResponsePane
          requestId="rest-1"
          state={{
            status: 'sending',
            sendId: 'send-1',
            live: {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
              rows: SSE_ROWS,
              droppedRows: 40,
              counts: { events: 41, comments: 1, retries: 0, bytes: 900 },
            },
          }}
        />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.getAllByRole('tab')[0]!.textContent).toContain('Events');
    expect(screen.getAllByTestId('sse-row')).toHaveLength(2);
    const status = screen.getByTestId('rest-response-status');
    expect(status.textContent).toContain('200');
    expect(status.textContent).toContain('41 events');
    expect(status.textContent).toContain('last id 1');
    // It changes with every event: not a live region, or a screen reader would read each one.
    expect(status.getAttribute('role')).toBeNull();
    expect(status.getAttribute('aria-live')).toBeNull();
  });

  it('hands Query the events document as JSON', () => {
    queryViewProps.mockReset();
    mount(streamExchange());
    fireEvent.click(screen.getByRole('tab', { name: 'Query' }));
    expect(queryViewProps).toHaveBeenCalledWith(
      expect.objectContaining({
        xml: eventStreamDocument(SSE_ROWS as Parameters<typeof eventStreamDocument>[0]),
        documentKind: 'json',
      }),
    );
  });

  it('shows the headers in Raw and says the body is an event stream', () => {
    mount(streamExchange({ droppedRows: 3, omittedRows: 2 }));
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    const raw = screen.getByTestId('rest-response-raw-exchange').textContent ?? '';
    expect(raw).toContain('content-type: text/event-stream');
    expect(raw).toContain('event stream of 7 rows');
  });

  it('adds the events, the last id and stopped to the status line', () => {
    mount(streamExchange({ endedBy: 'client' }));
    const status = screen.getByTestId('rest-response-status').textContent ?? '';
    expect(status).toContain('200 OK');
    expect(status).toContain('1 event');
    expect(status).toContain('last id 1');
    expect(status).toContain('stopped');
  });

  it('says a stream that failed part-way failed', () => {
    mount(streamExchange({ endedBy: 'error', error: 'socket hang up' }));
    expect(screen.getByTestId('rest-response-status').textContent).toContain('socket hang up');
  });
});
