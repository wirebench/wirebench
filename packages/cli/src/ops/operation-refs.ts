// packages/cli/src/ops/operation-refs.ts
/**
 * What `generate` and `validate` take for "an operation": `<interface>/<operation>` for SOAP,
 * `<API>/<operationId>` or `<API>/<METHOD> <path>` for REST (the interface or API by name or slug),
 * or the item path of a saved request, which names its operation.
 */
import { restApisOf, selectRequests, soapInterfacesOf } from '@wirebench/engine';
import type { Interface, OpenApiDocument, OpenApiOperation, OperationDef, Project, RestApi } from '@wirebench/engine';
import { OpsError } from './errors.js';
import { readOpenApi, readWsdl } from './project.js';
import type { LoadedWsdl } from './project.js';

export type ResolvedOperation =
  | {
      readonly kind: 'soap';
      readonly ref: string;
      readonly iface: Interface;
      readonly operation: OperationDef;
      readonly wsdl: LoadedWsdl;
    }
  | {
      readonly kind: 'rest';
      readonly ref: string;
      readonly api: RestApi;
      readonly operation: OpenApiOperation;
      readonly document: OpenApiDocument;
    };

/**
 * The reference for an operation. An interface with two operations of one name (a SOAP 1.1 and a
 * SOAP 1.2 binding) refers to each by its unique slug (`Add`, `Add-2`); otherwise the name is used.
 */
export function soapRef(iface: Interface, operation: OperationDef): string {
  const shared = iface.operations.filter((candidate) => candidate.name === operation.name).length > 1;
  return `${iface.name}/${shared ? operation.slug : operation.name}`;
}

export function restRef(api: RestApi, operation: OpenApiOperation): string {
  return `${api.name}/${operation.method.toUpperCase()} ${operation.path}`;
}

type Container =
  | { readonly kind: 'soap'; readonly iface: Interface; readonly rest: string }
  | { readonly kind: 'rest'; readonly api: RestApi; readonly rest: string };

/**
 * Every interface and API whose name or slug, plus `/`, is the longest prefix of `ref`, each with
 * what follows that prefix. An interface and an API may share a name, so this can be more than one.
 */
function containersOf(project: Project, ref: string): Container[] {
  const keyed = [
    ...soapInterfacesOf(project).flatMap((iface) =>
      [iface.name, iface.slug].map((key) => ({
        key: `${key}/`,
        id: `soap:${iface.id}`,
        container: { kind: 'soap', iface } as const,
      })),
    ),
    ...restApisOf(project).flatMap((api) =>
      [api.name, api.slug].map((key) => ({
        key: `${key}/`,
        id: `rest:${api.id}`,
        container: { kind: 'rest', api } as const,
      })),
    ),
  ].filter((candidate) => ref.startsWith(candidate.key));
  const longest = Math.max(0, ...keyed.map((candidate) => candidate.key.length));
  const found = new Map<string, Container>();
  for (const candidate of keyed) {
    if (candidate.key.length === longest) {
      found.set(candidate.id, { ...candidate.container, rest: ref.slice(longest) });
    }
  }
  return [...found.values()];
}

/** `get /pets` and `GET /pets` alike. */
function methodPath(text: string): string {
  const match = /^(\S+)\s+(.+)$/.exec(text);
  return match === null ? text : `${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`;
}

function notFound(ref: string): OpsError {
  return new OpsError(
    'operation-not-found',
    `No operation matches "${ref}"; wirebench operations lists the references this project takes`,
    { ref },
  );
}

function ambiguous(ref: string, candidates: readonly string[]): OpsError {
  return new OpsError('item-ambiguous', `"${ref}" is ambiguous; use one of: ${candidates.join(', ')}`, {
    ref,
    candidates: [...candidates],
  });
}

