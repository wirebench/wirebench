import { bindingContextFor, ProjectError, unescapeExpansions, validateMessage } from '@wirebench/engine';
import type { QName } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import type { ProjectRouter } from '../project-router.js';
import { registerHandler } from './register.js';

/** The `ProjectRouter` surface `validate.message` needs; a stub stands in for it in tests. */
export type ValidateChannelProject = Pick<ProjectRouter, 'validationTargetFor'>;

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
 * Registers `validate.message`: validates one request's (or response's) envelope against the
 * interface's schema set and the SOAP rules its binding implies.
 *
 * Runs in main because the compiled `SchemaSet` and libxml2 (`xmllint-wasm`) both live here —
 * the renderer never sees either. `xml` on the request overrides the saved envelope, so the
 * editor can validate text the user has not saved yet.
 */
export function registerValidateChannels(service: EngineService, project: ValidateChannelProject): void {
  registerHandler(channels.validate.message, async (request) => {
    const target = project.validationTargetFor(request.requestId);
    if (target === undefined) {
      throw new ProjectError('unknown-request', `No saved request with id "${request.requestId}"`, {
        details: { requestId: request.requestId },
      });
    }
    const result = service.resultFor(target.interfaceId);
    const binding = bindingContextFor(
      result.definition,
      { bindingName: parseClarkQName(target.bindingName), operationName: target.operationName },
      request.direction,
    );
    if (binding === undefined) {
      throw new ProjectError(
        'unknown-operation',
        `${target.bindingName} has no SOAP operation "${target.operationName}"`,
        { details: { requestId: request.requestId, operationName: target.operationName } },
      );
    }

    // Validate reads a request as written, placeholders and all, except the `$${` escape: that is a
    // literal `${` the request sends — a generated value the contract wrote with `${` (#223) — so it
    // is checked as the text it stands for. A response is what a server sent, and is never touched.
    const literal = (text: string): string => (request.direction === 'request' ? unescapeExpansions(text) : text);
    const { problems, durationMs } = await validateMessage({
      xml: literal(request.xml ?? target.envelopeXml),
      direction: request.direction,
      schemaSet: result.schemaSet,
      bundle: result.bundle,
      binding,
      http: {
        ...(target.contentType !== undefined ? { contentType: literal(target.contentType) } : {}),
        ...(target.soapAction !== undefined ? { soapAction: literal(target.soapAction) } : {}),
      },
    });

    // The engine's problems are `readonly`-everywhere; the response schema needs plain objects.
    return { problems: problems.map((problem) => ({ ...problem })), durationMs };
  });
}
