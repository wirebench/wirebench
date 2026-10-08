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
  wssPolicyInputs: vi.fn().mockReturnValue(undefined),
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

  it('returns the timeline of the previewed envelope (#57)', async () => {
    project.previewOutgoingWss.mockResolvedValueOnce(
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header>' +
        '<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" ' +
        'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' +
        '<wsu:Timestamp><wsu:Created>T0</wsu:Created></wsu:Timestamp>' +
        '<wsse:UsernameToken><wsse:Username>bob</wsse:Username>' +
        '<wsse:Password Type="urn:x#PasswordText">hunter2</wsse:Password></wsse:UsernameToken>' +
        '</wsse:Security></soapenv:Header><soapenv:Body/></soapenv:Envelope>',
    );
    const result = await invoke('wss.previewOutgoing', { requestId: 'r1', envelopeXml: '<x/>' });
    const value = (result as { value: { envelopeXml: string; timeline: unknown[] } }).value;
    expect(value.timeline).toEqual([
      { kind: 'timestamp', summary: 'Timestamp (created T0)' },
      { kind: 'username-token', summary: 'UsernameToken (PasswordText)' },
    ]);
    expect(JSON.stringify(value)).not.toContain('hunter2');
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

  it('does not mask a PasswordDigest in a preview', async () => {
    const digestEnvelope =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header>' +
      '<wsse:Security xmlns:wsse="urn:wsse"><wsse:UsernameToken><wsse:Username>bob</wsse:Username>' +
      '<wsse:Password Type="urn:x#PasswordDigest">abc123==</wsse:Password></wsse:UsernameToken></wsse:Security>' +
      '</soapenv:Header><soapenv:Body/></soapenv:Envelope>';
    project.previewOutgoingWss.mockResolvedValueOnce(digestEnvelope);
    const result = await invoke('wss.previewOutgoing', { requestId: 'r1', envelopeXml: '<x/>' });
    expect((result as { value: { envelopeXml: string } }).value.envelopeXml).toContain('abc123==');
  });

  it('removes the header', async () => {
    const result = await invoke('wss.removeOutgoing', { requestId: 'r1', envelopeXml: SECURED });
    expect((result as { value: { envelopeXml: string } }).value.envelopeXml).toBe('<clean/>');
  });
});
