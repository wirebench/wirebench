import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResponseAttachmentsInspector } from '../../src/renderer/features/request-editor/inspectors/response-attachments-inspector.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeExchange } from '../mocks/exchange-fixtures.js';
import type { ExchangeSummary } from '../../src/shared/wire-types.js';

/** An exchange whose response carries two parts, as an MTOM echo returns them. */
function withAttachments(): ExchangeSummary {
  const exchange = makeExchange();
  return {
    ...exchange,
    sendId: 'send-1',
    response: {
      ...exchange.response,
      attachments: [
        { index: 0, contentId: 'part0@wirebench', contentType: 'image/png', size: 64, name: 'logo.png' },
        { index: 1, contentId: 'part1@wirebench', contentType: 'text/plain', size: 2 },
      ],
    },
  } as ExchangeSummary;
}

describe('ResponseAttachmentsInspector', () => {
  beforeEach(() => {
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
  });

  it('says so when the response carries none', () => {
    render(<ResponseAttachmentsInspector exchange={undefined} />);
    expect(screen.getByText('No attachments in this response')).toBeDefined();
    expect(screen.queryByTestId('response-attachments-table')).toBeNull();
  });

  it('lists one row per part', () => {
    render(<ResponseAttachmentsInspector exchange={withAttachments()} />);

    expect(screen.getAllByTestId('response-attachment-row')).toHaveLength(2);
    expect(screen.getByText('part0@wirebench')).toBeDefined();
    expect(screen.getByText('logo.png')).toBeDefined();
  });

  it('saves the part the row stands for, by its index', async () => {
    const saveResponse = vi.fn().mockResolvedValue({ ok: true, value: { path: '/tmp/logo.png' } });
    installWirebenchApi({ attachments: { saveResponse } });
    render(<ResponseAttachmentsInspector exchange={withAttachments()} />);

    await userEvent.click(screen.getAllByLabelText('Save attachment as…')[1]!);

    expect(saveResponse).toHaveBeenCalledWith({ sendId: 'send-1', index: 1 });
  });

  it('opens the part the row stands for', async () => {
    const openResponse = vi.fn().mockResolvedValue({ ok: true, value: { path: '/tmp/logo.png' } });
    installWirebenchApi({ attachments: { openResponse } });
    render(<ResponseAttachmentsInspector exchange={withAttachments()} />);

    await userEvent.click(screen.getAllByLabelText('Open attachment')[0]!);

    expect(openResponse).toHaveBeenCalledWith({ sendId: 'send-1', index: 0 });
  });
});