/** The operation `rest` names in `iface`: its slug, else its name (which two bindings can share). */
function soapOperationIn(iface: Interface, rest: string, ref: string): OperationDef | undefined {
  const bySlug = iface.operations.filter((candidate) => candidate.slug === rest);
  if (bySlug.length === 1) {
    return bySlug[0];
  }
  const byName = iface.operations.filter((candidate) => candidate.name === rest);
  if (byName.length > 1) {
    throw ambiguous(
      ref,
      byName.map((candidate) => `${iface.name}/${candidate.slug}`),
    );
  }
  return byName[0];
}

/** The operation a saved request's item path names: the item's path is `ref`, exactly. */
function soapOperationOfItem(project: Project, iface: Interface, ref: string): OperationDef | undefined {
  const owners = selectRequests(project, [])
    .selected.flatMap((item) =>
      item.kind === 'soap' && item.iface.id === iface.id && item.path === ref ? [item.operation] : [],
    )
    .filter((operation, index, all) => all.findIndex((other) => other.slug === operation.slug) === index);
  if (owners.length > 1) {
    throw ambiguous(
      ref,
      owners.map((operation) => soapRef(iface, operation)),
    );
  }
  return owners[0];
}

/** The REST operation a saved request's item path names, through its contract link. */
function restOperationOfItem(
  project: Project,
  api: RestApi,
  document: OpenApiDocument,
  ref: string,
): OpenApiOperation | undefined {
  const [only, ...others] = selectRequests(project, []).selected.filter(
    (item) => item.kind === 'rest' && item.api.id === api.id && item.path === ref,
  );
  if (only === undefined || others.length > 0 || only.kind !== 'rest' || only.request.contract === undefined) {
    return undefined;
  }
  const contract = only.request.contract;
  return document.operations.find(
    (operation) => operation.method.toLowerCase() === contract.method.toLowerCase() && operation.path === contract.path,
  );
}

async function resolveIn(
  container: Container,
  project: Project,
  projectDir: string,
  ref: string,
): Promise<ResolvedOperation | undefined> {
  const { rest } = container;
  if (container.kind === 'soap') {
    const { iface } = container;
    const operation = soapOperationIn(iface, rest, ref) ?? soapOperationOfItem(project, iface, ref);
    return operation === undefined
      ? undefined
      : { kind: 'soap', ref: soapRef(iface, operation), iface, operation, wsdl: await readWsdl(projectDir, iface) };
  }
  const { api } = container;
  const document = await readOpenApi(projectDir, api);
  const wanted = methodPath(rest);
  const operation =
    document.operations.find(
      (candidate) => candidate.operationId === rest || `${candidate.method.toUpperCase()} ${candidate.path}` === wanted,
    ) ?? restOperationOfItem(project, api, document, ref);
  return operation === undefined ? undefined : { kind: 'rest', ref: restRef(api, operation), api, operation, document };
}

/**
 * Finds the operation `ref` names. An operation reference is tried first (`<interface>/<operation>`,
 * `<API>/<operationId>`, `<API>/<METHOD> <path>`), then a saved request's item path, which must equal
 * `ref` exactly. An interface and an API can share a name: the one `ref` resolves in is used, and a
 * `ref` that resolves in several is ambiguous.
 *
 * @throws OpsError `operation-not-found`, `item-ambiguous`, `definition-cache-missing`
 */
export async function resolveOperation(project: Project, projectDir: string, ref: string): Promise<ResolvedOperation> {
  const resolved: ResolvedOperation[] = [];
  let missingCache: OpsError | undefined;
  for (const container of containersOf(project, ref)) {
    try {
      const found = await resolveIn(container, project, projectDir, ref);
      if (found !== undefined) {
        resolved.push(found);
      }
    } catch (error) {
      if (error instanceof OpsError && error.code === 'definition-cache-missing') {
        missingCache ??= error;
      } else {
        throw error;
      }
    }
  }
  if (resolved.length > 1) {
    throw ambiguous(
      ref,
      resolved.map((found) => `${found.kind === 'soap' ? 'interface' : 'API'} ${found.ref}`),
    );
  }
  const [only] = resolved;
  if (only !== undefined) {
    return only;
  }
  throw missingCache ?? notFound(ref);
}
