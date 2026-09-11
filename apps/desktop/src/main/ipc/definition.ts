import { channels, events } from '../../shared/ipc.js';
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

  // Texts come straight from the cached `ImportResult` bundle — the renderer has no fs or
  // network, and nothing is re-fetched to answer this.
  registerHandler(channels.definition.documents, (request) => {
    const result = service.resultFor(request.interfaceId);
    return Promise.resolve({
      documents: result.bundle.documents.map((document) => ({
        location: document.location,
        kind: document.kind,
        size: document.bytes.byteLength,
        text: document.text,
        ...(document.namespace !== undefined ? { namespace: document.namespace } : {}),
      })),
      loadedAt: service.loadedAtFor(request.interfaceId),
    });
  });

  registerHandler(channels.definition.schemaIndex, (request) =>
    Promise.resolve({ namespaces: schemaIndexOf(service.schemaSetFor(request.interfaceId)) }),
  );

  registerHandler(channels.definition.declarationAt, (request) =>
    Promise.resolve(
      declarationAtOffset(service.schemaSetFor(request.interfaceId), request.envelopeXml, request.offset),
    ),
  );
}
