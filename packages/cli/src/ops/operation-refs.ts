// packages/cli/src/ops/operation-refs.ts
/**
 * What `generate` and `validate` take for "an operation": `<interface>/<operation>` for SOAP,
 * `<API>/<operationId>` or `<API>/<METHOD> <path>` for REST (the interface or API by name or slug),
 * or the item path of a saved request, which names its operation.
 */
import { selectRequests } from '@wirebench/engine';
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

export function soapRef(iface: Interface, operation: OperationDef): string {
  return `${iface.name}/${operation.name}`;
}

export function restRef(api: RestApi, operation: OpenApiOperation): string {
  return `${api.name}/${operation.method.toUpperCase()} ${operation.path}`;
}

type Container =
  | { readonly kind: 'soap'; readonly iface: Interface; readonly prefix: string }
  | { readonly kind: 'rest'; readonly api: RestApi; readonly prefix: string };

/** The interface or API `ref` starts with, the longest match winning. */
function containerOf(project: Project, ref: string): Container | undefined {
  const candidates: Container[] = [
    ...project.interfaces.flatMap((iface) =>
      [iface.name, iface.slug].map((key): Container => ({ kind: 'soap', iface, prefix: `${key}/` })),
    ),
    ...project.apis.flatMap((api) =>
      [api.name, api.slug].map((key): Container => ({ kind: 'rest', api, prefix: `${key}/` })),
    ),
  ];
  return candidates
    .filter((candidate) => ref.startsWith(candidate.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
}

/** `get /pets` and `GET /pets` alike. */
function methodPath(text: string): string {
  const match = /^(\S+)\s+(.+)$/.exec(text);
  return match === null ? text : `${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`;
}

/** The REST operation a saved request's item path names, through its contract link. */
function operationOfItem(project: Project, document: OpenApiDocument, ref: string): OpenApiOperation | undefined {
  const { selected } = selectRequests(project, [ref]);
  const [only] = selected;
  if (selected.length !== 1 || only === undefined || only.kind !== 'rest' || only.request.contract === undefined) {
    return undefined;
  }
  const contract = only.request.contract;
  return document.operations.find(
    (operation) => operation.method.toLowerCase() === contract.method.toLowerCase() && operation.path === contract.path,
  );
}

function notFound(ref: string): OpsError {
  return new OpsError(
    'operation-not-found',
    `No operation matches "${ref}"; wirebench operations lists the references this project takes`,
    { ref },
  );
}

/** @throws OpsError `operation-not-found`, `definition-cache-missing` */
export async function resolveOperation(project: Project, projectDir: string, ref: string): Promise<ResolvedOperation> {
  const container = containerOf(project, ref);
  if (container === undefined) {
    throw notFound(ref);
  }
  const rest = ref.slice(container.prefix.length);
  if (container.kind === 'soap') {
    const { iface } = container;
    const operation =
      iface.operations.find((candidate) => candidate.name === rest || candidate.slug === rest) ??
      iface.operations.find(
        (candidate) => rest.startsWith(`${candidate.name}/`) || rest.startsWith(`${candidate.slug}/`),
      );
    if (operation === undefined) {
      throw notFound(ref);
    }
    return { kind: 'soap', ref: soapRef(iface, operation), iface, operation, wsdl: await readWsdl(projectDir, iface) };
  }
  const { api } = container;
  const document = await readOpenApi(projectDir, api);
  const wanted = methodPath(rest);
  const operation =
    document.operations.find(
      (candidate) => candidate.operationId === rest || `${candidate.method.toUpperCase()} ${candidate.path}` === wanted,
    ) ?? operationOfItem(project, document, ref);
  if (operation === undefined) {
    throw notFound(ref);
  }
  return { kind: 'rest', ref: restRef(api, operation), api, operation, document };
}
