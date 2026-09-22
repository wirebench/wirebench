/**
 * Where the secret scanner looks: every stored value in a project that is sent or expanded, as a
 * {@link ScanTarget} carrying the exact {@link SecretLocation} a later rewrite (`applySecretMoves`)
 * needs to find that text again.
 *
 * Pure module: no I/O.
 */
import type { KeyValueEntry, RestBody, RestRequestDef } from '../../rest/model.js';
import type { GrpcRequestDef } from '../../grpc/model.js';
import type { WsRequestDef } from '../../ws/model.js';
import type { Project } from '../../project/model.js';
import type { DetectContext, SecretRule } from './rules.js';

/**
 * Where a finding's value is stored. The finding's `valueStart`/`valueEnd` index into that stored
 * text: the entry's value for the keyed kinds and the properties, the text itself for the others.
 *
 * Beyond the spec's fields, `index` pins a keyed entry by its position in its list (names may
 * repeat), `field` names the form field or multipart text part a `rest-body` finding sits in
 * (absent for a raw body), and `messageId` names the saved message of a `ws-message` finding.
 */
export type SecretLocation =
  | {
      readonly kind: 'soap-header' | 'rest-header' | 'rest-query' | 'grpc-metadata' | 'ws-header';
      readonly requestId: string;
      readonly name: string;
      readonly index: number;
    }
  | { readonly kind: 'rest-body'; readonly requestId: string; readonly field?: number }
  | { readonly kind: 'soap-body' | 'rest-url' | 'grpc-message'; readonly requestId: string }
  | { readonly kind: 'ws-message'; readonly requestId: string; readonly messageId: string }
  | { readonly kind: 'project-property'; readonly name: string }
  | { readonly kind: 'env-property'; readonly environmentId: string; readonly name: string };

export interface SecretFinding {
  /** sha256 of the location and value, hex, first 16 characters: stable while neither changes. */
  readonly id: string;
  readonly location: SecretLocation;
  readonly rule: SecretRule;
  /** Display path, `Billing API › GET /invoices › header Authorization`. */
  readonly label: string;
  readonly valueStart: number;
  readonly valueEnd: number;
  /** The credential itself; never crosses IPC (the wire shape carries `maskedPreview`). */
  readonly value: string;
}

/** One stored text to scan. */
export interface ScanTarget {
  readonly location: SecretLocation;
  readonly label: string;
  readonly text: string;
  readonly context: DetectContext;
}

const SEP = ' › ';

function* keyed(
  kind: 'soap-header' | 'rest-header' | 'rest-query' | 'grpc-metadata' | 'ws-header',
  requestId: string,
  path: string,
  noun: string,
  nameKind: NonNullable<DetectContext['nameKind']>,
  entries: readonly { readonly name: string; readonly value: string }[],
): Generator<ScanTarget> {
  for (let index = 0; index < entries.length; index++) {
    const { name, value } = entries[index]!;
    if (value === '') continue;
    yield {
      location: { kind, requestId, name, index },
      label: `${path}${SEP}${noun} ${name}`,
      text: value,
      context: { fieldName: name, nameKind },
    };
  }
}

function rawContentType(body: Extract<RestBody, { kind: 'raw' }>): string {
  if (body.contentType !== undefined) return body.contentType;
  if (body.language === 'json') return 'application/json';
  if (body.language === 'xml') return 'application/xml';
  return 'text/plain';
}

function* restBody(request: RestRequestDef, path: string): Generator<ScanTarget> {
  const { body } = request;
  if (body.kind === 'raw') {
    if (body.text !== '') {
      yield {
        location: { kind: 'rest-body', requestId: request.id },
        label: `${path}${SEP}body`,
        text: body.text,
        context: { contentType: rawContentType(body) },
      };
    }
    return;
  }
  const fields: readonly (KeyValueEntry | { readonly kind: 'file' })[] =
    body.kind === 'form' ? body.fields : body.kind === 'multipart' ? body.parts : [];
  for (let field = 0; field < fields.length; field++) {
    const entry = fields[field]!;
    if (!('value' in entry) || entry.value === '') continue;
    yield {
      location: { kind: 'rest-body', requestId: request.id, field },
      label: `${path}${SEP}body field ${entry.name}`,
      text: entry.value,
      context: { fieldName: entry.name, nameKind: 'field' },
    };
  }
}

