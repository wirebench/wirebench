/**
 * The contract diff of two OpenAPI documents (#56 spec §3, §4): which operations Update Definition's
 * plan finds added and removed, the servers, then per operation both have its security, its
 * parameters, its request body and its responses. Schemas arrive `$ref`-resolved (shared and cyclic
 * graphs); the JSON Schema differ follows each pair of nodes once.
 */
import { diffEndpoints } from '../../contract-diff/endpoints.js';
import type { ContractChange, ContractDiff, ContractSide, MessageSide } from '../../contract-diff/model.js';
import { sortChanges } from '../../contract-diff/model.js';
import { diffSchemas, sameSchema } from '../../contract-diff/schema-diff.js';
import type {
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiRequestBody,
  OpenApiResponse,
  OpenApiSecurityRequirement,
} from './model.js';
import { serverUrl } from './model.js';
import { planRestUpdate } from './update.js';

const keyOf = (op: { readonly method: string; readonly path: string }): string =>
  `${op.method.toLowerCase()} ${op.path}`;

/** How a report names an operation: `GET /pets/{id}`. */
export const openApiOperationLabel = (op: { readonly method: string; readonly path: string }): string =>
  `${op.method.toUpperCase()} ${op.path}`;

/** A response a client counts on: a success status, a success range, or `default`. */
const isSuccess = (status: string): boolean => /^2/.test(status) || status === 'default';

class OperationDiff {
  readonly changes: ContractChange[] = [];

  constructor(readonly operation: string) {}

  add(change: Omit<ContractChange, 'operation'>): void {
    this.changes.push({ ...change, operation: this.operation });
  }

  schemas(before: unknown, after: unknown, side: MessageSide, location: string): void {
    this.changes.push(...diffSchemas(before, after, { side, location, operation: this.operation }));
  }
}

/** Parameters of one location as an object schema, so the field rules apply to them as to body fields. */
function parameterObject(parameters: readonly OpenApiParameter[], location: string): Record<string, unknown> {
  const own = parameters.filter((parameter) => parameter.in === location);
  return {
    type: 'object',
    properties: Object.fromEntries(own.map((parameter) => [parameter.name, parameter.schema ?? {}])),
    required: own.filter((parameter) => parameter.required === true).map((parameter) => parameter.name),
  };
}

const PARAMETER_LOCATIONS = ['path', 'query', 'header', 'cookie'] as const;

/** Where a media type's schema sits: the body itself when it is the only one, else named. */
const bodyLocation = (base: string, mediaType: string, only: boolean): string =>
  only ? base : `${base}(${mediaType})`;

function diffContent(
  diff: OperationDiff,
  before: Readonly<Record<string, { readonly schema?: unknown }>>,
  after: Readonly<Record<string, { readonly schema?: unknown }>>,
  side: MessageSide,
  base: string,
): void {
  const oldTypes = Object.keys(before);
  const newTypes = Object.keys(after);
  for (const mediaType of oldTypes) {
    if (!Object.hasOwn(after, mediaType)) {
      diff.add({ kind: 'media-type-removed', severity: 'breaking', location: base, message: `${mediaType} removed` });
    }
  }
  for (const mediaType of newTypes) {
    if (!Object.hasOwn(before, mediaType)) {
      diff.add({ kind: 'media-type-added', severity: 'compatible', location: base, message: `${mediaType} added` });
    }
  }
  const common = oldTypes.filter((mediaType) => Object.hasOwn(after, mediaType));
  for (const mediaType of common) {
    diff.schemas(
      before[mediaType]?.schema,
      after[mediaType]?.schema,
      side,
      bodyLocation(base, mediaType, common.length === 1),
    );
  }
}

function diffRequestBody(
  diff: OperationDiff,
  before: OpenApiRequestBody | undefined,
  after: OpenApiRequestBody | undefined,
): void {
  const location = 'request.body';
  if (before === undefined && after === undefined) {
    return;
  }
  if (before === undefined) {
    const required = after?.required === true;
    diff.add({
      kind: 'field-added',
      severity: required ? 'breaking' : 'compatible',
      location,
      message: `request body added, ${required ? 'required' : 'optional'}`,
    });
    return;
  }
  if (after === undefined) {
    diff.add({ kind: 'field-removed', severity: 'breaking', location, message: 'request body removed' });
    return;
  }
  if (before.required !== true && after.required === true) {
    diff.add({ kind: 'field-required', severity: 'breaking', location, message: 'request body is now required' });
  } else if (before.required === true && after.required !== true) {
    diff.add({ kind: 'field-optional', severity: 'compatible', location, message: 'request body is now optional' });
  }
  diffContent(diff, before.content, after.content, 'request', location);
}

