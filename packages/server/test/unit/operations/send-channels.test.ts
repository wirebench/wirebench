/**
 * Slice 5 Task 9 (hosted edition spec §20.7): the server host's send channels against the channel registry, as the
 * allowlist test checks the served channels (§17.3). Every served channel whose name looks like a send is listed as
 * a send or as not one, so a new protocol's send channel cannot go uncharged by accident.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isServedChannel } from '../../../src/host/allowlist.js';
import {
  chargeOf,
  isSendChannel,
  looksLikeSend,
  NOT_SENDS,
  SEND_CHANNELS,
  SENDS_WHEN_FETCHED,
  unclassifiedSends,
} from '../../../src/operations/send-channels.js';

const PINNED = new URL('../../../../../apps/desktop/test/fixtures/ipc-names.json', import.meta.url);

async function registry(): Promise<string[]> {
  const pinned = JSON.parse(await readFile(PINNED, 'utf8')) as { readonly channels: readonly string[] };
  return [...pinned.channels];
}

describe('the server host send channels (§20.7)', () => {
  it('classifies every served channel that looks like a send', async () => {
    expect(unclassifiedSends(await registry(), isServedChannel)).toEqual([]);
  });

  it('catches a send channel the registry gains', async () => {
    const channels = [...(await registry()), 'request.sendSse', 'request.invokeSoap', 'history.resendSse'];
    expect(unclassifiedSends(channels, isServedChannel)).toEqual([
      'request.sendSse',
      'request.invokeSoap',
      'history.resendSse',
    ]);
  });

  it('lists only served registry channels, each once, and none both ways', async () => {
    const channels = await registry();
    for (const channel of [...SEND_CHANNELS, ...Object.keys(SENDS_WHEN_FETCHED), ...Object.keys(NOT_SENDS)]) {
      expect(channels, channel).toContain(channel);
      expect(isServedChannel(channel), channel).toBe(true);
    }
    for (const channel of Object.keys(NOT_SENDS)) {
      expect(SEND_CHANNELS.has(channel), channel).toBe(false);
      expect(Object.hasOwn(SENDS_WHEN_FETCHED, channel), channel).toBe(false);
      // An exclusion means something only for a name the rule would flag.
      expect(looksLikeSend(channel), channel).toBe(true);
    }
  });

  it('charges every protocol kind’s send and resend, and no paired-agent or scheduled path', () => {
    for (const channel of [
      'request.send',
      'request.sendRest',
      'request.sendGrpc',
      'request.sendMcp',
      'request.openWs',
      'request.graphqlIntrospect',
      'request.sendToEnvironments',
      'history.resend',
      'history.resendRest',
      'history.resendGrpc',
      'log.resend',
      'runner.run',
      'sequence.run',
    ]) {
      expect(isSendChannel(channel), channel).toBe(true);
    }
    // The paired agent's path: the route, the bundle, the record of what the agent sent, and the agent's own send.
    for (const channel of [
      'request.route',
      'request.bundle',
      'exchanges.recordAgentSend',
      'exchanges.recordAgentFailure',
      'agent.send',
      'schedules.runNow',
      'request.wsSend',
    ]) {
      expect(isSendChannel(channel), channel).toBe(false);
    }
    // `agent.send` is never served on the server host at all.
    expect(isServedChannel('agent.send')).toBe(false);
  });

  it('catches fetch, refresh and import channels too', () => {
    for (const channel of ['oauth2.fetchToken', 'api.refreshMcpCatalogue', 'api.grpcRefresh', 'definition.import']) {
      expect(looksLikeSend(channel), channel).toBe(true);
    }
    expect(unclassifiedSends(['api.importSomething', 'x.fetchAll'], () => true)).toEqual([
      'api.importSomething',
      'x.fetchAll',
    ]);
  });

  it('charges a run per request, a WebSocket open as a session, and an import only when it fetches', () => {
    for (const channel of ['runner.run', 'sequence.run', 'request.sendToEnvironments']) {
      expect(chargeOf(channel), channel).toBe('run');
    }
    expect(chargeOf('request.openWs')).toBe('session');
    for (const channel of ['request.sendRest', 'oauth2.fetchToken', 'issuedTokens.fetch', 'api.grpcRefresh']) {
      expect(chargeOf(channel), channel).toBe('send');
    }
    expect(chargeOf('api.refreshMcpCatalogue', { apiId: 'a' })).toBe('send');
    expect(chargeOf('definition.import', { source: { kind: 'url', url: 'https://x.test/?wsdl' } })).toBe('send');
    expect(chargeOf('definition.import', { source: { kind: 'file', path: '/p/x.wsdl' } })).toBeUndefined();
    expect(chargeOf('api.importOpenApi', { source: { kind: 'text', text: '{}' } })).toBeUndefined();
    expect(chargeOf('api.importProto', { source: { kind: 'reflection', target: 'h:1' } })).toBe('send');
    expect(chargeOf('api.importProto', { source: { kind: 'folder', path: '/p' } })).toBeUndefined();
    expect(chargeOf('api.importPostman', { source: { kind: 'file', path: '/p' } })).toBeUndefined();
    expect(chargeOf('sync.fetch')).toBeUndefined();
    expect(chargeOf('app.version')).toBeUndefined();
  });
});
