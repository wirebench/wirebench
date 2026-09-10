// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWssChannels } from '../src/main/ipc/wss.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

const SECURED =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header>' +
  '<wsse:Security xmlns:wsse="urn:wsse"><wsse:UsernameToken><wsse:Username>bob</wsse:Username>' +
  '<wsse:Password Type="urn:x#PasswordText">hunter2</wsse:Password></wsse:UsernameToken></wsse:Security>' +
  '</soapenv:Header><soapenv:Body/></soapenv:Envelope>';

const project = {
  previewOutgoingWss: vi.fn().mockResolvedValue(SECURED),
  insertWssEntry: vi.fn().mockResolvedValue(SECURED),
  removeOutgoingWssFrom: vi.fn().mockReturnValue('<clean/>'),
};

describe('wss.* IPC', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerWssChannels({ project });
  });

  it('masks the password in a preview', async () => {
    const result = await invoke('wss.previewOutgoing', { requestId: 'r1', envelopeXml: '<x/>' });
    expect(result).toMatchObject({ ok: true });
    const envelopeXml = (result as { value: { envelopeXml: string } }).value.envelopeXml;
    expect(envelopeXml).toContain('wsse:UsernameToken');
    expect(envelopeXml).not.toContain('hunter2');
    expect(project.previewOutgoingWss).toHaveBeenCalledWith('r1', '<x/>');
  });

  it('masks the password of an inserted entry, and folds in the password ref', async () => {
    const result = await invoke('wss.insertEntry', {
      requestId: 'r1',
      entry: {
        kind: 'username-token',
        username: 'bob',
        passwordType: 'text',
        addNonce: false,
        addCreated: false,
      },
      passwordRef: 'secret:pw',
    });
    expect((result as { value: { envelopeXml: string } }).value.envelopeXml).not.toContain('hunter2');
    expect(project.insertWssEntry).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ kind: 'username-token', passwordRef: 'secret:pw' }),
      undefined,
    );
  });

  it('removes the header', async () => {
    const result = await invoke('wss.removeOutgoing', { requestId: 'r1', envelopeXml: SECURED });
    expect((result as { value: { envelopeXml: string } }).value.envelopeXml).toBe('<clean/>');
  });
});
