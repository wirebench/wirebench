import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { CaptureViewer } from '../../src/renderer/features/webhooks/capture-viewer.js';
import { SignatureBadge } from '../../src/renderer/features/webhooks/signature-badge.js';
import { droppedHeader } from '../../src/renderer/features/webhook-items/save-as-webhook.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { CaptureViewWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const capture = (patch: Partial<CaptureViewWire> = {}): CaptureViewWire => ({
  id: '01J8ZE00000000000000000001',
  receivedAt: '2026-09-29T12:00:01.000Z',
  method: 'POST',
  subpath: '/events',
  bodySize: 25,
  truncated: false,
  sourceIp: '203.0.113.9',
  query: '',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Signature', 'e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab'],
  ],
  bodyBase64: btoa('{"event":"order.created"}'),
  contentType: 'application/json',
  text: '{"event":"order.created"}',
  language: 'json',
  ...patch,
});
const HMAC = { kind: 'hmac' as const, algorithm: 'sha256' as const, encoding: 'hex' as const, header: 'X-Signature' };

beforeEach(() => {
  installWirebenchApi();
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
});
afterEach(() => cleanup());

describe('capture verdicts (§4)', () => {
  it('badges a row ✓, ✗ with its reason, a 401 marker, and nothing when not checked', () => {
    const { rerender, container } = render(<SignatureBadge signature={{ verdict: 'verified' }} rejected={false} />);
    expect(screen.getByTestId('capture-signature-badge').dataset['verdict']).toBe('verified');
    expect(screen.getByTestId('capture-signature-badge').textContent).toBe('✓');
    rerender(<SignatureBadge signature={{ verdict: 'failed', reason: 'mismatch' }} rejected />);
    expect(screen.getByTestId('capture-signature-badge').getAttribute('title')).toBe('Signature: digest mismatch');
    expect(screen.getByTestId('capture-rejected').textContent).toBe('401');
    rerender(<SignatureBadge signature={undefined} rejected={false} />);
    expect(container.textContent).toBe('');
  });

  it('shows the verdict, the scheme and the signature headers in Details, and the rejection banner', () => {
    render(
      <TooltipPrimitive.Provider>
        <CaptureViewer
          capture={capture({ signature: { verdict: 'failed', reason: 'mismatch' }, rejected: true })}
          signatureScheme={HMAC}
        />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.getByTestId('capture-rejected-note').textContent).toBe('Answered 401 (rejected: unverified)');
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.getByTestId('capture-signature-verdict').textContent).toContain('✗ digest mismatch');
    const block = screen.getByTestId('capture-signature').textContent ?? '';
    expect(block).toContain('HMAC of body · SHA-256 · hex · X-Signature');
    expect(block).toContain('X-Signature');
    expect(block).not.toContain('Content-Type');
  });

  it('leaves Details as it was for an unchecked capture', () => {
    render(
      <TooltipPrimitive.Provider>
        <CaptureViewer capture={capture()} />
      </TooltipPrimitive.Provider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.queryByTestId('capture-signature')).toBeNull();
    expect(screen.queryByTestId('capture-rejected-note')).toBeNull();
  });

  it('drops the Standard Webhooks headers when saving a capture as a webhook', () => {
    for (const name of ['webhook-id', 'Webhook-Timestamp', 'webhook-signature', 'X-Signature']) {
      expect(droppedHeader(name)).toBe(true);
    }
    expect(droppedHeader('webhook-event')).toBe(false);
  });
});
