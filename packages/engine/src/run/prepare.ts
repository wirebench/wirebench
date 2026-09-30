/**
 * Turns one saved request into a send input, for a host with no editor: no draft to apply, no
 * user preferences to fold in, no renderer to keep credentials from. Each protocol module prepares
 * its own requests (`prepareSoap`, `prepareRest`, `prepareGrpc`); this file only picks the one for
 * the request's kind, and keeps the names the run module has always exported.
 */
import { prepareGrpc } from '../grpc/run.js';
import type { PreparedGrpc } from '../grpc/run.js';
import type { SelectedRequest } from '../protocols.js';
import { prepareRest } from '../rest/run.js';
import type { PreparedRest } from '../rest/run.js';
import { prepareSoap } from '../soap/run.js';
import type { PreparedSoap } from '../soap/run.js';
import type { RunContext } from './context.js';

export { scopesFor } from './context.js';
export type { RunContext, RunWorkspace } from './context.js';
export { authFor } from './send-helpers.js';

/**
 * One request, ready for `sendSoapRequest` (with `scopes`), `sendRest`, or `callGrpc` (with the
 * API's proto set, which the caller loads: preparing a call needs no schema). It carries resolved
 * secret values (auth, `scopes.secrets`) but no list of them: the host masks what its `GetSecret`
 * handed out (see `GetSecret`).
 */
export type PreparedSend = PreparedSoap | PreparedRest | PreparedGrpc;

/**
 * @throws WirebenchError `unresolved-properties` | `endpoint-unresolved` | `secret-missing` |
 * `auth-grant-unsupported` | `wss-config-missing` | `keystore-missing` | `webhook-signing-secret`
 */
export function prepareSend(selected: SelectedRequest, context: RunContext): Promise<PreparedSend> {
  switch (selected.kind) {
    case 'soap':
      return prepareSoap(selected, context);
    case 'rest':
      return prepareRest(selected, context);
    case 'grpc':
      return prepareGrpc(selected, context);
  }
}
