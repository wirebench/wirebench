/**
 * SOAP's answer to the HTTP Log's Resend (spec §5.4): `log.resend` hands a row to the kind it
 * was sent by.
 */
import { ProjectError } from '@wirebench/engine';
import { sendThroughEngine } from '../../send/exchange.js';
import type { KindLog } from '../kind-main.js';

export const soapLog: KindLog = {
  async resend({ request, deps, sendDeps, sendId }) {
    // History's resend Path 1: the live request, never a redacted copy.
    if (deps.request.project.endpointFor(request.requestId) === undefined) {
      throw new ProjectError('unknown-entity', `No request with id "${request.requestId}"`, {
        details: { requestId: request.requestId },
      });
    }
    return {
      protocol: 'soap' as const,
      exchange: await sendThroughEngine(sendDeps, sendId, request.requestId, {
        draft: { kind: 'soap', override: {} },
      }),
    };
  },
};
