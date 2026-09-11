/**
 * The `wsa.*` IPC channels: the two operations that write WS-Addressing into the envelope
 * *text* the editor holds, as opposed to the request's saved configuration, which is applied
 * at send time and never touches the stored envelope.
 *
 * Nothing here can carry a secret — a `wsa:*` header is addressing metadata, not credentials —
 * so unlike `wss.*` the envelopes are returned unredacted.
 */

import { channels } from '../../shared/ipc.js';
import type { ProjectHost } from '../project-host.js';
import { registerHandler } from './register.js';

/** What the `wsa.*` channels need; a stub stands in for it in tests. */
export interface WsaChannelDeps {
  readonly project: Pick<ProjectHost, 'insertWsaHeaders' | 'removeWsaHeadersFrom'>;
}

/** Registers the `wsa.*` channels. */
export function registerWsaChannels(deps: WsaChannelDeps): void {
  registerHandler(channels.wsa.insertHeaders, (request) =>
    Promise.resolve({ envelopeXml: deps.project.insertWsaHeaders(request.requestId, request.envelopeXml) }),
  );

  registerHandler(channels.wsa.removeHeaders, (request) =>
    Promise.resolve({ envelopeXml: deps.project.removeWsaHeadersFrom(request.requestId, request.envelopeXml) }),
  );
}
