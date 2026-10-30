import {
  identityIdParamsSchema,
  passwordResetCreatedSchema,
  userPatchRequestSchema,
  usersResponseSchema,
  userSummarySchema,
  type UserPatchRequest,
  type UserSummary,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { announce, auditSource, recordAudit } from '../../context.js';
import { jsonSchema } from '../../schema.js';
import type { TenantQuerier } from '../../tenancy/tenant-db.js';
import { tenantUrl } from '../../tenancy/urls.js';
import type { IdentityEnv } from '../env.js';
import { notFound, selfChange } from '../errors.js';
import { requireServerAdmin } from '../guard.js';
import { createPasswordReset } from '../invitations.js';
import * as repo from '../repo.js';
import { setUserDisabled } from '../user-state.js';

async function summaries(db: TenantQuerier, users: readonly repo.UserRow[]): Promise<UserSummary[]> {
  const methods = await repo.signInMethodsOf(
    db,
    users.map((user) => user.id),
  );
  return users.map((user) => ({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    serverAdmin: user.serverAdmin,
    ...(user.disabledAt !== null ? { disabledAt: user.disabledAt } : {}),
    // Spread into a plain mutable array: repo.SignInMethods.oidc is `readonly`, but the wire
    // schema's inferred UserSummary.oidc is not, so this array is copied rather than aliased.
    methods: { local: methods.get(user.id)!.local, oidc: [...methods.get(user.id)!.oidc] },
  }));
}

export const userRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.get(
      '/users',
      { preHandler: requireServerAdmin, schema: { response: { 200: jsonSchema(usersResponseSchema) } } },
      async (request) =>
        env.ctx.tenancy.db(request.tenant).transaction(async (tx) => summaries(tx, await repo.listUsers(tx))),
    );

    app.patch(
      '/users/:id',
      {
        preHandler: requireServerAdmin,
        schema: {
          params: jsonSchema(identityIdParamsSchema, { io: 'input' }),
          body: jsonSchema(userPatchRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(userSummarySchema) },
        },
      },
      async (request) => {
        const { id } = request.params as { id: string };
        const body = request.body as UserPatchRequest;
        // §3.1: never a way to lock yourself out, whatever the rest of the patch says.
        if (id === request.caller!.id && (body.serverAdmin === false || body.disabled === true)) throw selfChange();
        const db = env.ctx.tenancy.db(request.tenant);
        const user = await repo.findUserById(db, id);
        if (user === undefined) throw notFound('User');
        const source = auditSource(request);
        await db.transaction(async (tx) => {
          // Re-read inside the transaction: a concurrent change since the read above must not skip the seat check or record a non-transition.
          const current = (await repo.findUserById(tx, id)) ?? user;
          const event = (action: 'user.admin_granted' | 'user.admin_revoked') =>
            recordAudit(env.ctx.hooks, tx, { ...source, action, target: { kind: 'user', id } });
          if (body.serverAdmin !== undefined && body.serverAdmin !== current.serverAdmin) {
            await repo.setServerAdmin(tx, id, body.serverAdmin);
            await event(body.serverAdmin ? 'user.admin_granted' : 'user.admin_revoked');
          }
          // The same transition SCIM deprovisioning takes (saml-scim plan ruling 4).
          if (body.disabled !== undefined) await setUserDisabled(env, tx, id, body.disabled, source);
        });
        // Sockets first: a disabled user's sockets close before any access check could look at them.
        if (body.disabled === true)
          announce(env.ctx.hooks.sessionEnded, { tenantId: request.tenant.tenantId, userId: id }, request.log);
        // The server-admin flag is a role change that lives in identity (R4).
        if (body.serverAdmin !== undefined) announce(env.ctx.hooks.accessChanged, { userId: id }, request.log);
        return db.transaction(async (tx) => (await summaries(tx, [(await repo.findUserById(tx, id))!]))[0]);
      },
    );

    app.post(
      '/users/:id/password-reset',
      {
        preHandler: requireServerAdmin,
        schema: {
          params: jsonSchema(identityIdParamsSchema, { io: 'input' }),
          response: { 201: jsonSchema(passwordResetCreatedSchema) },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const user = await repo.findUserById(env.ctx.tenancy.db(request.tenant), id);
        if (user === undefined) throw notFound('User');
        return reply
          .code(201)
          .send(
            await createPasswordReset(
              env,
              request.tenant,
              user,
              request.caller!.id,
              auditSource(request),
              tenantUrl(env.ctx.config, request),
            ),
          );
      },
    );
  };
