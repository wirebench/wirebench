import { bindingContextFor, ProjectError, validateMessage } from '@wirebench/engine';
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

    const { problems, durationMs } = await validateMessage({
      xml: request.xml ?? target.envelopeXml,
      direction: request.direction,
      schemaSet: result.schemaSet,
      bundle: result.bundle,
      binding,
      http: {
        ...(target.contentType !== undefined ? { contentType: target.contentType } : {}),
        ...(target.soapAction !== undefined ? { soapAction: target.soapAction } : {}),
      },
    });

    // The engine's problems are `readonly`-everywhere; the response schema needs plain objects.
    return { problems: problems.map((problem) => ({ ...problem })), durationMs };
  });
}
