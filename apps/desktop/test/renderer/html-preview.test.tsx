import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { BodyView, type BodyViewExchange } from '../../src/renderer/features/rest-editor/response/body-view.js';
import { previewDocument } from '../../src/renderer/features/rest-editor/response/html-preview.js';
import { HTML_PREVIEW_CSP } from '../../src/shared/html-preview-csp.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const PAGE = '<!doctype html><html><body><h1>Hello</h1><script>document.title="ran"</script></body></html>';

const exchange = (patch: Partial<BodyViewExchange> = {}): BodyViewExchange => ({
  text: PAGE,
  language: 'html',
  http: { bodyBase64: btoa(PAGE), headers: { 'content-type': 'text/html; charset=utf-8' } },
  ...patch,
});

function mount(value: BodyViewExchange): void {
  render(
    <TooltipPrimitive.Provider>
      <BodyView exchange={value} />
    </TooltipPrimitive.Provider>,
  );
}

beforeEach(() => {
  installWirebenchApi();
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
});
afterEach(() => {
  cleanup();
});

describe('previewDocument', () => {
  it('declares the policy and no-referrer before anything the server sent, and keeps the body as is', () => {
    const doc = previewDocument(PAGE);
    const head = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta name="referrer" content="no-referrer">`;
    expect(doc.startsWith(head)).toBe(true);
    expect(doc.slice(head.length)).toBe(PAGE);
  });
});

describe('BodyView preview of HTML (#48)', () => {
  it('still opens HTML in Pretty', () => {
    mount(exchange());
    expect(screen.getByTestId('rest-response-view-pretty').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('rest-response-html-preview')).toBeNull();
  });

  it('renders the body in a frame with an empty sandbox, and says what is off', () => {
    mount(exchange());
    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    const frame = screen.getByTestId('rest-response-html-preview');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('srcdoc')).toBe(previewDocument(PAGE));
    expect(screen.getByText('Static preview: scripts, forms and remote resources are off.')).toBeTruthy();
  });

  it('does not render an HTML body over the size limit', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES_WIRE, rest: { ...DEFAULT_PREFERENCES_WIRE.rest, prettyPrintMaxBytes: 10 } },
      loaded: true,
    });
    mount(exchange());
    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    expect(screen.queryByTestId('rest-response-html-preview')).toBeNull();
    expect(screen.getByText('Too large to preview. Raw shows the markup.')).toBeTruthy();
  });

  it('keeps the hex dump for other bodies', () => {
    mount(exchange({ text: 'plain', language: 'text', http: { bodyBase64: btoa('plain'), headers: {} } }));
    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    expect(screen.getByTestId('rest-response-hex')).toBeTruthy();
    expect(screen.queryByTestId('rest-response-html-preview')).toBeNull();
  });
});
