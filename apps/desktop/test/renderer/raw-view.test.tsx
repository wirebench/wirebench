import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RawView } from '../../src/renderer/features/request-editor/views/raw-view.js';

function toBase64(text: string): string {
  return btoa(text);
}

describe('RawView', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the empty state before a base64 payload is available', () => {
    render(
      <RawView
        base64={undefined}
        emptyTitle="No request sent yet"
        emptyDescription="Send this request to see the raw bytes."
        ariaLabel="Request raw bytes"
      />,
    );

    expect(screen.getByText('No request sent yet')).toBeDefined();
  });

  it('decodes and renders headers and a text body', () => {
    const raw = 'POST /soap HTTP/1.1\r\nContent-Type: text/xml\r\n\r\n<Add><a>1</a></Add>';
    render(<RawView base64={toBase64(raw)} emptyTitle="—" emptyDescription="—" ariaLabel="Request raw bytes" />);

    const pre = screen.getByLabelText('Request raw bytes');
    expect(pre.textContent).toBe(raw);
  });

  it('shows a binary notice for a non-text body while keeping the headers as text', () => {
    const head = 'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n';
    const binaryBody = String.fromCharCode(0, 1, 2, 3, 255, 254, 253, 252, 0, 1, 2, 3);
    const raw = head + binaryBody;
    render(<RawView base64={toBase64(raw)} emptyTitle="—" emptyDescription="—" ariaLabel="Response raw bytes" />);

    const pre = screen.getByLabelText('Response raw bytes');
    expect(pre.textContent).toBe(`${head}<${binaryBody.length} bytes of binary>`);
  });

  it('copies the decoded raw text to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const raw = 'GET / HTTP/1.1\r\n\r\n';
    render(<RawView base64={toBase64(raw)} emptyTitle="—" emptyDescription="—" ariaLabel="Request raw bytes" />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith(raw);
  });
});
