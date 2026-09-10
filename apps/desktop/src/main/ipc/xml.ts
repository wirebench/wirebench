import { attributesAllowedAt, childrenAllowedAt, declarationOf, qnameToString } from '@wirebench/engine';
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

  registerHandler(channels.xml.describeMany, (request) => {
    const schemaSet = service.schemaSetFor(request.interfaceId);
    const results = request.paths.map((clarkPath) => {
      // An attribute segment is encoded as a trailing `@name` entry after the owning element's
      // ancestor path — unambiguous since no Clark-notation element segment can start with `@`.
      const last = clarkPath[clarkPath.length - 1];
      if (last !== undefined && last.startsWith('@')) {
        const attrName = last.slice(1);
        const elementPath = clarkPath.slice(0, -1).map(parseClarkQName);
        const attr = attributesAllowedAt(schemaSet, elementPath).find(
          (candidate) => candidate.name.localName === attrName,
        );
        if (attr === undefined) {
          return null;
        }
        const typeName = attr.type !== undefined ? qnameToString(attr.type) : '';
        return { typeName, kind: 'attribute' as const };
      }
      const path = clarkPath.map(parseClarkQName);
      const found = declarationOf(schemaSet, path);
      if (found === undefined) {
        return null;
      }
      // A named type reference (`type="tns:Foo"`) renders as its Clark-notation QName; an
      // inline `<xs:complexType>`/`<xs:simpleType>` has no name of its own, so this reports ''
      // (anonymous) per the outline's Type column contract.
      const typeName = found.element.type !== undefined ? qnameToString(found.element.type) : '';
      return {
        typeName,
        kind: 'element' as const,
        nillable: found.element.nillable,
        ...(found.element.documentation !== undefined ? { documentation: found.element.documentation } : {}),
      };
    });
    return Promise.resolve({ results });
  });
}
