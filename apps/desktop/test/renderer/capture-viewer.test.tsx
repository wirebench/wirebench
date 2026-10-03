import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { bodyExchangeOf, CaptureViewer, isFormBody } from '../../src/renderer/features/webhooks/capture-viewer.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { CaptureViewWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const b64 = (text: string): string => btoa(text);
const capture = (patch: Partial<CaptureViewWire> = {}): CaptureViewWire => ({
  id: '01J8ZE00000000000000000001',
  receivedAt: '2026-09-24T12:00:01.000Z',
  method: 'POST',
  subpath: '/events',
  bodySize: 7,
  truncated: false,
  sourceIp: '203.0.113.9',
  query: 'a=1&b=2',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Trace', 'a'],
    ['X-Trace', 'b'],
  ],
  bodyBase64: b64('{"n":1}'),
  contentType: 'application/json',
  text: '{"n":1}',
  language: 'json',
  ...patch,
});

function mount(value: CaptureViewWire, onSaveAsWebhook?: () => void): void {
  render(
    <TooltipPrimitive.Provider>
      <CaptureViewer capture={value} {...(onSaveAsWebhook !== undefined ? { onSaveAsWebhook } : {})} />
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

describe('CaptureViewer (webhook-capture §4.2)', () => {
  it('opens on the body, and offers headers in arrival order and the details', () => {
    mount(capture());
    expect(screen.getByRole('tab', { name: 'Body' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: 'Form' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }));
    expect(screen.getAllByTestId('rest-response-header-row').map((row) => row.textContent)).toEqual([
      'Content-Typeapplication/json',
      'X-Tracea',
      'X-Traceb',
    ]);

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    const details = screen.getByTestId('capture-details').textContent ?? '';
    for (const text of ['POST', '/events', 'a=1&b=2', '203.0.113.9', '7 B']) expect(details).toContain(text);
  });

  it('says where a truncated body was cut', () => {
    mount(capture({ truncated: true, bodySize: 3_565_158, bodyBase64: b64('x'.repeat(1024)) }));
    expect(screen.getByTestId('capture-truncated').textContent).toBe('Body cut at 1.0 KB of 3.4 MB');
  });

  it('shows form fields for a form body', () => {
    mount(
      capture({
        contentType: 'application/x-www-form-urlencoded; charset=utf-8',
        headers: [['Content-Type', 'application/x-www-form-urlencoded; charset=utf-8']],
        text: 'name=Ada+Lovelace&tag=a&tag=b%26c',
        language: 'text',
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getAllByTestId('capture-form-row').map((row) => row.textContent)).toEqual([
      'nameAda Lovelace',
      'taga',
      'tagb&c',
    ]);
  });

  it('shows a binary body as hex through the existing viewer', () => {
    mount(
      capture({
        contentType: 'application/octet-stream',
        bodyBase64: 'AJ+Slg==',
        bodySize: 4,
        text: '',
        language: 'binary',
      }),
    );
    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    expect(screen.getByTestId('rest-response-hex').textContent).toContain('00 9f 92 96');
  });

  it('maps a capture onto what the body views read', () => {
    expect(bodyExchangeOf(capture({ contentType: null }))).toEqual({
      text: '{"n":1}',
      language: 'json',
      http: { bodyBase64: b64('{"n":1}'), headers: { 'content-type': 'application/octet-stream' } },
    });
    expect([isFormBody('application/x-www-form-urlencoded'), isFormBody('text/plain'), isFormBody(null)]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('offers Save as webhook… when a handler is given, and calls it', () => {
    const onSaveAsWebhook = vi.fn();
    mount(capture(), onSaveAsWebhook);
    const button = screen.getByTestId<HTMLButtonElement>('capture-save-as-webhook');
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onSaveAsWebhook).toHaveBeenCalledOnce();
  });

  it('has no Save as webhook… button without a handler', () => {
    mount(capture());
    expect(screen.queryByTestId('capture-save-as-webhook')).toBeNull();
  });

  it('disables Save as webhook… for a truncated capture', () => {
    mount(capture({ truncated: true, bodySize: 3_565_158, bodyBase64: b64('x'.repeat(1024)) }), vi.fn());
    const button = screen.getByTestId<HTMLButtonElement>('capture-save-as-webhook');
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("The body was cut at the server's limit, so it cannot be replayed.");
  });

  it('disables Save as webhook… for a binary capture', () => {
    mount(
      capture({
        contentType: 'application/octet-stream',
        bodyBase64: 'AJ+Slg==',
        bodySize: 4,
        text: '',
        language: 'binary',
      }),
      vi.fn(),
    );
    const button = screen.getByTestId<HTMLButtonElement>('capture-save-as-webhook');
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('A binary body cannot be saved as a webhook.');
  });

  it('previews an HTML capture in a sandboxed frame', () => {
    const page = '<p>hi</p>';
    mount(
      capture({ contentType: 'text/html', text: page, language: 'html', bodyBase64: b64(page), bodySize: page.length }),
    );
    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    expect(screen.getByTestId('rest-response-html-preview').getAttribute('sandbox')).toBe('');
  });
});
