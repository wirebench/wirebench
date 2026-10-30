/**
 * `/scim/v2/Users` (saml-scim spec §3.5). Deprovisioning disables and never deletes (decision 6): `DELETE`
 * and `active: false` both go through identity's `setUserDisabled`, the admin route's own path, and the
 * last enabled server admin is never disabled from here.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { announce, recordAudit, runInvitationAccepted, type Querier } from '../../context.js';
import { isUniqueViolation } from '../../db/errors.js';
import * as identityRepo from '../../identity/repo.js';
import { newId } from '../../identity/tokens.js';
import { setUserDisabled } from '../../identity/user-state.js';
import type { SsoEnv } from '../env.js';
import * as repo from '../repo.js';
import { MAX_RESULTS } from './discovery.js';
import { scimError } from './errors.js';
import { parseFilter } from './filter.js';
import { applyUserPatch, PATCH_OP_SCHEMA, type PatchOperation, type UserState } from './patch.js';
import { scimSource } from './plugin.js';
import { assertEmail, LIST_RESPONSE_SCHEMA, stateOf, userInput, userResource } from './resources.js';

const DEFAULT_COUNT = 100;

const uniqueness = () => scimError(409, 'A user with this userName already exists.', 'uniqueness');
const notFound = () => scimError(404, 'No such user.');

/** `startIndex` (1-based) and `count` from the query, clamped as §3.5 says. */
export function pageOf(query: Record<string, unknown>): { readonly startIndex: number; readonly count: number } {
  const int = (value: unknown, fallback: number): number => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw scimError(400, 'startIndex and count must be integers.', 'invalidValue');
    return parsed;
  };
  return {
    startIndex: Math.max(1, int(query['startIndex'], 1)),
    count: Math.min(MAX_RESULTS, Math.max(0, int(query['count'], DEFAULT_COUNT))),
  };
}

function patchOperations(body: unknown): readonly PatchOperation[] {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const schemas = record['schemas'];
  const operations = record['Operations'];
  if (!Array.isArray(schemas) || !schemas.includes(PATCH_OP_SCHEMA) || !Array.isArray(operations))
    throw scimError(400, 'The body must be a PatchOp with Operations.', 'invalidSyntax');
  return operations as PatchOperation[];
}

