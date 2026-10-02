import { describe, expect, it } from 'vitest';
import { secretEvents } from '../../../src/audit-log/secrets.js';

const change = (path: string, content: string | null = 'x') => ({ path, encoding: 'utf8' as const, content });

describe('secret.* events from a push (audit-log plan ruling 6)', () => {
  it('a new value is shared, an existing one rotated, access and keys are access_changed, other paths are nothing', () => {
    const events = secretEvents(
      [
        change('team-secrets/values/01J9V0000000000000000000A1.yaml'),
        change('team-secrets/values/01J9V0000000000000000000B2.yaml'),
        change('team-secrets/access/01J9A.yaml'),
        change('team-secrets/keys/K1.yaml'),
        change('projects/p/requests/r.yaml'),
      ],
      (path) => path.endsWith('b2.yaml'),
    );
    expect(events).toEqual([
      { action: 'secret.shared', details: { count: 1, ids: ['01J9V0000000000000000000A1'] } },
      { action: 'secret.rotated', details: { count: 1, ids: ['01J9V0000000000000000000B2'] } },
      { action: 'secret.access_changed', details: { entries: 1, keyRequests: 1 } },
    ]);
  });

  it('a push with no team-secrets paths yields nothing', () => {
    expect(secretEvents([change('projects/p/x.yaml')], () => false)).toEqual([]);
  });

  it('a deletion (null content) under values counts as rotated: the value is gone and must be set again', () => {
    expect(secretEvents([change('team-secrets/values/OLD.yaml', null)], () => true)).toEqual([
      { action: 'secret.rotated', details: { count: 1, ids: ['OLD'] } },
    ]);
  });

  it('matches without regard to case, and counts a path changed in two commits of one push once', () => {
    const events = secretEvents(
      [
        change('Team-Secrets/Values/N1.yaml'),
        change('team-secrets/values/n1.yaml', 'y'),
        change('TEAM-SECRETS/ACCESS/E.yaml'),
      ],
      () => false,
    );
    expect(events).toEqual([
      { action: 'secret.shared', details: { count: 1, ids: ['N1'] } },
      { action: 'secret.access_changed', details: { entries: 1, keyRequests: 0 } },
    ]);
  });
});
