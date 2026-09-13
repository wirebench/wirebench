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
import type { RestExchangeSummary } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const saveRestBody = vi.fn();

function mount(exchange?: RestExchangeSummary, extra: Record<string, unknown> = {}): void {
  render(
    <TooltipPrimitive.Provider>
      <RestResponsePane
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
        <RestResponsePane state={{ status: 'error', sendId: 's1', error: { code: 'dns', message: 'not found' } }} />
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
