import type { DefaultRole } from '@wirebench/engine';
import type { OidcProvider } from '../../src/identity/oidc.js';
import { newId } from '../../src/identity/tokens.js';
import { teamsModule } from '../../src/teams/module.js';
import * as teamsRepo from '../../src/teams/repo.js';
import { identityHarness, type IdentityHarness, type SignedInUser } from './identity.js';

/** Identity plus teams-access over a fresh schema, both on the harness clock. */
export function teamsHarness(
  options: { readonly env?: Record<string, string>; readonly provider?: OidcProvider } = {},
): Promise<IdentityHarness> {
  return identityHarness({ ...options, modules: (clock) => [teamsModule({ now: () => clock.now })] });
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** One request under `/api/v1` as `user` (anonymous when `undefined`); the body parsed when present. */
export async function call<T = unknown>(
  h: IdentityHarness,
  user: SignedInUser | undefined,
  method: Method,
  path: string,
  payload?: object,
): Promise<{ readonly status: number; readonly body: T }> {
  const res = await h.app.inject({
    method,
    url: `/api/v1${path}`,
    ...(user !== undefined ? { headers: user.headers } : {}),
    ...(payload !== undefined ? { payload } : {}),
  });
  return { status: res.statusCode, body: (res.body.length > 0 ? res.json() : undefined) as T };
}

/** A team written straight into the tables, for tests that are not about creating teams. */
export async function seedTeam(
  h: IdentityHarness,
  input: {
    readonly name: string;
    readonly admins?: readonly SignedInUser[];
    readonly members?: readonly SignedInUser[];
  },
): Promise<teamsRepo.TeamRow> {
  const team = await teamsRepo.insertTeam(h.db, { id: newId(), name: input.name, at: h.clock.now });
  for (const user of input.admins ?? []) {
    await teamsRepo.insertMember(h.db, { teamId: team.id, userId: user.user.id, role: 'admin', at: h.clock.now });
  }
  for (const user of input.members ?? []) {
    await teamsRepo.insertMember(h.db, { teamId: team.id, userId: user.user.id, role: 'member', at: h.clock.now });
  }
  return team;
}

/** A workspace row without a repository, for tests about roles rather than storage. */
export async function seedWorkspace(
  h: IdentityHarness,
  input: { readonly team: teamsRepo.TeamRow; readonly name: string; readonly defaultRole?: DefaultRole },
): Promise<string> {
  const id = newId();
  await teamsRepo.insertWorkspace(h.db, {
    id,
    name: input.name,
    teamId: input.team.id,
    defaultRole: input.defaultRole ?? 'viewer',
    createdBy: null,
    at: h.clock.now,
  });
  return id;
}
