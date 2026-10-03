/**
 * `secret.*` events from a push's paths (audit-log spec §3.2, plan ruling 6). The server never parses a
 * team-secrets file, so what it can say is which kind of file changed and whether a value is new. A
 * value file is named by its entry's id (`team-secrets/schema.ts`), so `ids` are ids, never values.
 * Paths are compared lower-cased, as `sync/routes/commits.ts` does, and a path changed in several
 * commits of one push counts once, judged by whether it existed at the push's parent.
 */
import {
  TEAM_SECRETS_ACCESS_DIR,
  TEAM_SECRETS_KEYS_DIR,
  TEAM_SECRETS_VALUES_DIR,
  type AuditDetails,
  type SyncChange,
} from '@wirebench/engine';

export interface SecretEvent {
  readonly action: 'secret.shared' | 'secret.rotated' | 'secret.access_changed';
  readonly details: AuditDetails;
}

const VALUES = `${TEAM_SECRETS_VALUES_DIR}/`;
const ACCESS = `${TEAM_SECRETS_ACCESS_DIR}/`;
const KEYS = `${TEAM_SECRETS_KEYS_DIR}/`;
const MAX_IDS = 64;
const idOf = (path: string): string => (path.split('/').at(-1) ?? path).replace(/\.ya?ml$/i, '');

/** Whether a value path is about to be counted; the caller asks the store only for these. */
export const isValuePath = (path: string): boolean => path.toLowerCase().startsWith(VALUES);

/** `existed(lowerCasedPath)` answers whether the file was at the push's parent. */
export function secretEvents(changes: readonly SyncChange[], existed: (path: string) => boolean): SecretEvent[] {
  const values = new Map<string, { id: string; deleted: boolean }>();
  const access = new Set<string>();
  const keys = new Set<string>();
  for (const change of changes) {
    const path = change.path.toLowerCase();
    if (path.startsWith(VALUES)) {
      const first = values.get(path);
      values.set(path, { id: first?.id ?? idOf(change.path), deleted: change.content === null });
    } else if (path.startsWith(ACCESS)) access.add(path);
    else if (path.startsWith(KEYS)) keys.add(path);
  }
  const shared: string[] = [];
  const rotated: string[] = [];
  for (const [path, value] of values) (!value.deleted && !existed(path) ? shared : rotated).push(value.id);
  const events: SecretEvent[] = [];
  if (shared.length > 0)
    events.push({ action: 'secret.shared', details: { count: shared.length, ids: shared.slice(0, MAX_IDS) } });
  if (rotated.length > 0)
    events.push({ action: 'secret.rotated', details: { count: rotated.length, ids: rotated.slice(0, MAX_IDS) } });
  if (access.size + keys.size > 0) {
    events.push({ action: 'secret.access_changed', details: { entries: access.size, keyRequests: keys.size } });
  }
  return events;
}
