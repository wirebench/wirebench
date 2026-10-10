/**
 * `applySecretMoves`: rewrite a project so each chosen finding's value is replaced by a
 * `${secret:name}` token, and `proposeSecretName`: the name the review dialog offers for a finding
 * (docs/specs/2026-09-22-secret-scanning-design.md, "Move to secret"). Core rewrites the project's
 * and its environments' properties; each protocol's secrets facet rewrites its own texts.
 *
 * Pure module: no I/O. The input project is never mutated; unchanged branches are shared.
 */
import type { Project } from '../../project/model.js';
import type { ProtocolRegistry } from '../../protocol/registry.js';
import { defaultRegistry } from '../../protocols.js';
import { mapShared, patch, SecretRewriter } from './support.js';
import type { SecretFinding, SecretLocation, SecretMove } from './support.js';

export type { SecretMove } from './support.js';

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

function properties(
  rw: SecretRewriter,
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

/**
 * Replace each move's finding range with `${secret:name}`. Moves in the same text apply right to
 * left, so earlier ranges stay valid; a REST or WS URL and its query table are separate texts. A move
 * whose text no longer holds `finding.value` at `[valueStart, valueEnd)` is skipped and listed in
 * `stale`. See {@link SecretMovesResult.values} for the value main stores.
 */
export function applySecretMoves(
  project: Project,
  moves: readonly SecretMove[],
  registry: ProtocolRegistry = defaultRegistry(),
): SecretMovesResult {
  const rw = new SecretRewriter(moves);
  let next = patch(project, {
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
  });
  for (const module of registry.modules) {
    if (module.secrets !== undefined) next = module.secrets.applyMoves(next, rw);
  }
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
 * The name offered for `finding`: its header, query (in the table or the URL), metadata, field or
 * property name, sanitised to `snake_case` (else a name from its rule: `url_password` for a URL's
 * password), made unique against `taken` ignoring case with a `_2`, `_3`, … suffix. Always matches
 * `SECRET_NAME_PATTERN`.
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
