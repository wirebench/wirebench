import type { DefaultRole } from '@wirebench/engine';
import { newId } from '../../src/identity/tokens.js';
import { syncModule } from '../../src/sync/module.js';
import { teamsModule } from '../../src/teams/module.js';
import * as teamsRepo from '../../src/teams/repo.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from './identity.js';
import { seedTeam } from './teams.js';

/** Identity, teams-access and server-sync over a fresh schema, on the harness clock, with a hermetic ctx.git (R13). */
export function syncHarness(options: { readonly env?: Record<string, string> } = {}): Promise<IdentityHarness> {
  return identityHarness({ ...options, modules: (clock) => [teamsModule({ now: () => clock.now }), syncModule()] });
}

/**
 * A workspace row and its real bare repository, with no commits yet: an empty server workspace (§2).
 * `seedWorkspace` inserts only the row, which is enough for role tests but not for sync (R13).
 */
export async function seedSyncWorkspace(
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
  await h.repos.withLock(id, () => h.repos.create(id));
  return id;
}

export interface SyncFixture {
  readonly h: IdentityHarness;
  /** Team admin, so admin of the workspace. */
  readonly admin: SignedInUser;
  /** A member with an `editor` grant. */
  readonly editor: SignedInUser;
  /** A member at the workspace's default role, `viewer`. */
  readonly viewer: SignedInUser;
  /** On no team: every workspace answers 404. */
  readonly stranger: SignedInUser;
  readonly workspaceId: string;
}

/** The cast every sync integration test starts from, around one empty repository-backed workspace. */
export async function syncFixture(options: { readonly env?: Record<string, string> } = {}): Promise<SyncFixture> {
  const h = await syncHarness(options);
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const stranger = await signedInUser(h, { email: 'stranger@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
  await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  return { h, admin, editor, viewer, stranger, workspaceId };
}
