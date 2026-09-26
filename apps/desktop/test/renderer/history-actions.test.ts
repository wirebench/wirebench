import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resendLastHistoryEntry } from '../../src/renderer/features/history/history-actions.js';
import { useHistoryStore } from '../../src/renderer/state/history.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { HistoryEntryWire } from '../../src/shared/wire-types.js';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast, ToastViewport: () => null }));

function soapEntry(): HistoryEntryWire {
  return {
    id: 'h-1',
    at: '2026-01-01T10:00:00.000Z',
    projectId: 'proj-1',
    requestName: 'Add',
    interfaceName: 'Calc',
    operationName: 'Add',
    endpoint: 'https://calc.test/soap',
    soapVersion: '1.1',
    durationMs: 5,
    ok: true,
    status: 200,
    request: { envelopeXml: '<Envelope>req</Envelope>', headers: [] },
    response: { envelopeXml: '<Envelope>res</Envelope>', rawHeaders: [], status: 200, statusText: 'OK' },
    sizeBytes: 10,
  };
}

describe('resendLastHistoryEntry', () => {
  beforeEach(() => {
    showToast.mockClear();
    useHistoryStore.setState({ entries: [soapEntry()], total: 1 });
  });

  it('toasts the error message when the re-send fails', async () => {
    const message =
      "This entry holds values History redacted and the request it was sent from no longer exists, so it can't be re-sent.";
    installWirebenchApi({
      history: {
        resend: vi.fn().mockResolvedValue({ ok: false, error: { code: 'history-resend-redacted', message } }),
      },
    });

    await resendLastHistoryEntry();
    expect(showToast).toHaveBeenCalledWith(message);
  });

  it('toasts the error code when the failure has only whitespace for a message', async () => {
    installWirebenchApi({
      history: {
        resend: vi.fn().mockResolvedValue({ ok: false, error: { code: 'history-resend-redacted', message: ' ' } }),
      },
    });

    await resendLastHistoryEntry();
    expect(showToast).toHaveBeenCalledWith('history-resend-redacted');
  });
});
