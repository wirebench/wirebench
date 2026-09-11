import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../src/renderer/state/project.js';
import {
  applyOutgoingWssToEditor,
  insertWssEntry,
  removeOutgoingWssFromEditor,
} from '../../src/renderer/features/request-editor/wss-actions.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';

const SECURED = '<secured/>';

function install(overrides: Record<string, unknown>) {
  const updateRequest = vi.fn();
  useProjectStore.setState({ requests: { 'req-1': makeDraft({ envelopeXml: '<plain/>' }) }, updateRequest } as never);
  installWirebenchApi({ wss: overrides });
  return updateRequest;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WS-Security editor actions', () => {
  it('inserts an entry and writes the result back into the request', async () => {
    const insertEntry = vi.fn().mockResolvedValue({ ok: true, value: { envelopeXml: SECURED } });
    const updateRequest = install({ insertEntry });
    await insertWssEntry(
      'req-1',
      { kind: 'username-token', username: 'bob', passwordType: 'digest', addNonce: true, addCreated: true },
      'secret:pw',
    );
    expect(insertEntry).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', envelopeXml: '<plain/>', passwordRef: 'secret:pw' }),
    );
    expect(updateRequest).toHaveBeenCalledWith('req-1', { envelopeXml: SECURED });
  });

  it('applies the request configuration to the editor', async () => {
    const previewOutgoing = vi.fn().mockResolvedValue({ ok: true, value: { envelopeXml: SECURED } });
    const updateRequest = install({ previewOutgoing });
    await applyOutgoingWssToEditor('req-1');
    expect(updateRequest).toHaveBeenCalledWith('req-1', { envelopeXml: SECURED });
  });

  it('removes the header again', async () => {
    const removeOutgoing = vi.fn().mockResolvedValue({ ok: true, value: { envelopeXml: '<plain/>' } });
    const updateRequest = install({ removeOutgoing });
    await removeOutgoingWssFromEditor('req-1');
    expect(updateRequest).toHaveBeenCalledWith('req-1', { envelopeXml: '<plain/>' });
  });

  it('leaves the envelope alone when the call fails', async () => {
    const previewOutgoing = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'wss-config-missing', message: 'nope' } });
    const updateRequest = install({ previewOutgoing });
    await applyOutgoingWssToEditor('req-1');
    expect(updateRequest).not.toHaveBeenCalled();
  });

  it('does nothing for a request that is not in the mirror', async () => {
    const previewOutgoing = vi.fn();
    install({ previewOutgoing });
    await applyOutgoingWssToEditor('missing');
    expect(previewOutgoing).not.toHaveBeenCalled();
  });
});
