/**
 * Where a request's script types come from (spec §Types): the OpenAPI operation a REST request is
 * linked to, the input and output elements of a SOAP operation, a gRPC method's messages. These are
 * lookups over definitions the host has already loaded, plus the REST document loader the CLI needs
 * (the app keeps its own, memoised, in `ProjectHost.openApiDocumentFor`).
 */
import { ProjectError } from '../errors.js';
import type { QName } from '../wsdl/qname.js';
import { findBinding, findMessage, findPortType, type WsdlDefinition } from '../wsdl/model.js';
import { apiDefinitionDir } from '../project/paths.js';
import { createCachedApiFetch, readApiDefinitionCache } from '../rest/openapi/cache.js';
import { parseOpenApi } from '../rest/openapi/import.js';
import type { OpenApiDocument, OpenApiOperation } from '../rest/openapi/model.js';
import type { RestContractLink } from '../rest/model.js';
import { describeMethod } from '../grpc/proto/describe.js';
import type { ProtoSet } from '../grpc/proto/load.js';

/** `{namespace}local` as a QName. */
export function qnameFromClark(clark: string): QName {
  const match = /^\{([^}]*)\}(.*)$/.exec(clark);
  return match === null ? { namespaceUri: '', localName: clark } : { namespaceUri: match[1]!, localName: match[2]! };
}

/**
 * The elements a document-style SOAP operation's input and output messages name, when each message
 * has exactly one element part — the shape a typed body needs. An RPC-style operation, or a message
 * of type parts, has none.
 */
export function soapOperationElements(
  definition: WsdlDefinition,
  bindingName: string,
  operationName: string,
): { readonly input?: QName; readonly output?: QName } {
  const binding = findBinding(definition, qnameFromClark(bindingName));
  if (binding === undefined) return {};
  const bindingOperation = binding.operations.find((op) => op.name === operationName);
  // An operation's own style overrides its binding's.
  if ((bindingOperation?.style ?? binding.style) === 'rpc') return {};
  const operation = findPortType(definition, binding.type)?.operations.find((op) => op.name === operationName);
  const elementOf = (ref: { readonly message: QName } | undefined): QName | undefined => {
    const message = ref === undefined ? undefined : findMessage(definition, ref.message);
    const elements = message?.parts.filter((part) => part.element !== undefined) ?? [];
    return elements.length === 1 ? elements[0]!.element : undefined;
  };
  const input = elementOf(operation?.input);
  const output = elementOf(operation?.output);
  return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
}

/** The operation a REST request is linked to, by its method and templated path. */
export function restOperationFor(
  document: OpenApiDocument | undefined,
  contract: RestContractLink | undefined,
): OpenApiOperation | undefined {
  if (document === undefined || contract === undefined) return undefined;
  return document.operations.find(
    (op) => op.method.toLowerCase() === contract.method.toLowerCase() && op.path === contract.path,
  );
}

/** An API's cached OpenAPI document, read offline; `undefined` when it has none or it cannot be read. */
export async function loadOpenApiDocument(projectDir: string, apiSlug: string): Promise<OpenApiDocument | undefined> {
  const dir = apiDefinitionDir(projectDir, apiSlug);
  try {
    const cached = await readApiDefinitionCache(dir);
    const offline = createCachedApiFetch(cached.manifest, dir, (location) =>
      Promise.reject(
        new ProjectError('definition-cache-missing', `"${location}" is not in this API's definition cache`, {
          details: { location },
        }),
      ),
    );
    const parsed = await parseOpenApi({ kind: 'url', url: cached.manifest.rootLocation }, { fetchDocument: offline });
    return parsed.document;
  } catch {
    return undefined;
  }
}

/** A gRPC method's request and response message types, when the set has the method. */
export function grpcMessageTypes(
  set: ProtoSet | undefined,
  service: string,
  method: string,
): { readonly input: string; readonly output: string } | undefined {
  if (set === undefined) return undefined;
  try {
    const described = describeMethod(set, service, method);
    return { input: described.requestType, output: described.responseType };
  } catch {
    return undefined;
  }
}
