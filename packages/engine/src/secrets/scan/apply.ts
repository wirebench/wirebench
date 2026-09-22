/**
 * `applySecretMoves`: rewrite a project so each chosen finding's value is replaced by a
 * `${secret:name}` token, and `proposeSecretName`: the name the review dialog offers for a finding
 * (docs/specs/2026-09-22-secret-scanning-design.md, "Move to secret").
 *
 * Pure module: no I/O. The input project is never mutated; unchanged branches are shared.
 */
import type { KeyValueEntry, RestBody, RestRequestDef } from '../../rest/model.js';
import type { Project } from '../../project/model.js';
import { SECRET_NAME_PATTERN, secretToken } from '../secret-token.js';
import type { SecretFinding, SecretLocation } from './walk.js';

export interface SecretMove {
  readonly finding: SecretFinding;
  /** The secret name to write; must match `SECRET_NAME_PATTERN`. */
  readonly name: string;
}

export interface SecretMovesResult {
  /** The rewritten project (the input itself when nothing was applied). */
  readonly project: Project;
  /**
   * Ids of the moves not applied: the stored text no longer holds the finding's value at its
   * range, the location no longer exists, the range overlaps another move, or the name is invalid.
   */
  readonly stale: string[];
  /**
   * For each applied move, by finding id, the secret value to store. `finding.value` is the text as
   * stored; in a JSON, XML or URL-encoded text that is the escaped form, so this is it decoded
   * (JSON string unescape, XML entity decode, percent and `+` decode). For keyed entries, form
   * fields and properties it equals `finding.value`.
   */
  readonly values: Record<string, string>;
}

type Format = 'json' | 'xml' | 'url' | 'plain';

function jsonDecode(raw: string): string {
  try {
    const decoded: unknown = JSON.parse(`"${raw}"`);
    return typeof decoded === 'string' ? decoded : raw;
  } catch {
    return raw;
  }
}

