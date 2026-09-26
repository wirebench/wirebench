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
import { announce } from '../../context.js';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { notFound, selfChange } from '../errors.js';
import { requireServerAdmin } from '../guard.js';
import { createPasswordReset } from '../invitations.js';
import * as repo from '../repo.js';

async function summaries(env: IdentityEnv, users: readonly repo.UserRow[]): Promise<UserSummary[]> {
  const methods = await repo.signInMethodsOf(
    env.ctx.db,
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
      async () => summaries(env, await repo.listUsers(env.ctx.db)),
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
        const user = await repo.findUserById(env.ctx.db, id);
        if (user === undefined) throw notFound('User');
        const now = env.now();
        await env.ctx.db.transaction(async (tx) => {
          if (body.serverAdmin !== undefined) await repo.setServerAdmin(tx, id, body.serverAdmin);
          if (body.disabled === true) {
            await repo.setDisabled(tx, id, now);
            await repo.revokeTokensOfUser(tx, id, now); // disabling revokes every token (§3.1)
          } else if (body.disabled === false) {
            await repo.setDisabled(tx, id, null);
          }
        });
        // Sockets first: a disabled user's sockets close before any access check could look at them.
        if (body.disabled === true) announce(env.ctx.hooks.sessionEnded, { userId: id }, request.log);
        // The server-admin flag is a role change that lives in identity (R4).
        if (body.serverAdmin !== undefined) announce(env.ctx.hooks.accessChanged, { userId: id }, request.log);
        return (await summaries(env, [(await repo.findUserById(env.ctx.db, id))!]))[0];
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
        const user = await repo.findUserById(env.ctx.db, id);
        if (user === undefined) throw notFound('User');
        return reply.code(201).send(await createPasswordReset(env, user, request.caller!.id));
      },
    );
  };