function* restRequest(request: RestRequestDef, prefix: string): Generator<ScanTarget> {
  const path = `${prefix}${SEP}${request.name}`;
  if (request.url !== '') {
    yield {
      location: { kind: 'rest-url', requestId: request.id },
      label: `${path}${SEP}URL`,
      text: request.url,
      context: { contentType: 'application/x-www-form-urlencoded', nameKind: 'query' },
    };
  }
  yield* keyed('rest-query', request.id, path, 'query', 'query', request.query);
  yield* keyed('rest-header', request.id, path, 'header', 'header', request.headers);
  yield* restBody(request, path);
}

function* grpcRequest(request: GrpcRequestDef, prefix: string): Generator<ScanTarget> {
  const path = `${prefix}${SEP}${request.name}`;
  yield* keyed('grpc-metadata', request.id, path, 'metadata', 'header', request.metadata);
  if (request.message !== '') {
    yield {
      location: { kind: 'grpc-message', requestId: request.id },
      label: `${path}${SEP}message`,
      text: request.message,
      context: { contentType: 'application/json' },
    };
  }
}

function* wsRequest(request: WsRequestDef, prefix: string): Generator<ScanTarget> {
  const path = `${prefix}${SEP}${request.name}`;
  yield* keyed('ws-header', request.id, path, 'header', 'header', request.headers);
  for (const message of request.messages) {
    if (message.format !== 'text' || message.content === '') continue;
    yield {
      location: { kind: 'ws-message', requestId: request.id, messageId: message.id },
      label: `${path}${SEP}message ${message.name}`,
      text: message.content,
      context: {},
    };
  }
}

interface Tree<R> {
  readonly name: string;
  readonly folders: readonly Tree<R>[];
  readonly requests: readonly R[];
}

function* tree<R>(
  node: Omit<Tree<R>, 'name'>,
  prefix: string,
  visit: (request: R, prefix: string) => Generator<ScanTarget>,
): Generator<ScanTarget> {
  for (const request of node.requests) yield* visit(request, prefix);
  for (const folder of node.folders) yield* tree(folder, `${prefix}${SEP}${folder.name}`, visit);
}

/** Every scannable stored text in `project`, in explorer order within each container kind. */
export function* scanTargets(project: Project): Generator<ScanTarget> {
  for (const [name, value] of Object.entries(project.properties)) {
    if (value === '') continue;
    yield {
      location: { kind: 'project-property', name },
      label: `${project.name}${SEP}property ${name}`,
      text: value,
      context: { fieldName: name, nameKind: 'property' },
    };
  }
  for (const env of project.environments) {
    for (const [name, value] of Object.entries(env.properties)) {
      if (value === '') continue;
      yield {
        location: { kind: 'env-property', environmentId: env.id, name },
        label: `Environment ${env.name}${SEP}property ${name}`,
        text: value,
        context: { fieldName: name, nameKind: 'property' },
      };
    }
  }
  for (const iface of project.interfaces) {
    for (const operation of iface.operations) {
      for (const request of operation.requests) {
        const path = `${iface.name}${SEP}${operation.name}${SEP}${request.name}`;
        yield* keyed('soap-header', request.id, path, 'header', 'header', request.headers);
        if (request.envelopeXml !== '') {
          yield {
            location: { kind: 'soap-body', requestId: request.id },
            label: `${path}${SEP}envelope`,
            text: request.envelopeXml,
            context: { contentType: 'text/xml' },
          };
        }
      }
    }
  }
  for (const api of project.apis) yield* tree(api, api.name, restRequest);
  for (const api of project.grpcApis) yield* tree(api, api.name, grpcRequest);
  for (const api of project.wsApis) yield* tree(api, api.name, wsRequest);
}
