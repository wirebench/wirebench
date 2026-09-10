import { childrenAllowedAt, declarationOf } from '@wirebench/engine';
import type { QName } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import { registerHandler } from './register.js';

/** Parses a Clark-notation QName string (`{namespaceUri}localName`) back into a `QName`. */
function parseClarkQName(clark: string): QName {
  const match = /^\{([^}]*)\}(.*)$/.exec(clark);
  if (match === null) {
    return { namespaceUri: '', localName: clark };
  }
  const [, namespaceUri, localName] = match;
  return { namespaceUri: namespaceUri ?? '', localName: localName ?? '' };
}

/**
 * Registers the `xml.*` IPC channels: schema-driven completion and "go to declaration" for the
 * request editor. Runs in main because the `SchemaSet` for an imported interface lives here
 * (`EngineService`), not in the browser-safe renderer.
 */
export function registerXmlChannels(service: EngineService): void {
  registerHandler(channels.xml.completions, (request) => {
    const schemaSet = service.schemaSetFor(request.interfaceId);
    const path = request.path.map(parseClarkQName);
    const partialLocal = (request.partial ?? '').includes(':')
      ? (request.partial as string).slice((request.partial as string).indexOf(':') + 1)
      : (request.partial ?? '');
    const items = childrenAllowedAt(schemaSet, path)
      .filter((decl) => partialLocal === '' || decl.name.localName.toLowerCase().startsWith(partialLocal.toLowerCase()))
      .map((decl) => ({
        name: decl.name.localName,
        namespaceUri: decl.name.namespaceUri,
        ...(decl.documentation !== undefined ? { documentation: decl.documentation } : {}),
      }));
    return Promise.resolve({ items });
  });

  registerHandler(channels.xml.declaration, (request) => {
    const schemaSet = service.schemaSetFor(request.interfaceId);
    const path = request.path.map(parseClarkQName);
    const found = declarationOf(schemaSet, path);
    if (found === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      location: found.source.location,
      ...(found.source.line !== undefined ? { line: found.source.line } : {}),
      ...(found.source.column !== undefined ? { column: found.source.column } : {}),
    });
  });
}