const XML_NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlDecode(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X')) return safeCodePoint(parseInt(ref.slice(2), 16), whole);
    if (ref.startsWith('#')) return safeCodePoint(parseInt(ref.slice(1), 10), whole);
    return XML_NAMED[ref] ?? whole;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

function urlDecode(raw: string): string {
  const spaced = raw.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

function decode(raw: string, format: Format): string {
  if (format === 'json') return jsonDecode(raw);
  if (format === 'xml') return xmlDecode(raw);
  if (format === 'url') return urlDecode(raw);
  return raw;
}

function rawBodyFormat(body: Extract<RestBody, { kind: 'raw' }>): Format {
  const type = (body.contentType ?? '').toLowerCase();
  if (body.language === 'json' || type.includes('json')) return 'json';
  if (body.language === 'xml' || type.includes('xml')) return 'xml';
  if (type.includes('x-www-form-urlencoded')) return 'url';
  return 'plain';
}

/** A ws message has no declared format: treat it as JSON when it looks like JSON. */
function looseFormat(text: string): Format {
  const head = text.trimStart()[0];
  return head === '{' || head === '[' ? 'json' : 'plain';
}

function locationKey(location: SecretLocation): string {
  return JSON.stringify(location);
}

/** Rewrites stored texts; records which moves applied and their decoded values. */
class Rewriter {
  readonly applied = new Map<string, string>();
  private readonly byKey = new Map<string, SecretMove[]>();

  constructor(moves: readonly SecretMove[]) {
    for (const move of moves) {
      if (!SECRET_NAME_PATTERN.test(move.name)) continue;
      const key = locationKey(move.finding.location);
      const list = this.byKey.get(key) ?? [];
      list.push(move);
      this.byKey.set(key, list);
    }
  }

  /** `text` with every move at `location` applied right to left; the same string when none apply. */
  text(location: SecretLocation, text: string, format: Format | ((text: string) => Format)): string {
    const moves = this.byKey.get(locationKey(location));
    if (moves === undefined) return text;
    const fmt = typeof format === 'function' ? format(text) : format;
    const sorted = [...moves].sort((a, b) => b.finding.valueStart - a.finding.valueStart);
    let out = text;
    let limit = Infinity;
    for (const { finding, name } of sorted) {
      const { valueStart: start, valueEnd: end, value, id } = finding;
      if (this.applied.has(id) || end > limit || start >= end || text.slice(start, end) !== value) continue;
      out = out.slice(0, start) + secretToken(name) + out.slice(end);
      limit = start;
      this.applied.set(id, decode(value, fmt));
    }
    return out;
  }
}

/** `list` mapped by `fn`, or `list` itself when no element changed. */
function mapShared<T>(list: readonly T[], fn: (item: T, index: number) => T): readonly T[] {
  let changed = false;
  const out = list.map((item, index) => {
    const next = fn(item, index);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? out : list;
}

function patch<T extends object>(obj: T, next: Partial<T>): T {
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (next[key] !== obj[key]) return { ...obj, ...next };
  }
  return obj;
}

interface TreeNode<R> {
  readonly folders: readonly TreeNode<R>[];
  readonly requests: readonly R[];
}

function mapTree<N extends TreeNode<R>, R>(node: N, fn: (request: R) => R): N {
  return patch(node, {
    requests: mapShared(node.requests, fn),
    folders: mapShared(node.folders, (folder) => mapTree(folder, fn)),
  } as Partial<N>);
}

type KeyedKind = Extract<SecretLocation, { index: number }>['kind'];

function keyedEntries<E extends { readonly name: string; readonly value: string }>(
  rw: Rewriter,
  kind: KeyedKind,
  owner: { requestId: string } | { apiId: string },
  entries: readonly E[],
): readonly E[] {
  return mapShared(entries, (entry, index) => {
    const location = { kind, ...owner, name: entry.name, index } as SecretLocation;
    return patch(entry, { value: rw.text(location, entry.value, 'plain') } as Partial<E>);
  });
}

function properties(
  rw: Rewriter,
  props: Readonly<Record<string, string>>,
  location: (name: string) => SecretLocation,
): Readonly<Record<string, string>> {
  let out: Record<string, string> | undefined;
  for (const [name, value] of Object.entries(props)) {
    const next = rw.text(location(name), value, 'plain');
    if (next !== value) (out ??= { ...props })[name] = next;
  }
  return out ?? props;
}

function restBody(rw: Rewriter, requestId: string, body: RestBody): RestBody {
  if (body.kind === 'raw') {
    return patch(body, { text: rw.text({ kind: 'rest-body', requestId }, body.text, rawBodyFormat(body)) });
  }
  const field = <E extends KeyValueEntry | { readonly kind: 'file' }>(entry: E, index: number): E =>
    'value' in entry
      ? (patch<KeyValueEntry>(entry, {
          value: rw.text({ kind: 'rest-body', requestId, field: index }, entry.value, 'plain'),
        }) as E)
      : entry;
  if (body.kind === 'form') return patch(body, { fields: mapShared(body.fields, field) });
  if (body.kind === 'multipart') return patch(body, { parts: mapShared(body.parts, field) });
  return body;
}

function restRequest(rw: Rewriter, request: RestRequestDef): RestRequestDef {
  const requestId = request.id;
  return patch(request, {
    url: rw.text({ kind: 'rest-url', requestId }, request.url, 'url'),
    query: keyedEntries(rw, 'rest-query', { requestId }, request.query),
    headers: keyedEntries(rw, 'rest-header', { requestId }, request.headers),
    body: restBody(rw, requestId, request.body),
  });
}

/**
 * Replace each move's finding range with `${secret:name}`. Moves in the same text apply right to
 * left, so earlier ranges stay valid; a REST URL and its query table are separate texts. A move
 * whose text no longer holds `finding.value` at `[valueStart, valueEnd)` is skipped and listed in
 * `stale`. See {@link SecretMovesResult.values} for the value main stores.
 */
export function applySecretMoves(project: Project, moves: readonly SecretMove[]): SecretMovesResult {
  const rw = new Rewriter(moves);
  const next = patch(project, {
    properties: properties(rw, project.properties, (name) => ({ kind: 'project-property', name })),
    environments: mapShared(project.environments, (env) =>
      patch(env, {
        properties: properties(rw, env.properties, (name) => ({
          kind: 'env-property',
          environmentId: env.id,
          name,
        })),
      }),
    ),
    interfaces: mapShared(project.interfaces, (iface) =>
      patch(iface, {
        operations: mapShared(iface.operations, (operation) =>
          patch(operation, {
            requests: mapShared(operation.requests, (request) =>
              patch(request, {
                headers: keyedEntries(rw, 'soap-header', { requestId: request.id }, request.headers),
                envelopeXml: rw.text({ kind: 'soap-body', requestId: request.id }, request.envelopeXml, 'xml'),
              }),
            ),
          }),
        ),
      }),
    ),
    apis: mapShared(project.apis, (api) => mapTree(api, (request: RestRequestDef) => restRequest(rw, request))),
    grpcApis: mapShared(project.grpcApis, (api) =>
      mapTree(
        patch(api, { metadata: keyedEntries(rw, 'grpc-api-metadata', { apiId: api.id }, api.metadata) }),
        (request: (typeof api.requests)[number]) =>
          patch(request, {
            metadata: keyedEntries(rw, 'grpc-metadata', { requestId: request.id }, request.metadata),
            message: rw.text({ kind: 'grpc-message', requestId: request.id }, request.message, 'json'),
          }),
      ),
    ),
    wsApis: mapShared(project.wsApis, (api) =>
      mapTree(
        patch(api, { headers: keyedEntries(rw, 'ws-api-header', { apiId: api.id }, api.headers) }),
        (request: (typeof api.requests)[number]) =>
          patch(request, {
            headers: keyedEntries(rw, 'ws-header', { requestId: request.id }, request.headers),
            messages: mapShared(request.messages, (message) =>
              message.format !== 'text'
                ? message
                : patch(message, {
                    content: rw.text(
                      { kind: 'ws-message', requestId: request.id, messageId: message.id },
                      message.content,
                      looseFormat,
                    ),
                  }),
            ),
          }),
      ),
    ),
  });
  const stale = moves.map((m) => m.finding.id).filter((id) => !rw.applied.has(id));
  return { project: next, stale: [...new Set(stale)], values: Object.fromEntries(rw.applied) };
}

const RULE_NAMES: Record<SecretFinding['rule'], string> = {
  'sensitive-name': 'secret',
  jwt: 'jwt',
  bearer: 'bearer_token',
  basic: 'basic_auth',
  'aws-key': 'aws_access_key',
  'private-key': 'private_key',
  'vendor-token': 'api_token',
  'high-entropy': 'secret',
};

function sanitize(raw: string): string {
  const name = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (name === '') return '';
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/**
 * The name offered for `finding`: its header, query, metadata, field or property name, sanitised
 * to `snake_case` (else a name from its rule), made unique against `taken` ignoring case with a
 * `_2`, `_3`, … suffix. Always matches `SECRET_NAME_PATTERN`.
 */
export function proposeSecretName(finding: SecretFinding, taken: ReadonlySet<string>): string {
  const { location } = finding;
  let source = 'name' in location ? location.name : '';
  if (source === '' && location.kind === 'rest-body' && location.field !== undefined) {
    source = /body field (.*)$/.exec(finding.label)?.[1] ?? '';
  }
  const base = sanitize(source) || RULE_NAMES[finding.rule];
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!lower.has(candidate)) return candidate;
  }
}