function diffResponses(
  diff: OperationDiff,
  before: Readonly<Record<string, OpenApiResponse>>,
  after: Readonly<Record<string, OpenApiResponse>>,
): void {
  for (const status of Object.keys(before)) {
    if (!Object.hasOwn(after, status)) {
      diff.add({
        kind: 'response-removed',
        severity: isSuccess(status) ? 'breaking' : 'compatible',
        location: `response.${status}`,
        message: `response ${status} removed`,
      });
    }
  }
  for (const status of Object.keys(after)) {
    const now = after[status];
    const was = before[status];
    if (now === undefined) {
      continue;
    }
    if (was === undefined) {
      diff.add({
        kind: 'response-added',
        severity: 'compatible',
        location: `response.${status}`,
        message: `response ${status} added`,
      });
      continue;
    }
    diffContent(diff, was.content ?? {}, now.content ?? {}, 'response', `response.${status}`);
  }
}

function effectiveSecurity(
  document: OpenApiDocument,
  op: OpenApiOperation,
): { readonly requirements: readonly OpenApiSecurityRequirement[]; readonly schemes: unknown[] } {
  const requirements = op.security ?? document.security ?? [];
  const names = new Set(requirements.flatMap((requirement) => Object.keys(requirement)));
  return {
    requirements,
    schemes: document.securitySchemes.filter((scheme) => names.has(scheme.name)),
  };
}

/** Two versions of an OpenAPI document, compared per operation. */
export function diffOpenApiContracts(
  oldDocument: OpenApiDocument,
  newDocument: OpenApiDocument,
  sides: { readonly old: ContractSide; readonly new: ContractSide },
): ContractDiff {
  const plan = planRestUpdate(oldDocument, newDocument);
  const changes: ContractChange[] = [];

  for (const ref of plan.removed) {
    const operation = openApiOperationLabel(ref);
    changes.push({ kind: 'operation-removed', severity: 'breaking', operation, message: 'operation removed' });
  }
  for (const ref of plan.added) {
    const operation = openApiOperationLabel(ref);
    changes.push({ kind: 'operation-added', severity: 'compatible', operation, message: 'operation added' });
  }
  changes.push(...diffEndpoints(oldDocument.servers.map(serverUrl), newDocument.servers.map(serverUrl)));

  const oldByKey = new Map<string, OpenApiOperation>();
  for (const op of oldDocument.operations) {
    if (!oldByKey.has(keyOf(op))) oldByKey.set(keyOf(op), op);
  }
  let operationsCompared = 0;
  const done = new Set<string>();
  for (const after of newDocument.operations) {
    const key = keyOf(after);
    const before = oldByKey.get(key);
    if (before === undefined || done.has(key)) {
      continue;
    }
    done.add(key);
    operationsCompared += 1;
    const diff = new OperationDiff(openApiOperationLabel(after));
    if (!sameSchema(effectiveSecurity(oldDocument, before), effectiveSecurity(newDocument, after))) {
      diff.add({ kind: 'security-changed', severity: 'breaking', message: 'the security requirements changed' });
    }
    for (const location of PARAMETER_LOCATIONS) {
      diff.schemas(
        parameterObject(before.parameters, location),
        parameterObject(after.parameters, location),
        'request',
        `request.${location}`,
      );
    }
    diffRequestBody(diff, before.requestBody, after.requestBody);
    diffResponses(diff, before.responses ?? {}, after.responses ?? {});
    changes.push(...diff.changes);
  }

  const withInfo = (side: ContractSide, document: OpenApiDocument): ContractSide => ({
    ...side,
    ...(side.title === undefined ? { title: document.info.title } : {}),
    ...(side.version === undefined ? { version: document.info.version } : {}),
  });
  return {
    format: 'openapi',
    old: withInfo(sides.old, oldDocument),
    new: withInfo(sides.new, newDocument),
    operationsCompared,
    changes: sortChanges(changes),
    notes: [],
  };
}
