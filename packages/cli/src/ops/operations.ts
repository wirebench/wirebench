// packages/cli/src/ops/operations.ts
import { loadOpenApiDocument, redactUrl, selectRequests, summarizeSoapOperations } from '@wirebench/engine';
import type { Interface, SoapOperationSummary } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { OpsError } from './errors.js';
import { restRef, soapRef } from './operation-refs.js';
import { clarkToQName, openProject, readWsdl } from './project.js';
import { redactUrlsInText } from './redact.js';

export type OperationRow =
  | {
      readonly kind: 'soap';
      readonly container: string;
      readonly binding: string;
      readonly operation: string;
      readonly soapAction?: string;
      /** What `generate` and `validate` take. */
      readonly ref: string;
      /** The saved requests `send` takes. */
      readonly items: readonly string[];
    }
  | {
      readonly kind: 'rest';
      readonly container: string;
      readonly method: string;
      readonly path: string;
      readonly operationId?: string;
      readonly ref: string;
      readonly items: readonly string[];
    }
  | {
      /** One saved WebSocket request: no contract operation for generate or validate, so its path is the ref. */
      readonly kind: 'websocket';
      readonly container: string;
      /** The request's own URL, credentials and secret query values masked by pattern. */
      readonly url: string;
      readonly ref: string;
      readonly items: readonly string[];
    };

export interface OperationsResult {
  readonly operations: readonly OperationRow[];
  /** What could not be listed in full, and why. */
  readonly notes: readonly string[];
}

const input = z.object({
  container: z
    .string()
    .min(1)
    .optional()
    .describe('An interface, a REST API or a WebSocket API, by name or slug; all of them when absent'),
});

const byOrder = <T extends { readonly order: number; readonly name: string }>(a: T, b: T): number =>
  a.order - b.order || a.name.localeCompare(b.name);

async function soapSummaries(
  projectDir: string,
  iface: Interface,
  notes: string[],
): Promise<readonly SoapOperationSummary[] | undefined> {
  try {
    return summarizeSoapOperations((await readWsdl(projectDir, iface)).definition);
  } catch (error) {
    if (error instanceof OpsError && error.code === 'definition-cache-missing') {
      notes.push(`${iface.name}: no cached definition, so no SOAP actions`);
      return undefined;
    }
    throw error;
  }
}

/** A saved request's URL as a row shows it: credentials and secret query values masked by pattern. */
function redactRequestUrl(url: string): string {
  const query = url.indexOf('?');
  if (query === -1 || /^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return redactUrlsInText(url);
  }
  // A relative URL: mask its query the way an absolute one is masked.
  const masked = redactUrl(`http://wirebench.invalid/${url.slice(query)}`);
  return `${url.slice(0, query)}${masked.slice('http://wirebench.invalid/'.length)}`;
}

export const operationsOp = defineOp({
  name: 'operations',
  title: 'List operations',
  description:
    "Lists the project's SOAP operations (interface, binding, operation, SOAP action), REST endpoints " +
    '(API, method, path, operationId) and saved WebSocket requests (API, URL). Each row carries the reference ' +
    'generate and validate take, and the paths of the saved requests send takes. Reads only.',
  input,
  async run(value, context): Promise<OperationsResult> {
    const { project } = await openProject(context);
    const wanted = value.container;
    const matches = (container: { readonly name: string; readonly slug: string }): boolean =>
      wanted === undefined || container.name === wanted || container.slug === wanted;
    const interfaces = [...project.interfaces].filter(matches).sort(byOrder);
    const apis = [...project.apis].filter(matches).sort(byOrder);
    // gRPC APIs are left out: send refuses their requests, and generate and validate take none.
    const wsApis = [...project.wsApis].filter(matches).sort(byOrder);
    if (wanted !== undefined && interfaces.length + apis.length + wsApis.length === 0) {
      throw new OpsError('container-not-found', `No interface or API is named "${wanted}"`, { container: wanted });
    }
    const selected = selectRequests(project, []).selected;
    const notes: string[] = [];
    const shared = new Set(
      [...project.interfaces, ...project.apis, ...project.wsApis]
        .map((container) => container.name)
        .filter((name, index, names) => names.indexOf(name) !== index),
    );
    for (const name of shared) {
      if ([...interfaces, ...apis, ...wsApis].some((container) => container.name === name)) {
        notes.push(`More than one interface or API is named "${name}"; a reference starting with it may be ambiguous`);
      }
    }
    const soapItems = selected.filter((item) => item.kind === 'soap');
    const restItems = selected.filter((item) => item.kind === 'rest');
    const wsItems = selected.filter((item) => item.kind === 'websocket');
    const operations: OperationRow[] = [];

    for (const iface of interfaces) {
      const summaries = await soapSummaries(context.projectDir, iface, notes);
      for (const operation of [...iface.operations].sort(byOrder)) {
        const soapAction = summaries?.find(
          (summary) =>
            summary.operationName === operation.name &&
            `{${summary.bindingName.namespaceUri}}${summary.bindingName.localName}` === operation.bindingName,
        )?.soapAction;
        operations.push({
          kind: 'soap',
          container: iface.name,
          binding: clarkToQName(operation.bindingName).localName,
          operation: operation.name,
          ...(soapAction !== undefined ? { soapAction } : {}),
          ref: soapRef(iface, operation),
          items: soapItems
            .filter((item) => item.iface.id === iface.id && item.operation.slug === operation.slug)
            .map((item) => item.path),
        });
      }
    }

    for (const api of apis) {
      const own = restItems.filter((item) => item.api.id === api.id);
      const document = await loadOpenApiDocument(context.projectDir, api.slug);
      if (document === undefined) {
        notes.push(`${api.name}: no cached definition, so its saved requests are listed instead`);
        for (const item of own) {
          operations.push({
            kind: 'rest',
            container: api.name,
            method: item.request.method,
            path: redactRequestUrl(item.request.url),
            ref: item.path,
            items: [item.path],
          });
        }
        continue;
      }
      for (const operation of document.operations) {
        operations.push({
          kind: 'rest',
          container: api.name,
          method: operation.method.toUpperCase(),
          path: operation.path,
          ...(operation.operationId !== undefined ? { operationId: operation.operationId } : {}),
          ref: restRef(api, operation),
          items: own
            .filter(
              (item) =>
                item.request.contract?.method.toLowerCase() === operation.method.toLowerCase() &&
                item.request.contract.path === operation.path,
            )
            .map((item) => item.path),
        });
      }
    }
    for (const api of wsApis) {
      for (const item of wsItems.filter((candidate) => candidate.api.id === api.id)) {
        operations.push({
          kind: 'websocket',
          container: api.name,
          url: redactRequestUrl(item.request.url),
          ref: item.path,
          items: [item.path],
        });
      }
    }
    return { operations, notes };
  },
});
