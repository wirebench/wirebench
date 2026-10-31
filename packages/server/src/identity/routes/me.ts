import {
  devicesResponseSchema,
  identityIdParamsSchema,
  meResponseSchema,
  MIN_PASSWORD_LENGTH,
  passwordChangeRequestSchema,
  type PasswordChangeRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { announce, auditSource, recordAudit } from '../../context.js';
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
        // One unit for the user and their methods.
        return env.ctx.tenancy.db(request.tenant).transaction(async (tx) => {
          const user = await repo.findUserById(tx, caller.id);
          if (user === undefined) throw unauthenticated();
          const methods = (await repo.signInMethodsOf(tx, [user.id])).get(user.id)!;
          return { user: publicUser(user), methods };
        });
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
        const db = env.ctx.tenancy.db(request.tenant);
        const credential = await repo.credentialOf(db, caller.id);
        if (credential !== undefined) {
          const current =
            body.currentPassword === undefined
              ? undefined
              : await verifyPassword(body.currentPassword, credential.passwordHash);
          if (current?.ok !== true) throw invalidCredentials();
        }
        const hash = await hashPassword(body.newPassword);
        const now = env.now();
        await db.transaction(async (tx) => {
          await repo.upsertCredential(tx, caller.id, hash, now);
          await repo.revokeTokensOfUser(tx, caller.id, now, caller.tokenId); // every *other* device (§3.1)
          await recordAudit(env.ctx.hooks, tx, {
            ...auditSource(request),
            action: 'auth.password_changed',
            target: { kind: 'user', id: caller.id },
            details: { via: 'self' },
          });
        });
        // The device that changed the password keeps its sockets, as it keeps its token.
        announce(
          env.ctx.hooks.sessionEnded,
          { tenantId: request.tenant.tenantId, userId: caller.id, exceptTokenId: caller.tokenId },
          request.log,
        );
        return reply.code(204).send();
      },
    );

    app.get(
      '/me/devices',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(devicesResponseSchema) } } },
      async (request) => {
        const caller = request.caller!;
        const now = env.now();
        return (await repo.tokensOfUser(env.ctx.tenancy.db(request.tenant), caller.id))
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
        const db = env.ctx.tenancy.db(request.tenant);
        const owned = (await repo.tokensOfUser(db, caller.id)).some((token) => token.id === id);
        if (!owned) throw notFound('Device');
        await db.transaction(async (tx) => {
          await repo.revokeToken(tx, id, env.now());
          await recordAudit(env.ctx.hooks, tx, {
            ...auditSource(request),
            action: 'auth.signed_out',
            target: { kind: 'user', id: caller.id },
            details: { tokenId: id },
          });
        });
        announce(env.ctx.hooks.sessionEnded, { tenantId: request.tenant.tenantId, tokenId: id }, request.log);
        return reply.code(204).send();
      },
    );
  };
