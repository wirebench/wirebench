/**
 * The REST/webhook editor's URL bar: Send, the method and the URL. A webhook item has no API,
 * so it shows a labelled prefix instead of a base URL, and Send can be disabled with a reason —
 * the two things `rest-editor.tsx` adds for that case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UrlBar, type UrlBarProps } from '../../src/renderer/features/rest-editor/url-bar.js';

function props(overrides: Partial<UrlBarProps> = {}): UrlBarProps {
  return {
    method: 'GET',
    url: '/pet/1',
    sending: false,
    onMethodChange: vi.fn(),
    onUrlChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

describe('UrlBar', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the base URL itself as the greyed prefix, by default', () => {
    render(<UrlBar {...props({ basePrefix: 'https://api.test' })} />);
    expect(screen.getByTestId('rest-url-base').textContent).toBe('https://api.test');
  });

  it('shows the label instead of the raw base, with the resolved base in the title', () => {
    render(<UrlBar {...props({ basePrefix: 'https://hooks.test/newPet', baseLabel: 'Target' })} />);
    const prefix = screen.getByTestId<HTMLSpanElement>('rest-url-base');
    expect(prefix.textContent).toBe('Target ·');
    expect(prefix.textContent).not.toContain('https://hooks.test/newPet');
    expect(prefix.title).toBe('https://hooks.test/newPet');
  });

  it('still shows the label when no base has resolved yet', () => {
    render(<UrlBar {...props({ baseLabel: 'Target' })} />);
    const prefix = screen.getByTestId<HTMLSpanElement>('rest-url-base');
    expect(prefix.textContent).toBe('Target ·');
    expect(prefix.title).toBe('Target');
  });

  it('disables Send and carries the reason on its title', () => {
    render(<UrlBar {...props({ sendDisabledReason: 'Set the Webhooks target' })} />);
    const send = screen.getByTestId<HTMLButtonElement>('rest-send');
    expect(send.disabled).toBe(true);
    expect(send.title).toBe('Set the Webhooks target');
  });

  it('does not send on Enter while Send is disabled, and does once it is not', () => {
    const onSend = vi.fn();
    const { rerender } = render(<UrlBar {...props({ onSend, sendDisabledReason: 'Set the Webhooks target' })} />);
    fireEvent.keyDown(screen.getByTestId('rest-url'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    rerender(<UrlBar {...props({ onSend })} />);
    fireEvent.keyDown(screen.getByTestId('rest-url'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('sends on click when nothing disables it', () => {
    const onSend = vi.fn();
    render(<UrlBar {...props({ onSend })} />);
    fireEvent.click(screen.getByTestId<HTMLButtonElement>('rest-send'));
    expect(onSend).toHaveBeenCalled();
  });

  it('leads with Send, joined to the menu passed in, ahead of the method and the URL', () => {
    render(<UrlBar {...props({ menu: <button type="button">▾</button> })} />);
    const send = screen.getByTestId('rest-send');
    const method = screen.getByTestId('rest-method');
    const url = screen.getByTestId('rest-url');
    expect(send.compareDocumentPosition(method) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(method.compareDocumentPosition(url) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(send.nextElementSibling?.textContent).toBe('▾');
    expect(send.className).toContain('rounded-r-none');
  });
});
