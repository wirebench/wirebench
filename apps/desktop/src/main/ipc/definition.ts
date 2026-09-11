import { WirebenchError } from '@wirebench/engine';
import { channels, events } from '../../shared/ipc.js';
import { MAX_DOCUMENT_TEXT_BYTES } from '../../shared/wire-types.js';
import type { EngineService } from '../engine-service.js';
import { declarationAtOffset, schemaIndexOf } from '../schema-index.js';
import { emitEvent } from './events.js';
import { registerHandler } from './register.js';

/** Registers the `definition.*` IPC channels against a shared `EngineService` instance. */
export function registerDefinitionChannels(service: EngineService): void {
  registerHandler(channels.definition.import, (request, sender) =>
    service.importDefinition(request, {
      onProgress: (progress) => {
        emitEvent(sender, events.engine.progress, progress);
      },
    }),
  );

  registerHandler(channels.definition.close, (request) => Promise.resolve(service.close(request.interfaceId)));

  registerHandler(channels.definition.cancelImport, (request) => Promise.resolve(service.cancelImport(request.token)));

  // The list is identity only — no text — so a large import graph stays a bounded payload.
  registerHandler(channels.definition.documents, (request) => {
    const result = service.resultFor(request.interfaceId);
    return Promise.resolve({
      documents: result.bundle.documents.map((document) => ({
        location: document.location,
        kind: document.kind,
        size: document.bytes.byteLength,
        ...(document.namespace !== undefined ? { namespace: document.namespace } : {}),
      })),
      loadedAt: service.loadedAtFor(request.interfaceId),
    });
  });

  // One document's text, on demand. `location` is matched against the bundle's own locations:
  // the renderer never names a filesystem path, and nothing is re-fetched to answer this.
  registerHandler(channels.definition.documentText, (request) => {
    const result = service.resultFor(request.interfaceId);
    const document = result.bundle.documents.find((candidate) => candidate.location === request.location);
    if (document === undefined) {
      throw new WirebenchError('unknown-document', `No document "${request.location}" in this definition`, {
        details: { interfaceId: request.interfaceId, location: request.location },
      });
    }
    if (document.bytes.byteLength > MAX_DOCUMENT_TEXT_BYTES) {
      throw new WirebenchError(
        'document-too-large',
        `Document "${request.location}" is too large to show (${String(document.bytes.byteLength)} bytes)`,
        { details: { location: request.location, size: document.bytes.byteLength } },
      );
    }
    return Promise.resolve({ text: document.text });
  });

  registerHandler(channels.definition.schemaIndex, (request) =>
    Promise.resolve({ namespaces: schemaIndexOf(service.schemaSetFor(request.interfaceId)) }),
  );

  registerHandler(channels.definition.declarationAt, (request) => {
    // The offset is a caret position in the very envelope that came with it, so anything past
    // its end is a caller bug rather than a miss worth answering with `null`.
    if (request.offset > request.envelopeXml.length) {
      throw new WirebenchError('invalid-offset', 'The caret offset is past the end of the envelope', {
        details: { offset: request.offset, length: request.envelopeXml.length },
      });
    }
    return Promise.resolve(
      declarationAtOffset(service.schemaSetFor(request.interfaceId), request.envelopeXml, request.offset),
    );
  });
}