export const userRoutes =
  (env: SsoEnv) =>
  (scim: FastifyInstance): void => {
    // The SCIM base of the request's tenant (spec §19.5).
    const base = (request: FastifyRequest): string => env.urlsFor(request).scimBaseUrl;
    const db = env.ctx.db;

    /**
     * Moves user `id` to `compute(current)` in one transaction: the profile fields, then `active`. Answers
     * the user as stored, and announces `sessionEnded` after commit when the user was just disabled.
     */
    async function update(request: FastifyRequest, id: string, compute: (state: UserState) => UserState) {
      const source = scimSource(request);
      const now = env.now();
      const result = await db
        .transaction(async (tx: Querier) => {
          const view = await repo.scimUserView(tx, id);
          if (view === undefined) throw notFound();
          const next = compute(stateOf(view));
          const email = assertEmail(next.userName);
          const changed: string[] = [];
          if (email !== view.email) {
            const holder = await identityRepo.findUserByEmail(tx, email.toLowerCase());
            if (holder !== undefined && holder.id !== id) throw uniqueness();
            await repo.setUserEmail(tx, id, email);
            changed.push('userName');
          }
          const displayName = next.displayName.trim() === '' ? view.displayName : next.displayName.trim();
          if (displayName !== view.displayName) {
            await repo.setUserDisplayName(tx, id, displayName);
            changed.push('displayName');
          }
          if (next.externalId !== view.externalId) changed.push('externalId');
          const wasActive = view.disabledAt === null;
          if (changed.length > 0 || next.active !== wasActive) await repo.upsertScimUser(tx, id, next.externalId, now);
          if (changed.length > 0) {
            // Field names only: the values are personal data the audit log does not need (§3.5).
            await recordAudit(env.ctx.hooks, tx, {
              ...source,
              action: 'user.updated',
              target: { kind: 'user', id },
              details: { fields: changed },
            });
          }
          if (!next.active && wasActive && view.serverAdmin && (await repo.otherEnabledServerAdmins(tx, id)) === 0)
            throw scimError(409, 'The last enabled server admin cannot be deactivated.', 'mutability');
          const transitioned = await setUserDisabled(env, tx, id, !next.active, source);
          return { view: (await repo.scimUserView(tx, id))!, disabled: transitioned && !next.active };
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error, 'users_email_lower_key')) throw uniqueness();
          throw error;
        });
      // Sockets first: a disabled user's live connections close before anything reads them again.
      if (result.disabled) announce(env.ctx.hooks.sessionEnded, { userId: id }, request.log);
      return userResource(result.view, base(request));
    }

    scim.get('/Users', async (request) => {
      const query = request.query as Record<string, unknown>;
      const filter = parseFilter(typeof query['filter'] === 'string' ? query['filter'] : undefined, [
        'userName',
        'externalId',
        'emails.value',
      ]);
      const { startIndex, count } = pageOf(query);
      const page = await repo.listScimUserViews(db, filter as repo.ScimUserFilter | undefined, startIndex - 1, count);
      return {
        schemas: [LIST_RESPONSE_SCHEMA],
        totalResults: page.total,
        startIndex,
        itemsPerPage: page.users.length,
        Resources: page.users.map((view) => userResource(view, base(request))),
      };
    });

    scim.get('/Users/:id', async (request) => {
      const view = await repo.scimUserView(db, (request.params as { id: string }).id);
      if (view === undefined) throw notFound();
      return userResource(view, base(request));
    });

    scim.post('/Users', async (request, reply) => {
      const input = userInput(request.body);
      const email = assertEmail(input.userName);
      const source = scimSource(request);
      const now = env.now();
      const view = await db
        .transaction(async (tx: Querier) => {
          if ((await identityRepo.findUserByEmail(tx, email.toLowerCase())) !== undefined) throw uniqueness();
          // An open invitation is the admin's intent for this address: the creation accepts it (§3.5).
          const open = await identityRepo.openInvitationByEmail(tx, email.toLowerCase(), now);
          const invitation =
            open !== undefined && (await identityRepo.acceptInvitation(tx, open.id, now)) ? open : undefined;
          // licensing §3.4: a disabled account takes no seat.
          if (input.active) await env.ctx.license.assertSeatAvailable(tx);
          const created = await identityRepo.insertUser(tx, {
            id: newId(),
            email,
            displayName: input.displayName,
            serverAdmin: invitation?.serverAdmin ?? false,
            at: now,
          });
          if (!input.active) await identityRepo.setDisabled(tx, created.id, now);
          await repo.upsertScimUser(tx, created.id, input.externalId, now);
          await recordAudit(env.ctx.hooks, tx, {
            ...source,
            action: 'user.created',
            target: { kind: 'user', id: created.id },
            details: {
              method: 'scim',
              emailLower: created.emailLower,
              active: input.active,
              ...(invitation !== undefined ? { invitationId: invitation.id } : {}),
            },
          });
          if (invitation !== undefined)
            await runInvitationAccepted(env.ctx.hooks, tx, { invitationId: invitation.id, userId: created.id });
          return (await repo.scimUserView(tx, created.id))!;
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error, 'users_email_lower_key')) throw uniqueness();
          throw error;
        });
      return reply
        .code(201)
        .header('location', `${base(request)}/Users/${view.id}`)
        .send(userResource(view, base(request)));
    });

    scim.put('/Users/:id', async (request) => {
      const input = userInput(request.body);
      return update(request, (request.params as { id: string }).id, () => input);
    });

    scim.patch('/Users/:id', async (request) => {
      const operations = patchOperations(request.body);
      return update(request, (request.params as { id: string }).id, (state) => applyUserPatch(state, operations));
    });

    scim.delete('/Users/:id', async (request, reply) => {
      await update(request, (request.params as { id: string }).id, (state) => ({ ...state, active: false }));
      return reply.code(204).send();
    });
  };
