import {
  devicesResponseSchema,
  identityIdParamsSchema,
  meResponseSchema,
  MIN_PASSWORD_LENGTH,
  passwordChangeRequestSchema,
  type PasswordChangeRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { invalidCredentials, methodDisabled, notFound, passwordTooShort, unauthenticated } from '../errors.js';
import { isTokenExpired, requireUser } from '../guard.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import * as repo from '../repo.js';
import { publicUser } from '../sessions.js';

export const meRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.get(
      '/me',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(meResponseSchema) } } },
      async (request) => {
        const caller = request.caller!;
        const user = await repo.findUserById(env.ctx.db, caller.id);
        if (user === undefined) throw unauthenticated();
        const methods = (await repo.signInMethodsOf(env.ctx.db, [user.id])).get(user.id)!;
        return { user: publicUser(user), methods };
      },
    );

    app.post(
      '/me/password',
      { preHandler: requireUser, schema: { body: jsonSchema(passwordChangeRequestSchema, { io: 'input' }) } },
      async (request, reply) => {
        if (!env.settings.local) throw methodDisabled();
        const caller = request.caller!;
        const body = request.body as PasswordChangeRequest;
        if (body.newPassword.length < MIN_PASSWORD_LENGTH) throw passwordTooShort();
        const credential = await repo.credentialOf(env.ctx.db, caller.id);
        if (credential !== undefined) {
          const current =
            body.currentPassword === undefined
              ? undefined
              : await verifyPassword(body.currentPassword, credential.passwordHash);
          if (current?.ok !== true) throw invalidCredentials();
        }
        const hash = await hashPassword(body.newPassword);
        const now = env.now();
        await env.ctx.db.transaction(async (tx) => {
          await repo.upsertCredential(tx, caller.id, hash, now);
          await repo.revokeTokensOfUser(tx, caller.id, now, caller.tokenId); // every *other* device (§3.1)
        });
        return reply.code(204).send();
      },
    );

    app.get(
      '/me/devices',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(devicesResponseSchema) } } },
      async (request) => {
        const caller = request.caller!;
        const now = env.now();
        return (await repo.tokensOfUser(env.ctx.db, caller.id))
          .filter((token) => !isTokenExpired(token, now, env.settings))
          .map((token) => ({
            id: token.id,
            name: token.deviceName,
            createdAt: token.createdAt,
            lastUsedAt: token.lastUsedAt,
            current: token.id === caller.tokenId,
          }));
      },
    );

    app.delete(
      '/me/devices/:id',
      { preHandler: requireUser, schema: { params: jsonSchema(identityIdParamsSchema, { io: 'input' }) } },
      async (request, reply) => {
        const caller = request.caller!;
        const { id } = request.params as { id: string };
        const owned = (await repo.tokensOfUser(env.ctx.db, caller.id)).some((token) => token.id === id);
        if (!owned) throw notFound('Device');
        await repo.revokeToken(env.ctx.db, id, env.now());
        return reply.code(204).send();
      },
    );
  };
