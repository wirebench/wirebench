/** Where the secret scanner looks in SOAP's interfaces, and how a move rewrites them. */
import type { ProtocolSecrets } from '../protocol/module.js';
import { keyedEntries, keyed, mapShared, patch, SEP } from '../secrets/scan/support.js';
import type { ScanTarget } from '../secrets/scan/support.js';
import type { Project } from '../project/model.js';
import { soapInterfacesOf, withSoapInterfaces } from './model.js';

function* scanTargets(project: Project): Generator<ScanTarget> {
  for (const iface of soapInterfacesOf(project)) {
    for (const operation of iface.operations) {
      for (const request of operation.requests) {
        const path = `${iface.name}${SEP}${operation.name}${SEP}${request.name}`;
        yield* keyed('soap-header', request.id, path, 'header', 'header', request.headers);
        if (request.envelopeXml !== '') {
          yield {
            location: { kind: 'soap-body', requestId: request.id },
            label: `${path}${SEP}envelope`,
            text: request.envelopeXml,
            context: { contentType: 'text/xml' },
          };
        }
      }
    }
  }
}

/** SOAP's request headers and envelopes. */
export const soapSecrets: ProtocolSecrets = {
  scanTargets,
  applyMoves: (project, rw) => {
    const interfaces = soapInterfacesOf(project);
    const next = mapShared(interfaces, (iface) =>
      patch(iface, {
        operations: mapShared(iface.operations, (operation) =>
          patch(operation, {
            requests: mapShared(operation.requests, (request) =>
              patch(request, {
                headers: keyedEntries(rw, 'soap-header', { requestId: request.id }, request.headers),
                envelopeXml: rw.text({ kind: 'soap-body', requestId: request.id }, request.envelopeXml),
              }),
            ),
          }),
        ),
      }),
    );
    return next === interfaces ? project : withSoapInterfaces(project, next);
  },
};
