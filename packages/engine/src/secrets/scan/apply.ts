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
   * For each applied move, by finding id, the secret value to store: exactly the text replaced
   * (`finding.value`), still escaped as the surrounding JSON, XML or URL had it. Expansion puts a
   * `${secret:…}` value back verbatim, so storing the raw text restores the original bytes.
   */
  readonly values: Record<string, string>;
}

function locationKey(location: SecretLocation): string {
  return JSON.stringify(location);
}

/** Rewrites stored texts; records which moves applied and the raw values they replaced. */
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
  text(location: SecretLocation, text: string): string {
    const moves = this.byKey.get(locationKey(location));
    if (moves === undefined) return text;
    const sorted = [...moves].sort((a, b) => b.finding.valueStart - a.finding.valueStart);
    let out = text;
    let limit = Infinity;
    for (const { finding, name } of sorted) {
      const { valueStart: start, valueEnd: end, value, id } = finding;
      // Compare against the original `text`: ranges index into it, and moves to the right only change `out` past `limit`.
      if (this.applied.has(id) || end > limit || start >= end || text.slice(start, end) !== value) continue;
      out = out.slice(0, start) + secretToken(name) + out.slice(end);
      limit = start;
      this.applied.set(id, value);
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
    return patch(entry, { value: rw.text(location, entry.value) } as Partial<E>);
  });
}

function properties(
  rw: Rewriter,
  props: Readonly<Record<string, string>>,
  location: (name: string) => SecretLocation,
): Readonly<Record<string, string>> {
  let out: Record<string, string> | undefined;
  for (const [name, value] of Object.entries(props)) {
    const next = rw.text(location(name), value);
    if (next !== value) (out ??= { ...props })[name] = next;
  }
  return out ?? props;
}

function restBody(rw: Rewriter, requestId: string, body: RestBody): RestBody {
  if (body.kind === 'raw') {
    return patch(body, { text: rw.text({ kind: 'rest-body', requestId }, body.text) });
  }
  // Built in the key order `walk.ts` uses: the location's JSON is the rewriter's key.
  const field = <E extends KeyValueEntry | { readonly kind: 'file' }>(entry: E, index: number): E =>
    'value' in entry
      ? (patch<KeyValueEntry>(entry, {
          value: rw.text({ kind: 'rest-body', requestId, field: index, name: entry.name }, entry.value),
        }) as E)
      : entry;
  if (body.kind === 'form') return patch(body, { fields: mapShared(body.fields, field) });
  if (body.kind === 'multipart') return patch(body, { parts: mapShared(body.parts, field) });
  return body;
}

function restRequest(rw: Rewriter, request: RestRequestDef): RestRequestDef {
  const requestId = request.id;
  return patch(request, {
    url: rw.text({ kind: 'rest-url', requestId }, request.url),
    query: keyedEntries(rw, 'rest-query', { requestId }, request.query),
    headers: keyedEntries(rw, 'rest-header', { requestId }, request.headers),
    body: restBody(rw, requestId, request.body),
  });
}

/**
 * Replace each move's finding range with `${secret:name}`. Moves in the same text apply right to
 * left, so earlier ranges stay valid; a REST or WS URL and its query table are separate texts. A move
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
                envelopeXml: rw.text({ kind: 'soap-body', requestId: request.id }, request.envelopeXml),
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
            message: rw.text({ kind: 'grpc-message', requestId: request.id }, request.message),
          }),
      ),
    ),
    wsApis: mapShared(project.wsApis, (api) =>
      mapTree(
        patch(api, { headers: keyedEntries(rw, 'ws-api-header', { apiId: api.id }, api.headers) }),
        (request: (typeof api.requests)[number]) =>
          patch(request, {
            url: rw.text({ kind: 'ws-url', requestId: request.id }, request.url),
            query: keyedEntries(rw, 'ws-query', { requestId: request.id }, request.query),
            headers: keyedEntries(rw, 'ws-header', { requestId: request.id }, request.headers),
            messages: mapShared(request.messages, (message) =>
              message.format !== 'text'
                ? message
                : patch(message, {
                    content: rw.text(
                      { kind: 'ws-message', requestId: request.id, messageId: message.id },
                      message.content,
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
  'url-credentials': 'url_password',
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
  const source = 'name' in location ? (location.name ?? '') : '';
  const base = sanitize(source) || RULE_NAMES[finding.rule];
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!lower.has(candidate)) return candidate;
  }
}
